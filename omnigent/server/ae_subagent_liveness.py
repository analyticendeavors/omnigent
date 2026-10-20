"""Keep a Claude Code subagent child running until its parent records its return.

The claude-native forwarder reports ``subagent.status`` idle after any short
transcript lull, so a live subagent would flicker between busy and completed.
The parent's completion marker is the reliable end signal; a lull before it is
held, the marker itself publishes the terminal status, and a child that never
gets one (its host restarted) is settled idle once its transcript goes quiet.
"""

from __future__ import annotations

import asyncio
import logging
import time

from omnigent.entities import Conversation
from omnigent.server.schemas import BackgroundTaskInfo
from omnigent.stores import ConversationStore

_logger = logging.getLogger(__name__)

CLAUDE_SUBAGENT_WRAPPER = "claude-code-native-ui-subagent"
_NATIVE_ID_LABELS = ("omnigent.claude_native.subagent_id", "omnigent.claude_native.tool_use_id")
# A running Claude subagent with no transcript update for this long is presumed
# dead (no completion will ever arrive) and is settled idle.
CLAUDE_SUBAGENT_STALE_AFTER_S = 60 * 60

_stale_timers: dict[str, asyncio.TimerHandle] = {}
_stale_checks: set[asyncio.Task[bool]] = set()


def is_claude_subagent_child(conv: Conversation) -> bool:
    """Return whether ``conv`` mirrors a Claude Code subagent a marker can match."""
    return (
        conv.kind == "sub_agent"
        and conv.labels.get("omnigent.wrapper") == CLAUDE_SUBAGENT_WRAPPER
        and any(conv.labels.get(label) for label in _NATIVE_ID_LABELS)
    )


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
    arm_stale_timer(conv.id, store)
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


def arm_stale_timer(
    child_id: str, store: ConversationStore, delay: float = CLAUDE_SUBAGENT_STALE_AFTER_S
) -> None:
    """(Re)arm the staleness check for ``child_id`` after ``delay`` seconds."""
    cancel_stale_timer(child_id)
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
    child_id: str, store: ConversationStore, *, now: float | None = None
) -> bool:
    """Publish idle for a running Claude subagent quiet past the staleness cap.

    A child whose transcript moved since the timer was armed is re-armed for
    the time remaining.

    :param child_id: Child session to check.
    :param store: Conversation store holding the child and its parent.
    :param now: Current epoch seconds; defaults to the wall clock.
    :returns: Whether the child was settled idle.
    """
    from omnigent.server.routes._sessions.common import _session_status_cache
    from omnigent.server.routes._sessions.helpers import _publish_status

    try:
        if _session_status_cache.get(child_id) != "running":
            return False
        conv = await asyncio.to_thread(store.get_conversation, child_id)
        if (
            conv is None
            or not is_claude_subagent_child(conv)
            or await _completion_recorded(conv, store)
        ):
            return False
        quiet = (time.time() if now is None else now) - conv.updated_at
        if quiet < CLAUDE_SUBAGENT_STALE_AFTER_S:
            arm_stale_timer(child_id, store, CLAUDE_SUBAGENT_STALE_AFTER_S - quiet)
            return False
        if _session_status_cache.get(child_id) != "running":
            return False
        _publish_status(child_id, "idle")
        return True
    except Exception:  # noqa: BLE001 — a best-effort sweep must not crash the loop
        _logger.warning("Could not settle stale Claude subagent %s", child_id, exc_info=True)
        return False
