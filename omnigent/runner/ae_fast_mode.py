"""Fast mode for claude-native sessions: the runner side of the web's switch.

The owner asked on 2026-10-14 for Claude Desktop's fast mode switch in the
composer's model menu, per session. Claude Code toggles it in a running TUI
with ``/fast on`` or ``/fast off``: with an explicit argument there is no
confirm dialog, and a command typed while a reply streams is queued until the
reply ends. Bare ``/fast`` opens a picker, so it is never sent. Claude Code
reruns the statusLine whenever fast mode changes, and its stdin carries a
top-level ``fast_mode`` boolean that the forwarder keeps in ``context.json``
(``omnigent/harnesses/claude_native/status.py``).

Turning fast mode on needs ``"fastModePerSessionOptIn": true`` in the host's
Claude user settings; without it ``/fast on`` would also become the default
of every later session. Turning it off is always allowed.

Two control events reach :func:`handle_fast_mode_event` from the runner's
``POST /v1/sessions/{id}/events`` dispatch:

``{"type": "fast_mode_status"}``
    ``200 {"enabled": bool | null, "per_session": bool}`` read from the
    snapshot and the host's settings; ``enabled`` is ``null`` when no
    statusLine render has reported fast mode yet. Never touches the pane.
``{"type": "fast_mode_change", "enabled": bool}``
    Types ``/fast on`` or ``/fast off`` into a live Claude Code terminal, one
    change per session at a time, even when the snapshot already shows that
    state. ``200 {"enabled": bool}`` once the snapshot reports it, else
    ``202 {"enabled": bool, "pending": true, "reason": str}``: once the
    command is typed, the answer is never a failure.

Refusals before anything is typed answer non-2xx with
``{"error": <code>, "detail": <sentence>}``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import weakref
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi.responses import JSONResponse, Response

from omnigent.harnesses.claude_native.status import _CONTEXT_FILE
from omnigent.harnesses.claude_native.status_file import sessions_dir

if TYPE_CHECKING:
    import httpx

    from omnigent.terminals import TerminalRegistry

_logger = logging.getLogger(__name__)

CHANGE_EVENT = "fast_mode_change"
_CLAUDE_NATIVE = "claude-native"

# The Claude user setting that keeps ``/fast`` out of the saved defaults.
PER_SESSION_KEY = "fastModePerSessionOptIn"
NEEDS_PER_SESSION_DETAIL = (
    f'This host\'s Claude user settings need "{PER_SESSION_KEY}": true first, so /fast on '
    "never becomes the default of every session. See omnigent-ae's deploy/README.md, "
    'section "Fast mode, per session".'
)
NO_TERMINAL_DETAIL = "No Claude Code terminal right now; send the session a message first."

# Why a typed change is still pending, shown under the web's switch.
REASON_AFTER_REPLY = "Applies when the current reply finishes"
REASON_UNCONFIRMED = "Waiting for Claude Code to confirm"

# The statusLine reruns within about 300 ms of a change and the forwarder
# normalizes it every 250 ms; the budget also covers PreModelSwitch hooks.
FAST_MODE_CONFIRM_TIMEOUT_S = 10.0
FAST_MODE_CONFIRM_POLL_S = 0.25

PreparePane = Callable[[str, Path], Awaitable[None]]
TurnInFlight = Callable[[str], bool]

# One change at a time per session; an entry lives while a change holds it.
_change_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()


def read_claude_fast_mode(bridge_dir: Path) -> bool | None:
    """
    Read fast mode from the statusLine snapshot ``context.json``.

    :param bridge_dir: Bridge directory shared with the forwarder, e.g.
        ``/tmp/omnigent-1000/claude-native/<digest>``.
    :returns: ``True`` or ``False`` as Claude Code last reported it, or
        ``None`` when the file is missing, unreadable, or has no boolean
        ``fast_mode`` (no render since the key was recorded).
    """
    try:
        parsed = json.loads((bridge_dir / _CONTEXT_FILE).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    value = parsed.get("fast_mode") if isinstance(parsed, dict) else None
    return value if isinstance(value, bool) else None


def claude_fast_mode_per_session() -> bool:
    """
    Whether this host's Claude user settings keep fast mode per session.

    The settings file sits in Claude Code's config dir, resolved the way
    :func:`omnigent.harnesses.claude_native.status_file.sessions_dir` does
    (``CLAUDE_CONFIG_DIR``, else ``~/.claude``).

    :returns: ``True`` only when ``settings.json`` there holds
        ``"fastModePerSessionOptIn": true``; ``False`` when the file is
        missing, unreadable, or says anything else.
    """
    try:
        parsed = json.loads((sessions_dir().parent / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(parsed, dict) and parsed.get(PER_SESSION_KEY) is True


async def claude_pane_alive(
    terminal_registry: TerminalRegistry | None,
    conversation_id: str,
    bridge_dir: Path,
) -> bool:
    """
    Whether the session has a bridge and a registered, live Claude Code pane.

    The same registry probe the runner's pane heal starts with, made before
    the heal so a flip never starts a terminal.

    :param terminal_registry: The runner's terminal registry, or ``None``
        when it has none (then no Claude pane can exist).
    :param conversation_id: Session id, e.g. ``"conv_abc123"``.
    :param bridge_dir: The session's bridge directory.
    :returns: ``True`` when the bridge directory exists and the pane answers
        its liveness probe.
    """
    from omnigent.harness_aliases import native_terminal_name

    terminal_name = native_terminal_name(_CLAUDE_NATIVE)
    if terminal_registry is None or terminal_name is None or not bridge_dir.is_dir():
        return False
    instance = terminal_registry.get(conversation_id, terminal_name, "main")
    return instance is not None and await instance.is_alive()


def _error(status_code: int, code: str, detail: str) -> JSONResponse:
    """Build the runner's error body, the shape the server relays."""
    return JSONResponse(status_code=status_code, content={"error": code, "detail": detail})


async def handle_fast_mode_event(
    conversation_id: str,
    body: object,
    *,
    harness: str | None,
    server_client: httpx.AsyncClient,
    terminal_registry: TerminalRegistry | None,
    prepare_pane: PreparePane,
    turn_in_flight: TurnInFlight,
) -> Response:
    """
    Answer a ``fast_mode_status`` or ``fast_mode_change`` control event.

    :param conversation_id: Session id, e.g. ``"conv_abc123"``.
    :param body: The decoded ``/events`` body, e.g.
        ``{"type": "fast_mode_change", "enabled": True}``.
    :param harness: The session's canonical harness, e.g. ``"claude-native"``,
        or ``None`` when the runner has not loaded the session.
    :param server_client: Client for the Omnigent server, used to resolve the
        session's bridge id label.
    :param terminal_registry: The runner's terminal registry, probed for a
        live Claude pane before anything is typed.
    :param prepare_pane: The runner's heal step for a dead Claude pane, run
        before typing (the same one the model change uses).
    :param turn_in_flight: Whether the session's native pane reports a turn
        in flight, the signal the model change uses for a queued switch.
    :returns: ``200`` or ``202`` with ``{"enabled": ...}``, or an error response.
    """
    from omnigent.harnesses.claude_native.bridge import bridge_dir_for_bridge_id
    from omnigent.runner.native import _claude_native_bridge_id_for_session

    payload = body if isinstance(body, dict) else {}
    is_change = payload.get("type") == CHANGE_EVENT
    enabled = payload.get("enabled")
    if is_change and not isinstance(enabled, bool):
        return _error(400, "invalid_input", "Body 'enabled' must be a boolean.")
    if harness is None:
        if not is_change:
            per_session = await asyncio.to_thread(claude_fast_mode_per_session)
            return JSONResponse({"enabled": None, "per_session": per_session})
        return _error(
            503,
            "session_not_loaded",
            "The runner has not loaded this session yet. Send a message to start "
            "it, then switch fast mode.",
        )
    if harness != _CLAUDE_NATIVE:
        return _error(
            409,
            "fast_mode_unsupported",
            f"Fast mode is a Claude Code setting; this session runs {harness}.",
        )
    bridge_id = await _claude_native_bridge_id_for_session(
        server_client=server_client,
        session_id=conversation_id,
    )
    bridge_dir = bridge_dir_for_bridge_id(bridge_id)
    if not is_change:
        current = await asyncio.to_thread(read_claude_fast_mode, bridge_dir)
        per_session = await asyncio.to_thread(claude_fast_mode_per_session)
        return JSONResponse({"enabled": current, "per_session": per_session})
    assert isinstance(enabled, bool)
    lock = _change_locks.get(conversation_id)
    if lock is None:
        lock = _change_locks[conversation_id] = asyncio.Lock()
    async with lock:
        return await _change_fast_mode(
            conversation_id,
            bridge_dir,
            enabled,
            terminal_registry=terminal_registry,
            prepare_pane=prepare_pane,
            turn_in_flight=turn_in_flight,
        )


def _pending(enabled: bool, reason: str) -> JSONResponse:
    """Answer a typed change that Claude Code has not confirmed yet."""
    return JSONResponse(
        status_code=202,
        content={"enabled": enabled, "pending": True, "reason": reason},
    )


async def _change_fast_mode(
    conversation_id: str,
    bridge_dir: Path,
    enabled: bool,
    *,
    terminal_registry: TerminalRegistry | None,
    prepare_pane: PreparePane,
    turn_in_flight: TurnInFlight,
) -> Response:
    """Check, type ``/fast on|off``, then confirm it; the caller holds the session's lock."""
    from omnigent.harnesses.claude_native.bridge import (
        ClaudeUserPromptPending,
        inject_slash_command,
    )
    from omnigent.process_logging import process_log_reference

    if enabled and not await asyncio.to_thread(claude_fast_mode_per_session):
        return _error(409, "claude_native_fast_mode_needs_per_session", NEEDS_PER_SESSION_DETAIL)
    if not await claude_pane_alive(terminal_registry, conversation_id, bridge_dir):
        return _error(409, "claude_native_no_terminal", NO_TERMINAL_DETAIL)
    await prepare_pane(conversation_id, bridge_dir)
    state = "on" if enabled else "off"
    command = f"/fast {state}"
    try:
        # No auto_confirm: an explicit on or off opens no dialog (2.1.299 checked).
        # Typed even when the snapshot already shows the state; the command is harmless then.
        await asyncio.to_thread(inject_slash_command, bridge_dir, command=command, timeout_s=1.0)
    except ClaudeUserPromptPending as exc:
        return _error(409, "claude_native_prompt_pending", str(exc))
    except (RuntimeError, ValueError) as exc:
        _logger.warning(
            "claude-native fast mode change failed for session=%s",
            conversation_id,
            exc_info=exc,
            extra={"session_id": conversation_id},
        )
        return _error(
            503,
            "claude_native_fast_mode_failed",
            f"Claude Code did not take {command}; see the runner log for details: "
            f"{process_log_reference('runner')}",
        )
    if turn_in_flight(conversation_id):
        # Claude Code runs the queued command once the reply ends.
        return _pending(enabled, REASON_AFTER_REPLY)
    deadline = time.monotonic() + FAST_MODE_CONFIRM_TIMEOUT_S
    while True:
        if await asyncio.to_thread(read_claude_fast_mode, bridge_dir) is enabled:
            return JSONResponse({"enabled": enabled})
        if time.monotonic() >= deadline:
            break
        await asyncio.sleep(FAST_MODE_CONFIRM_POLL_S)
    _logger.warning(
        "claude-native fast mode %s for session=%s was typed but not confirmed by the statusLine",
        state,
        conversation_id,
        extra={"session_id": conversation_id},
    )
    return _pending(enabled, REASON_UNCONFIRMED)
