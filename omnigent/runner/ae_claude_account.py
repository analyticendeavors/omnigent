"""Switch a claude-native session to another Claude login, in place.

The login is fixed when the terminal launches, so a switch restarts it: the
server stores the new login on the session first, then sends this runner
``{"type": "claude_account_change"}``. The runner closes the Claude pane and
starts it again, and the launch reads the stored login. Claude resumes the same
conversation; every login shares ``~/.claude/projects``, so its next reply
re-reads the transcript (extra tokens on that subscription).

Answers, the way ``ae_fast_mode`` does:

``200 {"relaunched": true}``
    The pane was closed (if there was one) and a new one is running.
``400``
    The session does not run Claude Code.
``409``
    A reply or an approval is in progress, the old terminal would not close, or
    the new one did not start; ``{"error": <code>, "detail": <sentence>}``.
    Nothing is closed in the first case.

While a switch runs the session is marked switching: a turn that arrives waits
(bounded) for the new pane instead of starting on the one being closed, and the
idle reaper leaves the pane alone.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import weakref
from collections.abc import Awaitable, Callable, Mapping
from typing import TYPE_CHECKING, Any

from fastapi.responses import JSONResponse, Response

from omnigent.entities.session_resources import terminal_resource_id

if TYPE_CHECKING:
    from omnigent.terminals import TerminalRegistry

_logger = logging.getLogger(__name__)

CHANGE_EVENT = "claude_account_change"
_CLAUDE_NATIVE = "claude-native"
_TERMINAL_NAME = "claude"

BUSY_DETAIL = "Claude is mid-reply or waiting on an approval. Stop it or answer it, then switch."
NOT_CLAUDE_DETAIL = "Only a Claude Code chat has a Claude login to switch."
NOT_STARTED_DETAIL = (
    "Claude did not start on that login. Pick another login, or check this host's Claude accounts."
)

NOT_CLOSED_DETAIL = "Claude's old terminal would not close. Try the switch again."
# Longest a turn waits for a switch to finish; past it the turn goes ahead.
SWITCH_WAIT_S = 100.0

CloseTerminal = Callable[[str, str], Awaitable[bool]]
EnsureTerminal = Callable[[str, str | None], Awaitable[None]]
PublishEvent = Callable[[str, Mapping[str, object]], None]

# One switch at a time per session; an entry lives while a switch holds it.
_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()
# Sessions whose terminal is being replaced, each with an event set when that ends.
_switching: dict[str, asyncio.Event] = {}


def is_switching(conversation_id: str) -> bool:
    """Whether a switch is replacing this session's terminal right now."""
    return conversation_id in _switching


async def wait_while_switching(conversation_id: str, timeout_s: float = SWITCH_WAIT_S) -> None:
    """
    Hold a turn until the session's switch (if any) has finished, at most *timeout_s*.

    A turn that starts mid-switch then finds the new pane, not the one being closed.
    """
    event = _switching.get(conversation_id)
    if event is not None:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(event.wait(), timeout_s)


def _error(status_code: int, code: str, detail: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": code, "detail": detail})


def session_is_busy(conversation_id: str, *, turn_in_flight: bool) -> bool:
    """
    Whether a reply or an approval is in progress, the reaper's busy signals.

    :param conversation_id: Session id, e.g. ``"conv_abc123"``.
    :param turn_in_flight: The runner's own view: an active turn, or a native pane
        status of running or waiting.
    """
    from omnigent.harnesses.claude_native.bridge import approval_wait_is_fresh

    return turn_in_flight or approval_wait_is_fresh(conversation_id)


async def handle_claude_account_change(
    conversation_id: str,
    *,
    harness: str | None,
    turn_in_flight: Callable[[], bool],
    terminal_registry: TerminalRegistry | None,
    close_terminal: CloseTerminal,
    ensure_terminal: EnsureTerminal,
    publish_event: PublishEvent,
) -> Response:
    """
    Restart the session's Claude terminal so it launches on the stored login.

    :param conversation_id: Session id, e.g. ``"conv_abc123"``.
    :param harness: The session's canonical harness, or ``None`` when not loaded.
    :param turn_in_flight: Whether the runner sees an active turn or a running pane;
        read after the session is marked switching, so no turn slips in unseen.
    :param terminal_registry: The runner's terminal registry.
    :param close_terminal: Closes a terminal resource by session and resource id.
    :param ensure_terminal: Starts the native terminal again (the turn self-heal).
    :param publish_event: The runner's per-session event emitter.
    :returns: ``200 {"relaunched": true}`` or an error response.
    """
    if harness != _CLAUDE_NATIVE:
        return _error(400, "claude_account_unsupported", NOT_CLAUDE_DETAIL)
    lock = _locks.get(conversation_id)
    if lock is None:
        lock = _locks[conversation_id] = asyncio.Lock()
    async with lock:
        done = _switching[conversation_id] = asyncio.Event()
        try:
            return await _replace_terminal(
                conversation_id,
                turn_in_flight=turn_in_flight,
                terminal_registry=terminal_registry,
                close_terminal=close_terminal,
                ensure_terminal=ensure_terminal,
                publish_event=publish_event,
            )
        finally:
            _switching.pop(conversation_id, None)
            done.set()


async def _replace_terminal(
    conversation_id: str,
    *,
    turn_in_flight: Callable[[], bool],
    terminal_registry: TerminalRegistry | None,
    close_terminal: CloseTerminal,
    ensure_terminal: EnsureTerminal,
    publish_event: PublishEvent,
) -> Response:
    """Close the pane seen now and start another; the session is already marked switching."""
    from omnigent.runner.tool_dispatch import _publish_terminal_deleted_event

    def current() -> Any:
        if terminal_registry is None:
            return None
        return terminal_registry.get(conversation_id, _TERMINAL_NAME, "main")

    if session_is_busy(conversation_id, turn_in_flight=turn_in_flight()):
        return _error(409, "claude_account_busy", BUSY_DETAIL)
    pane = current()
    if pane is not None:
        try:
            await close_terminal(conversation_id, terminal_resource_id(_TERMINAL_NAME, "main"))
        finally:
            if current() is not pane:
                _publish_terminal_deleted_event(
                    conversation_id=conversation_id,
                    terminal_name=_TERMINAL_NAME,
                    session_key="main",
                    publish_event=publish_event,
                )
        if current() is pane:
            return _error(409, "claude_account_not_closed", NOT_CLOSED_DETAIL)
    await ensure_terminal(conversation_id, _CLAUDE_NATIVE)
    started = current()
    if started is None or started is pane or not await started.is_alive():
        _logger.warning(
            "claude account switch: no live new terminal after relaunch for session=%s",
            conversation_id,
            extra={"session_id": conversation_id},
        )
        return _error(409, "claude_account_not_started", NOT_STARTED_DETAIL)
    return JSONResponse({"relaunched": True})
