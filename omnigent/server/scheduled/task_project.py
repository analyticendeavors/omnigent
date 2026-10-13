"""The project a scheduled task files its run sessions into.

Every firing creates a session, and without a project each one lands unfiled
in the sidebar. A task may name one of its owner's first-class projects; the
fire path files the new session there with the same store call the sidebar's
"Move to project" uses.

- **The setting.** ``project_id`` is stored beside ``scheduled_tasks`` in its
  own table rather than as a column, so carrying it needs no Alembic revision:
  the table is created on first use. ``None`` (or no row) leaves runs unfiled.
- **The default.** ``OMNIGENT_SCHEDULED_TASK_DEFAULT_PROJECT`` names a project;
  a task created without a ``project_id`` gets the owner's project of that
  name, when one exists. The id is stored, so renaming the project later keeps
  the task pointed at it.
- **The fire.** :func:`file_fired_session` files the new session. A project
  that was deleted or is no longer the owner's leaves the run unfiled with a
  warning; it never fails a fire.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from dataclasses import replace
from typing import TYPE_CHECKING, Any

from sqlalchemy import Column, Integer, MetaData, String, Table, delete, select
from sqlalchemy.engine import Engine

from omnigent.db.db_models import current_workspace_id
from omnigent.db.query_context import query_name_scope
from omnigent.entities.scheduled_task import ScheduledTask

if TYPE_CHECKING:
    from omnigent.server.scheduled.fire import FireDeps

_logger = logging.getLogger(__name__)

#: Names the project a new task files its runs into when the create omits one.
DEFAULT_PROJECT_ENV = "OMNIGENT_SCHEDULED_TASK_DEFAULT_PROJECT"

_metadata = MetaData()
_project_table = Table(
    "ae_scheduled_task_project",
    _metadata,
    Column("workspace_id", Integer, primary_key=True),
    Column("scheduled_task_id", String(32), primary_key=True),
    Column("project_id", String(32), nullable=False),
)
# custom-lint: disable-next=workspace-scoped-cache -- schema readiness is shared per engine
_ready_engines: set[int] = set()
_ready_lock = threading.Lock()
# Stores without a database (test fakes) keep the setting in memory, keyed by
# store identity, workspace and task.
# custom-lint: disable-next=workspace-scoped-cache -- each key includes the workspace id
_memory: dict[tuple[int, int, str], str] = {}


def _engine_for(store: Any) -> Engine | None:
    """The store's database engine with the project table created, or ``None``."""
    location = getattr(store, "storage_location", None)
    if not isinstance(location, str) or "://" not in location:
        return None
    from omnigent.db.utils import get_or_create_engine

    engine = get_or_create_engine(location)
    with _ready_lock:
        if id(engine) not in _ready_engines:
            with query_name_scope("omnigent.scheduled_task_project.create_table"):
                _metadata.create_all(engine, tables=[_project_table], checkfirst=True)
            _ready_engines.add(id(engine))
    return engine


def project_ids_for(store: Any, task_ids: list[str]) -> dict[str, str | None]:
    """Each task's ``project_id`` in the current workspace, ``None`` when unset."""
    ids = list(dict.fromkeys(task_ids))
    workspace = current_workspace_id()
    found: dict[str, str] = {}
    engine = _engine_for(store)
    if engine is None:
        for task_id in ids:
            key = (id(store), workspace, task_id)
            if key in _memory:
                found[task_id] = _memory[key]
    elif ids:
        stmt = select(_project_table.c.scheduled_task_id, _project_table.c.project_id).where(
            _project_table.c.workspace_id == workspace,
            _project_table.c.scheduled_task_id.in_(ids),
        )
        with query_name_scope("omnigent.scheduled_task_project.select"), engine.connect() as conn:
            found = {row[0]: row[1] for row in conn.execute(stmt)}
    return {task_id: found.get(task_id) for task_id in ids}


def with_project(store: Any, tasks: list[ScheduledTask]) -> list[ScheduledTask]:
    """*tasks* with ``project_id`` filled in from the project table."""
    resolved = project_ids_for(store, [task.id for task in tasks])
    return [replace(task, project_id=resolved[task.id]) for task in tasks]


def set_project(store: Any, task_id: str, project_id: str | None) -> None:
    """Store *project_id* for *task_id* in the current workspace; ``None`` clears it."""
    workspace = current_workspace_id()
    engine = _engine_for(store)
    if engine is None:
        key = (id(store), workspace, task_id)
        if project_id is None:
            _memory.pop(key, None)
        else:
            _memory[key] = project_id
        return
    where = (
        _project_table.c.workspace_id == workspace,
        _project_table.c.scheduled_task_id == task_id,
    )
    with query_name_scope("omnigent.scheduled_task_project.upsert"), engine.begin() as conn:
        conn.execute(delete(_project_table).where(*where))
        if project_id is not None:
            conn.execute(
                _project_table.insert().values(
                    workspace_id=workspace, scheduled_task_id=task_id, project_id=project_id
                )
            )


def forget_project(store: Any, task_id: str) -> None:
    """Drop *task_id*'s setting (the task was deleted)."""
    set_project(store, task_id, None)


def default_project_id(project_store: Any | None, user_id: str | None) -> str | None:
    """The owner's project named by :data:`DEFAULT_PROJECT_ENV`, or ``None``."""
    name = os.environ.get(DEFAULT_PROJECT_ENV, "").strip()
    if not name or project_store is None:
        return None
    for project in project_store.list(user_id=user_id):
        if project.name.strip().casefold() == name.casefold():
            return str(project.id)
    _logger.warning("default project %r not found for owner %r; runs stay unfiled", name, user_id)
    return None


async def file_fired_session(deps: FireDeps, task: ScheduledTask, conversation_id: str) -> None:
    """File the session a fire created into the task's project; never raises."""
    try:
        project_id = project_ids_for(deps.scheduled_task_store, [task.id])[task.id]
        if project_id is None:
            return
        project_store = getattr(deps, "project_store", None)
        if project_store is None:
            _logger.warning("scheduled fire: no project store; task %s run left unfiled", task.id)
            return
        owned = await asyncio.to_thread(project_store.get, project_id, user_id=task.user_id)
        if owned is None:
            _logger.warning(
                "scheduled fire: project %s for task %s is gone; run left unfiled",
                project_id,
                task.id,
            )
            return
        await asyncio.to_thread(
            deps.conversation_store.set_conversation_project, conversation_id, project_id
        )
    except Exception:
        _logger.exception("scheduled fire: could not file task %s run into its project", task.id)
