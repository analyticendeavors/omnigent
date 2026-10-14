"""Fast mode for claude-native sessions: the runner side of the web's switch.

Reid asked on 2026-10-14 for Claude Desktop's fast mode switch in the
composer's model menu, per session. Claude Code toggles it in a running TUI
with ``/fast on`` or ``/fast off``: with an explicit argument there is no
confirm dialog, and the command runs even while a turn streams (the running
turn keeps its speed). Bare ``/fast`` opens a picker, so it is never sent.
Claude Code reruns the statusLine whenever fast mode changes, and its stdin
carries a top-level ``fast_mode`` boolean that the forwarder keeps in
``context.json`` (``omnigent/harnesses/claude_native/status.py``).

Two control events reach :func:`handle_fast_mode_event` from the runner's
``POST /v1/sessions/{id}/events`` dispatch:

``{"type": "fast_mode_status"}``
    ``200 {"enabled": bool | null}`` read from the snapshot; ``null`` means
    no statusLine render has reported fast mode yet. Never touches the pane.
``{"type": "fast_mode_change", "enabled": bool}``
    Types ``/fast on`` or ``/fast off`` and answers ``200 {"enabled": bool}``
    only once the snapshot shows the new state.

Failures answer non-2xx with ``{"error": <code>, "detail": <sentence>}``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi.responses import JSONResponse, Response

if TYPE_CHECKING:
    import httpx

_logger = logging.getLogger(__name__)

CHANGE_EVENT = "fast_mode_change"

# The statusLine snapshot the forwarder writes (status.py's ``_CONTEXT_FILE``).
_CONTEXT_FILE = "context.json"
_CLAUDE_NATIVE = "claude-native"

# The statusLine reruns within about 300 ms of a change and the forwarder
# normalizes it every 250 ms; the budget also covers PreModelSwitch hooks.
FAST_MODE_CONFIRM_TIMEOUT_S = 10.0
FAST_MODE_CONFIRM_POLL_S = 0.25

PreparePane = Callable[[str, Path], Awaitable[None]]


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


def _error(status_code: int, code: str, detail: str) -> JSONResponse:
    """Build the runner's error body, the shape the server relays."""
    return JSONResponse(status_code=status_code, content={"error": code, "detail": detail})


async def handle_fast_mode_event(
    conversation_id: str,
    body: object,
    *,
    harness: str | None,
    server_client: httpx.AsyncClient,
    prepare_pane: PreparePane,
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
    :param prepare_pane: The runner's heal step for a dead Claude pane, run
        before typing (the same one the model change uses).
    :returns: ``200`` with ``{"enabled": ...}``, or an error response.
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
            return JSONResponse({"enabled": None})
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
        return JSONResponse({"enabled": current})
    assert isinstance(enabled, bool)
    return await _change_fast_mode(conversation_id, bridge_dir, enabled, prepare_pane)


async def _change_fast_mode(
    conversation_id: str,
    bridge_dir: Path,
    enabled: bool,
    prepare_pane: PreparePane,
) -> Response:
    """Type ``/fast on|off`` and wait for the snapshot to report it."""
    from omnigent.harnesses.claude_native.bridge import (
        ClaudeUserPromptPending,
        inject_slash_command,
    )
    from omnigent.process_logging import process_log_reference

    state = "on" if enabled else "off"
    await prepare_pane(conversation_id, bridge_dir)
    if not bridge_dir.is_dir():
        return _error(
            503,
            "claude_native_bridge_missing",
            "This session has no Claude Code terminal right now. Send a message to "
            "start it, then switch fast mode.",
        )
    if await asyncio.to_thread(read_claude_fast_mode, bridge_dir) is enabled:
        # Already there: typing the command again would only add a transcript line.
        return JSONResponse({"enabled": enabled})
    command = f"/fast {state}"
    try:
        # No auto_confirm: an explicit on or off opens no dialog (2.1.299 checked).
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
    deadline = time.monotonic() + FAST_MODE_CONFIRM_TIMEOUT_S
    while True:
        if await asyncio.to_thread(read_claude_fast_mode, bridge_dir) is enabled:
            return JSONResponse({"enabled": enabled})
        if time.monotonic() >= deadline:
            break
        await asyncio.sleep(FAST_MODE_CONFIRM_POLL_S)
    _logger.warning(
        "claude-native fast mode %s for session=%s was not confirmed by the statusLine",
        state,
        conversation_id,
        extra={"session_id": conversation_id},
    )
    return _error(
        503,
        "claude_native_fast_mode_unconfirmed",
        f"Claude Code did not confirm the change within {FAST_MODE_CONFIRM_TIMEOUT_S:.0f}s; "
        "run /fast in the terminal to see why.",
    )
