"""Run-session retention for scheduled tasks: the setting, the seam, the delete.

Every firing of a scheduled task creates a new session, so a task that fires
on weekdays leaves five sessions a week behind it and nothing removes them.
This module carries the three pieces retention needs; what to delete is left
to whoever registers an observer, so the server keeps every session until a
deployment says which ones it may drop.

- **The setting.** ``keep_runs`` is how many of a task's newest run sessions
  survive a firing (``None`` keeps them all, a task never set keeps
  :data:`~omnigent.entities.scheduled_task.DEFAULT_KEEP_RUNS`). It is stored
  beside ``scheduled_tasks`` in its own table rather than as a column, so
  carrying it needs no Alembic revision: the table is created on first use,
  and a build without this module leaves it unread.
- **The seam.** :func:`notify_fire_observers` runs after a fire has created,
  granted, launched and recorded its session. Observers are awaited in order
  inside the fire's own background task, so the per-task in-flight guard in
  :mod:`omnigent.server.scheduled.fire` also keeps two prunes of one task
  apart. Whatever an observer raises is logged and dropped: retention must
  never fail a fire.
- **The delete.** :func:`delete_session_server_side` is the server-owned part
  of ``DELETE /v1/sessions/{id}`` (``routes/sessions/routes_events.py``) for a
  caller with no request: stop, runner-side cleanup, session files, the row,
  and the per-session caches. It refuses a session with a git worktree, which
  a scheduled run never has, rather than copying the route's worktree path.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from sqlalchemy import Column, Integer, MetaData, String, Table, delete, select
from sqlalchemy.engine import Engine

from omnigent.db.db_models import current_workspace_id
from omnigent.db.query_context import query_name_scope
from omnigent.entities.scheduled_task import DEFAULT_KEEP_RUNS, ScheduledTask

if TYPE_CHECKING:
    from omnigent.server.scheduled.fire import FireDeps

_logger = logging.getLogger(__name__)

#: The largest ``keep_runs`` the API accepts.
MAX_KEEP_RUNS = 1000

_metadata = MetaData()
_retention_table = Table(
    "ae_scheduled_task_retention",
    _metadata,
    Column("workspace_id", Integer, primary_key=True),
    Column("scheduled_task_id", String(32), primary_key=True),
    # NULL means "keep every run session" (retention off for this task).
    Column("keep_runs", Integer, nullable=True),
)
_ready_engines: set[int] = set()
_ready_lock = threading.Lock()
# Stores without a database (test fakes) keep the setting in memory, keyed by
# store identity, workspace and task.
_memory: dict[tuple[int, int, str], int | None] = {}


def _engine_for(store: Any) -> Engine | None:
    """The store's database engine with the retention table created, or ``None``."""
    location = getattr(store, "storage_location", None)
    if not isinstance(location, str) or "://" not in location:
        return None
    from omnigent.db.utils import get_or_create_engine

    engine = get_or_create_engine(location)
    with _ready_lock:
        if id(engine) not in _ready_engines:
            with query_name_scope("omnigent.scheduled_task_retention.create_table"):
                _metadata.create_all(engine, tables=[_retention_table], checkfirst=True)
            _ready_engines.add(id(engine))
    return engine


def keep_runs_for(store: Any, task_ids: Iterable[str]) -> dict[str, int | None]:
    """Each task's ``keep_runs`` in the current workspace, the default when never set.

    :param store: The scheduled-task store the tasks live in.
    :param task_ids: The tasks to resolve.
    :returns: ``{task_id: keep_runs}`` for every id given.
    """
    ids = list(dict.fromkeys(task_ids))
    workspace = current_workspace_id()
    found: dict[str, int | None] = {}
    engine = _engine_for(store)
    if engine is None:
        for task_id in ids:
            key = (id(store), workspace, task_id)
            if key in _memory:
                found[task_id] = _memory[key]
    elif ids:
        stmt = select(_retention_table.c.scheduled_task_id, _retention_table.c.keep_runs).where(
            _retention_table.c.workspace_id == workspace,
            _retention_table.c.scheduled_task_id.in_(ids),
        )
        with (
            query_name_scope("omnigent.scheduled_task_retention.select"),
            engine.connect() as conn,
        ):
            found = {row[0]: row[1] for row in conn.execute(stmt)}
    return {task_id: found.get(task_id, DEFAULT_KEEP_RUNS) for task_id in ids}


def with_keep_runs(store: Any, tasks: list[ScheduledTask]) -> list[ScheduledTask]:
    """*tasks* with ``keep_runs`` filled in from the retention table."""
    resolved = keep_runs_for(store, (task.id for task in tasks))
    return [replace(task, keep_runs=resolved[task.id]) for task in tasks]


def set_keep_runs(store: Any, task_id: str, keep_runs: int | None) -> int | None:
    """Store *keep_runs* for *task_id* in the current workspace and return it.

    :raises ValueError: When *keep_runs* is outside 1 to :data:`MAX_KEEP_RUNS`.
    """
    if keep_runs is not None and not 1 <= keep_runs <= MAX_KEEP_RUNS:
        raise ValueError(f"keep_runs must be 1 to {MAX_KEEP_RUNS} or null; got {keep_runs}")
    workspace = current_workspace_id()
    engine = _engine_for(store)
    if engine is None:
        _memory[(id(store), workspace, task_id)] = keep_runs
        return keep_runs
    key = (
        _retention_table.c.workspace_id == workspace,
        _retention_table.c.scheduled_task_id == task_id,
    )
    with query_name_scope("omnigent.scheduled_task_retention.upsert"), engine.begin() as conn:
        conn.execute(delete(_retention_table).where(*key))
        conn.execute(
            _retention_table.insert().values(
                workspace_id=workspace, scheduled_task_id=task_id, keep_runs=keep_runs
            )
        )
    return keep_runs


def forget_keep_runs(store: Any, task_id: str) -> None:
    """Drop *task_id*'s setting (the task was deleted)."""
    workspace = current_workspace_id()
    engine = _engine_for(store)
    if engine is None:
        _memory.pop((id(store), workspace, task_id), None)
        return
    with query_name_scope("omnigent.scheduled_task_retention.delete"), engine.begin() as conn:
        conn.execute(
            delete(_retention_table).where(
                _retention_table.c.workspace_id == workspace,
                _retention_table.c.scheduled_task_id == task_id,
            )
        )


# ── The seam ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FireEvent:
    """One successful firing, as fire observers see it.

    :param task: The task as it fired, ``keep_runs`` resolved.
    :param conversation_id: The session this firing created.
    :param deps: The fire path's server dependencies (stores and registries).
    """

    task: ScheduledTask
    conversation_id: str
    deps: FireDeps


FireObserver = Callable[[FireEvent], Awaitable[None]]

_observers: list[FireObserver] = []


def register_fire_observer(fn: FireObserver) -> None:
    """Add async *fn* to the observers awaited after every successful fire (idempotent)."""
    if fn not in _observers:
        _observers.append(fn)


def unregister_fire_observer(fn: FireObserver) -> None:
    """Remove *fn*; an unknown callable is ignored."""
    if fn in _observers:
        _observers.remove(fn)


def registered_fire_observers() -> list[FireObserver]:
    """The observers currently registered, in registration order (a copy)."""
    return list(_observers)


async def notify_fire_observers(deps: FireDeps, task: ScheduledTask, conversation_id: str) -> None:
    """Await every observer for a fire that created *conversation_id*; never raises."""
    if not _observers:
        return
    try:
        resolved = await asyncio.to_thread(with_keep_runs, deps.scheduled_task_store, [task])
    except Exception:
        _logger.exception("scheduled fire: could not read keep_runs for task %s", task.id)
        return
    event = FireEvent(task=resolved[0], conversation_id=conversation_id, deps=deps)
    for observer in list(_observers):
        try:
            await observer(event)
        except Exception:
            name = getattr(observer, "__qualname__", None) or repr(observer)
            _logger.exception("fire observer %s failed for task %s", name, task.id)


# ── The delete ───────────────────────────────────────────────────────────


async def delete_session_server_side(deps: FireDeps, session_id: str) -> bool:
    """Delete *session_id* the way ``DELETE /v1/sessions/{id}`` does, minus the request.

    No permission check: the caller owns that decision. A session with a git
    worktree is refused, since cleaning one up needs the route's host round
    trip. Runner-side and file cleanup are best-effort, as in the route.

    :returns: ``True`` when the row was deleted.
    """
    from omnigent.server.routes._sessions.common import (
        _intentional_stop_sessions,
        _interrupt_fenced_sessions,
        _pushed_model_options_cache,
        _session_mcp_startup_cache,
        _session_sandbox_status_cache,
    )
    from omnigent.server.routes._sessions.helpers import (
        _get_runner_client_for_resource_access,
        _prune_session_read_state,
    )
    from omnigent.server.routes._sessions.orchestration import _best_effort_stop

    store = deps.conversation_store
    conv = await asyncio.to_thread(store.get_conversation, session_id)
    if conv is None:
        return False
    if conv.git_branch is not None:
        _logger.info("retention: %s has a git worktree; left for a manual delete", session_id)
        return False
    await _best_effort_stop(session_id, store, deps.runner_router)
    runner_client = None
    with contextlib.suppress(Exception):
        runner_client = await _get_runner_client_for_resource_access(session_id)
    if runner_client is not None:
        try:
            await runner_client.delete(f"/v1/sessions/{session_id}", timeout=60.0)
        except Exception:  # noqa: BLE001 — the runner may be long gone
            _logger.info("retention: runner cleanup failed for %s", session_id, exc_info=True)
    else:
        from omnigent.runtime import get_terminal_registry

        with contextlib.suppress(RuntimeError):
            await get_terminal_registry().cleanup_conversation(session_id)
    if deps.file_store is not None and deps.artifact_store is not None:
        orphaned = await asyncio.to_thread(deps.file_store.delete_all_for_session, session_id)
        for blob_key in orphaned:
            await asyncio.to_thread(deps.artifact_store.delete, blob_key)
    _interrupt_fenced_sessions.discard(session_id)
    _intentional_stop_sessions.pop(session_id, None)
    if not await store.delete_conversation(session_id):
        return False
    _session_sandbox_status_cache.pop(session_id, None)
    _session_mcp_startup_cache.pop(session_id, None)
    _pushed_model_options_cache.pop(session_id, None)
    _prune_session_read_state(session_id)
    if deps.managed_launches is not None:
        deps.managed_launches.finish(session_id)
    if conv.host_id is not None and deps.host_store is not None:
        host = await asyncio.to_thread(deps.host_store.get_host, conv.host_id)
        if host is not None and host.sandbox_provider is not None:
            from omnigent.server.managed_hosts import terminate_managed_host

            await terminate_managed_host(host, deps.host_store, deps.sandbox_config)
    return True


__all__ = [
    "MAX_KEEP_RUNS",
    "FireEvent",
    "FireObserver",
    "delete_session_server_side",
    "forget_keep_runs",
    "keep_runs_for",
    "notify_fire_observers",
    "register_fire_observer",
    "registered_fire_observers",
    "set_keep_runs",
    "unregister_fire_observer",
    "with_keep_runs",
]
