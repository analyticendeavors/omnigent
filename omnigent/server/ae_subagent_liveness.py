"""Keep a Claude Code subagent child running until its parent records its return.

The claude-native forwarder reports ``subagent.status`` idle after any short
transcript lull, so a live subagent would flicker between busy and completed.
The parent's completion marker is the reliable end signal; a lull before it is
held, the marker itself publishes the terminal status, and a child that never
gets one (its host restarted) is settled idle once its transcript goes quiet.
The quiet check is armed when the child is first published running and again
by a startup sweep, since a child can die before its first lull and a server
restart drops every pending timer.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from typing import Any

from omnigent.entities import Conversation
from omnigent.server.schemas import BackgroundTaskInfo, ErrorDetail
from omnigent.stores import ConversationStore

_logger = logging.getLogger(__name__)

CLAUDE_SUBAGENT_WRAPPER = "claude-code-native-ui-subagent"
_NATIVE_ID_LABELS = ("omnigent.claude_native.subagent_id", "omnigent.claude_native.tool_use_id")
# A running Claude subagent with no transcript update for this long is presumed
# dead (no completion will ever arrive) and is settled idle.
CLAUDE_SUBAGENT_STALE_AFTER_S = 60 * 60
# Env override for the cap above, in seconds (tests and live checks use a short one).
_STALE_AFTER_ENV = "OMNIGENT_AE_CLAUDE_SUBAGENT_STALE_AFTER_S"
# Upper bound on running or waiting sub-agent rows one startup sweep reads.
_SWEEP_LIMIT = 500

_DISCONNECTED_MESSAGE = (
    "This subagent stopped reporting before it returned; its runner likely restarted."
)

_stale_timers: dict[str, asyncio.TimerHandle] = {}
_stale_checks: set[asyncio.Task[Any]] = set()
# Bumped on every status note and lull for a child, so a settle that awaited in
# between can tell the child moved and must not publish its stale verdict.
_generations: dict[str, int] = {}


def _bump_generation(child_id: str) -> None:
    _generations[child_id] = _generations.get(child_id, 0) + 1


def is_claude_subagent_child(conv: Conversation) -> bool:
    """Return whether ``conv`` mirrors a Claude Code subagent a marker can match."""
    return (
        conv.kind == "sub_agent"
        and conv.labels.get("omnigent.wrapper") == CLAUDE_SUBAGENT_WRAPPER
        and any(conv.labels.get(label) for label in _NATIVE_ID_LABELS)
    )


def stale_after_s() -> float:
    """Return the quiet period after which a running Claude subagent is presumed dead."""
    raw = os.environ.get(_STALE_AFTER_ENV)
    if raw:
        try:
            value = float(raw)
        except ValueError:
            _logger.warning("Ignoring non-numeric %s=%r", _STALE_AFTER_ENV, raw)
        else:
            if math.isfinite(value) and value >= 0:
                return value
            _logger.warning("Ignoring negative or non-finite %s=%r", _STALE_AFTER_ENV, raw)
    return float(CLAUDE_SUBAGENT_STALE_AFTER_S)


async def _last_activity_at(conv: Conversation, store: ConversationStore) -> float:
    """Return when the child's transcript last gained a real item.

    A restarted runner re-sends old items and reports the child running, which
    bumps the row's ``updated_at`` but stores nothing new, so quiet is measured
    from the newest stored item and falls back to ``updated_at`` with none.
    """
    page = await asyncio.to_thread(store.list_items, conv.id, limit=1, order="desc")
    if page.data:
        return float(page.data[0].created_at)
    return float(conv.updated_at)


async def _remaining_quiet_s(
    conv: Conversation, store: ConversationStore, now: float | None = None
) -> float:
    """Return how long the child may stay quiet before it is presumed dead (0 when past)."""
    quiet = (time.time() if now is None else now) - await _last_activity_at(conv, store)
    return max(0.0, stale_after_s() - quiet)


async def _completion_recorded(conv: Conversation, store: ConversationStore) -> bool:
    if conv.parent_conversation_id is None:
        return False
    from omnigent.server.subagent_activity import _recorded_completion_status

    return await _recorded_completion_status(conv.parent_conversation_id, conv, store) is not None


async def hold_premature_lull_idle(
    conv: Conversation,
    store: ConversationStore,
    *,
    response_id: str | None,
    background_task_count: int | None,
    background_tasks: list[BackgroundTaskInfo] | None,
    blocked_on: str | None,
) -> bool:
    """Keep a Claude subagent running through a ``subagent.status`` idle lull.

    The lull's other fields still apply, so a live child republishes its busy
    status with them; a cached ``idle`` or ``failed`` is left as it is.

    :param conv: The child session the idle observation targets.
    :param store: Conversation store holding the parent's completion markers.
    :returns: ``True`` when the idle was held; ``False`` when the caller
        should publish it as before.
    """
    if (
        not is_claude_subagent_child(conv)
        or conv.parent_conversation_id is None
        or await _completion_recorded(conv, store)
    ):
        return False
    from omnigent.server.routes._sessions.common import _session_status_cache
    from omnigent.server.routes._sessions.helpers import _publish_status

    _bump_generation(conv.id)
    cached = _session_status_cache.get(conv.id)
    fields = {
        "response_id": response_id,
        "background_task_count": background_task_count,
        "background_tasks": background_tasks,
        "blocked_on": blocked_on,
    }
    if cached == "waiting":
        _publish_status(conv.id, "waiting", **fields)
    elif cached in (None, "running"):
        _publish_status(conv.id, "running", **fields)
    arm_stale_timer(conv.id, store, await _remaining_quiet_s(conv, store))
    return True


def publish_claude_subagent_end(
    child: Conversation, status: str | None, *, replayed: bool = False
) -> None:
    """Publish a Claude subagent's terminal status once its parent records the return.

    :param child: The returned child session.
    :param status: Recorded completion status, e.g. ``"completed"``,
        ``"failed"`` or ``"cancelled"``.
    :param replayed: The returned edge was already persisted. A replay only
        settles a child with no cached status, so it cannot end a resumed child.
    """
    if status is None or not is_claude_subagent_child(child):
        return
    from omnigent.server.routes._sessions.common import _session_status_cache
    from omnigent.server.routes._sessions.helpers import _publish_status

    if replayed and _session_status_cache.get(child.id) is not None:
        return
    cancel_stale_timer(child.id)
    # A stopped subagent ended on purpose; only a real failure reads failed.
    if status == "failed":
        _publish_status(child.id, "failed", failure_origin="claude_subagent_returned")
    else:
        _publish_status(child.id, "idle")


async def note_claude_subagent_status(
    conv: Conversation, status: str, store: ConversationStore
) -> None:
    """Arm the staleness check when a Claude subagent child is published running.

    A child that dies before its first lull would otherwise have no timer at
    all. An already pending check is left alone; it re-arms itself while the
    transcript keeps moving. The check is armed for the time left since the
    child's last real item, so a restart that only re-sends old items settles
    it at once instead of restarting the full cap. Every note also bumps the
    child's generation, which makes a settle that is mid-await abort.
    """
    if is_claude_subagent_child(conv):
        _bump_generation(conv.id)
    if status == "running" and conv.id not in _stale_timers and is_claude_subagent_child(conv):
        arm_stale_timer(conv.id, store, await _remaining_quiet_s(conv, store))


def arm_stale_timer(child_id: str, store: ConversationStore, delay: float | None = None) -> None:
    """(Re)arm the staleness check for ``child_id`` after ``delay`` seconds."""
    cancel_stale_timer(child_id)
    if delay is None:
        delay = stale_after_s()
    loop = asyncio.get_running_loop()
    _stale_timers[child_id] = loop.call_later(delay, _start_stale_check, child_id, store)


def cancel_stale_timer(child_id: str) -> None:
    """Drop any pending staleness check for ``child_id``."""
    timer = _stale_timers.pop(child_id, None)
    if timer is not None:
        timer.cancel()


def _start_stale_check(child_id: str, store: ConversationStore) -> None:
    _stale_timers.pop(child_id, None)
    task = asyncio.ensure_future(settle_stale_claude_subagent(child_id, store))
    _stale_checks.add(task)
    task.add_done_callback(_stale_checks.discard)


async def settle_stale_claude_subagent(
    child_id: str,
    store: ConversationStore,
    *,
    now: float | None = None,
    conv: Conversation | None = None,
) -> bool:
    """Publish idle for a running Claude subagent quiet past the staleness cap.

    A child whose transcript moved since the timer was armed is re-armed for
    the time remaining. With no cached status (a server restart emptied the
    cache), the row's persisted ``live_status`` is what readers see, so that
    is what is checked.

    :param child_id: Child session to check.
    :param store: Conversation store holding the child and its parent.
    :param now: Current epoch seconds; defaults to the wall clock.
    :param conv: The child row when the caller already read it.
    :returns: Whether the child was settled idle.
    """
    from omnigent.server.routes._sessions.common import (
        _session_blocked_on_cache,
        _session_status_cache,
    )
    from omnigent.server.routes._sessions.helpers import (
        _persist_session_status_error_labels,
        _publish_status,
    )

    labelled = False
    try:
        cached = _session_status_cache.get(child_id)
        generation = _generations.get(child_id, 0)

        def moved() -> bool:
            # A running edge or lull (generation), a status change, or a new
            # user prompt since the first read means this verdict is stale.
            return (
                _generations.get(child_id, 0) != generation
                or _session_status_cache.get(child_id) != cached
                or _session_blocked_on_cache.get(child_id) is not None
            )

        if cached not in (None, "running", "waiting") or moved():
            return False
        if conv is None:
            conv = await asyncio.to_thread(store.get_conversation, child_id)
            if moved():
                return False
        if (
            conv is None
            or conv.id != child_id
            or (cached is None and conv.live_status not in ("running", "waiting"))
            or not is_claude_subagent_child(conv)
        ):
            return False
        recorded = await _completion_recorded(conv, store)
        if recorded or moved():
            return False
        remaining = await _remaining_quiet_s(conv, store, now)
        if moved():
            return False
        if remaining > 0:
            arm_stale_timer(child_id, store, remaining)
            return False
        # Label it disconnected so the rail shows grey "Disconnected", not "Done"; a
        # real resume's running edge clears the labels.
        labelled = True
        await _persist_session_status_error_labels(
            child_id,
            ErrorDetail(code="runner_disconnected", message=_DISCONNECTED_MESSAGE),
            store,
            owner_runner_id=conv.runner_id,
        )
        if moved():
            await _persist_session_status_error_labels(child_id, None, store)
            return False
        labelled = False
        _publish_status(child_id, "idle")
        return True
    except Exception:  # noqa: BLE001 — a best-effort sweep must not crash the loop
        _logger.warning("Could not settle stale Claude subagent %s", child_id, exc_info=True)
        if labelled:
            try:
                await _persist_session_status_error_labels(child_id, None, store)
            except Exception:  # noqa: BLE001
                _logger.warning("Could not clear disconnected labels for %s", child_id)
        return False


def _running_sub_agent_ids(store: ConversationStore) -> list[str]:
    """Return the ids of sub-agent rows whose persisted status reads running or waiting."""
    from sqlalchemy import select

    from omnigent.db.db_models import SqlConversationMetadata, current_workspace_id
    from omnigent.db.enum_codecs import encode_conversation_kind, encode_session_live_status

    session_maker = getattr(store, "_session", None)
    if session_maker is None:
        _logger.warning(
            "Stale Claude subagent sweep skipped: the conversation store has no _session"
        )
        return []
    statement = (
        select(SqlConversationMetadata.id)
        .where(
            SqlConversationMetadata.workspace_id == current_workspace_id(),
            SqlConversationMetadata.kind == encode_conversation_kind("sub_agent"),
            SqlConversationMetadata.live_status.in_(
                [encode_session_live_status("running"), encode_session_live_status("waiting")]
            ),
        )
        .limit(_SWEEP_LIMIT)
    )
    with session_maker("ae_claude_subagent_startup_sweep") as session:
        ids = [str(row[0]) for row in session.execute(statement).all()]
    if len(ids) >= _SWEEP_LIMIT:
        _logger.warning(
            "Stale Claude subagent sweep read only the first %d running or waiting sub-agent rows",
            _SWEEP_LIMIT,
        )
    return ids


async def sweep_stale_claude_subagents(
    store: ConversationStore, *, now: float | None = None
) -> int:
    """Settle or re-arm every Claude subagent child a restart left running or waiting.

    Children quiet past the cap with no recorded completion are settled idle;
    the rest get a timer for the time remaining. A child the status cache
    already knows has reported since startup (a reconnect restored it), so it
    only gets a timer, which re-reads the row when it fires. Best-effort: a
    failure logs and settles nothing.

    :param store: Conversation store holding the children and their parents.
    :param now: Current epoch seconds; defaults to the wall clock.
    :returns: How many children were settled idle.
    """
    from omnigent.server.routes._sessions.common import _session_status_cache

    try:
        ids = await asyncio.to_thread(_running_sub_agent_ids, store)
        if not ids:
            return 0
        rows = await asyncio.to_thread(store.get_conversations, ids)
        settled = 0
        for conv in rows.values():
            if not is_claude_subagent_child(conv):
                continue
            if _session_status_cache.get(conv.id) is not None:
                if conv.id not in _stale_timers:
                    arm_stale_timer(conv.id, store, await _remaining_quiet_s(conv, store, now))
            elif await settle_stale_claude_subagent(conv.id, store, now=now, conv=conv):
                settled += 1
        if settled:
            _logger.info("Settled %d stale Claude subagent(s) left running", settled)
        return settled
    except Exception:  # noqa: BLE001 (a startup sweep must never block the server)
        _logger.warning("Could not sweep stale Claude subagents", exc_info=True)
        return 0


def start_stale_sweep(store: ConversationStore) -> None:
    """Run :func:`sweep_stale_claude_subagents` in the background."""
    task = asyncio.ensure_future(sweep_stale_claude_subagents(store))
    _stale_checks.add(task)
    task.add_done_callback(_stale_checks.discard)
