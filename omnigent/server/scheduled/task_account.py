"""The Claude account a scheduled task's run sessions are pinned to.

Without a pin every fired session signs in with the host-wide active Claude
account, so a task that needs one account (it owns a claude.ai artifact the run
publishes to) breaks the day the host switches to a backup. A task may name an
account; the fire path stamps it on the new session as the label the runner
reads at Claude launch, the same label a fork's account pick sets.

- **The setting.** ``claude_account`` is stored beside ``scheduled_tasks`` in
  its own table rather than as a column, so carrying it needs no Alembic
  revision: the table is created on first use. No row means no pin, and the
  fire path then behaves exactly as before. The empty string is a real pin: it
  names the default CLI login ("AE Default").
- **The fire.** :func:`pin_fired_session` stamps the label. A pinned account
  the host lacks fails the run at launch with "The selected Claude account is
  unavailable on this host."; it never falls back to another account.
- **The check.** :func:`validate_account` rejects an account name the task's
  host (when pinned to one and connected) does not report, and one the server
  does not hold as a shared account. A host that is offline or not pinned
  skips the check; the fire-time failure covers it.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import replace
from typing import TYPE_CHECKING, Any

from sqlalchemy import Column, Integer, MetaData, String, Table, delete, select
from sqlalchemy.engine import Engine

from omnigent.db.db_models import current_workspace_id
from omnigent.db.query_context import query_name_scope
from omnigent.entities.scheduled_task import ScheduledTask
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.onboarding.ae_shared_claude_accounts import known_on_server
from omnigent.onboarding.claude_accounts import CLAUDE_ACCOUNT_LABEL_KEY

if TYPE_CHECKING:
    from fastapi import Request

    from omnigent.server.scheduled.fire import FireDeps

_logger = logging.getLogger(__name__)

#: ``shared:`` plus a 64-character name is 71; leave room.
MAX_ACCOUNT_LENGTH = 80

_metadata = MetaData()
_account_table = Table(
    "ae_scheduled_task_account",
    _metadata,
    Column("workspace_id", Integer, primary_key=True),
    Column("scheduled_task_id", String(32), primary_key=True),
    Column("claude_account", String(MAX_ACCOUNT_LENGTH), nullable=False),
)
# custom-lint: disable-next=workspace-scoped-cache -- schema readiness is shared per engine
_ready_engines: set[int] = set()
_ready_lock = threading.Lock()
# Stores without a database (test fakes) keep the setting in memory, keyed by
# store identity, workspace and task.
# custom-lint: disable-next=workspace-scoped-cache -- each key includes the workspace id
_memory: dict[tuple[int, int, str], str] = {}

_ACCOUNT_FAMILIES = frozenset({"claude-oauth", "claude-oauth-active"})


def _engine_for(store: Any) -> Engine | None:
    """The store's database engine with the account table created, or ``None``."""
    location = getattr(store, "storage_location", None)
    if not isinstance(location, str) or "://" not in location:
        return None
    from omnigent.db.utils import get_or_create_engine

    engine = get_or_create_engine(location)
    with _ready_lock:
        if id(engine) not in _ready_engines:
            with query_name_scope("omnigent.scheduled_task_account.create_table"):
                _metadata.create_all(engine, tables=[_account_table], checkfirst=True)
            _ready_engines.add(id(engine))
    return engine


def accounts_for(store: Any, task_ids: list[str]) -> dict[str, str | None]:
    """Each task's pinned account in the current workspace, ``None`` when unpinned."""
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
        stmt = select(_account_table.c.scheduled_task_id, _account_table.c.claude_account).where(
            _account_table.c.workspace_id == workspace,
            _account_table.c.scheduled_task_id.in_(ids),
        )
        with query_name_scope("omnigent.scheduled_task_account.select"), engine.connect() as conn:
            found = {row[0]: row[1] for row in conn.execute(stmt)}
    return {task_id: found.get(task_id) for task_id in ids}


def with_account(store: Any, tasks: list[ScheduledTask]) -> list[ScheduledTask]:
    """*tasks* with ``claude_account`` filled in from the account table."""
    resolved = accounts_for(store, [task.id for task in tasks])
    return [replace(task, claude_account=resolved[task.id]) for task in tasks]


def set_account(store: Any, task_id: str, account: str | None) -> None:
    """Pin *task_id* to *account* in the current workspace; ``None`` clears the pin."""
    workspace = current_workspace_id()
    engine = _engine_for(store)
    if engine is None:
        key = (id(store), workspace, task_id)
        if account is None:
            _memory.pop(key, None)
        else:
            _memory[key] = account
        return
    where = (
        _account_table.c.workspace_id == workspace,
        _account_table.c.scheduled_task_id == task_id,
    )
    with query_name_scope("omnigent.scheduled_task_account.upsert"), engine.begin() as conn:
        conn.execute(delete(_account_table).where(*where))
        if account is not None:
            conn.execute(
                _account_table.insert().values(
                    workspace_id=workspace, scheduled_task_id=task_id, claude_account=account
                )
            )


def forget_account(store: Any, task_id: str) -> None:
    """Drop *task_id*'s pin (the task was deleted)."""
    set_account(store, task_id, None)


async def validate_account(request: Request, account: str, host_id: str | None) -> None:
    """Raise 400 unless *account* is one the task's host or the server holds.

    :param request: The create or update request, for the host registry.
    :param account: Account name from the request; ``""`` is the default login.
    :param host_id: The host the task is pinned to, or ``None`` when unpinned.
    :raises OmnigentError: 400 naming the account when the connected host lacks it.
    """
    if not account or known_on_server(account):
        return
    registry = getattr(request.app.state, "host_registry", None)
    host_conn = registry.get(host_id) if registry is not None and host_id else None
    if host_conn is None:
        return  # Offline or unpinned host: the fire-time launch error covers it.
    from omnigent.server.routes.hosts import _proxy_detect_credentials

    detected = await _proxy_detect_credentials(host_registry=registry, host_conn=host_conn)
    available = {
        item.get("env_var") or ""
        for item in detected.get("credentials", [])
        if item.get("family") in _ACCOUNT_FAMILIES
    }
    if account not in available:
        raise OmnigentError(
            f"Claude account {account!r} is unavailable on the task's host. "
            "Pick an account the host lists, or clear the pin.",
            code=ErrorCode.INVALID_INPUT,
        )


async def pin_fired_session(
    deps: FireDeps, task: ScheduledTask, conversation_id: str
) -> dict[str, str]:
    """Stamp the task's pinned account on a fired session; ``{}`` when unpinned.

    :returns: The labels written, so the caller can mirror them on its copy.
    """
    account = accounts_for(deps.scheduled_task_store, [task.id])[task.id]
    if account is None:
        return {}
    labels = {CLAUDE_ACCOUNT_LABEL_KEY: account}
    await asyncio.to_thread(deps.conversation_store.set_labels, conversation_id, labels)
    return labels


async def validate_agent_supports_account(agent: Any, agent_cache: Any) -> None:
    """Reject a pin on an agent that is not Claude Code native.

    Only the claude-native harness reads the account label at launch; a Claude
    SDK, Codex or other task would run on the host's active account while the
    task claims a pin. When the harness cannot be resolved the check is skipped
    (the same fail-open as the permission-mode gate).

    :raises OmnigentError: 400 when the agent's harness is resolved and is not claude-native.
    """
    if agent is None or agent_cache is None or getattr(agent, "bundle_location", None) is None:
        return
    from omnigent.harness_aliases import canonicalize_harness

    try:
        loaded = await asyncio.to_thread(agent_cache.load, agent.id, agent.bundle_location)
        executor = getattr(loaded.spec, "executor", None)
        raw = (executor.config.get("harness") or executor.type) if executor is not None else None
        harness = canonicalize_harness(raw) or raw
    except Exception:
        _logger.exception("Failed to load agent spec for Claude account gating")
        return
    if harness != "claude-native":
        raise OmnigentError(
            "A Claude account pin needs a Claude Code agent; this task's agent runs on "
            f"{harness or 'another harness'}. Clear the pin or pick a Claude Code agent.",
            code=ErrorCode.INVALID_INPUT,
        )
