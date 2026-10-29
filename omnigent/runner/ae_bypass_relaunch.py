"""Switch a running claude-native session into or out of bypass permissions.

Claude's shift+tab cycle reaches bypass only on a pane launched into it, and a
pane launched into it passes through bypass whenever it cycles and prints
"plan mode won't ask before most edits or commands" in Plan. So the runner never
cycles toward or away from bypass: it restarts the Claude pane in the same
conversation (``--resume``) with ``--permission-mode <target>``, the way an
account switch does. The server has already pinned the target mode in the
session's launch args, which the new pane reads.

Answers to ``{"type": "permission_mode_change"}`` for such a switch:

``200 {"permission_mode": <mode>, "relaunched": <bool>}``
    The pane is in the mode (``relaunched`` false when it already was). The mode
    is the one the new pane renders, which a managed setting can make differ
    from the target; the key is absent when no footer appeared.
``400``
    The session does not run Claude Code.
``409``
    A reply or an approval is in progress, the old terminal would not close, or
    the new one did not start; ``{"error": <code>, "detail": <sentence>}``.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi.responses import JSONResponse, Response

from omnigent.runner.ae_claude_account import (
    NOT_CLAUDE_DETAIL,
    CloseTerminal,
    EnsureTerminal,
    PublishEvent,
    Refusals,
    relaunch_claude_terminal,
)

if TYPE_CHECKING:
    from omnigent.terminals import TerminalRegistry

BYPASS = "bypassPermissions"
# Longest the new pane gets to show its permission-mode footer.
SETTLE_TIMEOUT_S = 15.0

BYPASS_REFUSALS = Refusals(
    busy_code="claude_bypass_busy",
    busy_detail=(
        "Claude is mid-reply or waiting on an approval. Stop it or answer it, "
        "then pick the mode again."
    ),
    not_closed_code="claude_bypass_not_closed",
    not_closed_detail="Claude's old terminal would not close. Try again.",
    not_started_code="claude_bypass_not_started",
    not_started_detail="Claude did not restart. Open the Terminal tab to see why, then try again.",
)


def needs_relaunch(target_mode: str, current_mode: str | None) -> bool:
    """
    Whether a switch to *target_mode* restarts the pane.

    :param target_mode: Mode asked for, e.g. ``"plan"``.
    :param current_mode: Mode the pane renders now, or ``None`` when unknown.
    :returns: ``True`` when the target is bypass, or the pane is in bypass and
        the switch leaves it.
    """
    return target_mode == BYPASS or current_mode == BYPASS


def read_settled_mode_blocking(bridge_dir: Path, timeout_s: float) -> str | None:
    """
    Wait for the Claude pane's prompt and read the permission mode it renders.

    Blocking; call it from a worker thread.

    :param bridge_dir: Bridge directory of the session's Claude pane.
    :param timeout_s: Longest to wait for the pane and its prompt.
    :returns: The rendered mode, e.g. ``"bypassPermissions"``, or ``None`` when
        the pane never showed one.
    """
    from omnigent.harnesses.claude_native.bridge import (
        _read_settled_permission_mode,
        _wait_for_claude_prompt_ready,
        _wait_for_tmux_info,
    )

    try:
        info = _wait_for_tmux_info(bridge_dir, timeout_s=timeout_s)
        socket_path, tmux_target = info["socket_path"], info["tmux_target"]
        _wait_for_claude_prompt_ready(socket_path, tmux_target, timeout_s=timeout_s)
        return _read_settled_permission_mode(socket_path, tmux_target)
    except RuntimeError:
        return None


async def handle_claude_relaunch_switch(
    conversation_id: str,
    *,
    target_mode: str,
    harness: str | None,
    current_mode: Callable[[], Awaitable[str | None]],
    settled_mode: Callable[[], Awaitable[str | None]],
    turn_in_flight: Callable[[], bool],
    terminal_registry: TerminalRegistry | None,
    close_terminal: CloseTerminal,
    ensure_terminal: EnsureTerminal,
    publish_event: PublishEvent,
) -> Response:
    """
    Restart the Claude pane in *target_mode*, unless it is already there.

    :param conversation_id: Session id, e.g. ``"conv_abc123"``.
    :param target_mode: Mode to land in, e.g. ``"bypassPermissions"``.
    :param harness: The session's canonical harness, or ``None`` when not loaded.
    :param current_mode: Reads the mode the pane renders now.
    :param settled_mode: Waits for the new pane's footer and reads its mode.
    :param turn_in_flight: Whether the runner sees an active turn or a running pane.
    :param terminal_registry: The runner's terminal registry.
    :param close_terminal: Closes a terminal resource by session and resource id.
    :param ensure_terminal: Starts the native terminal again.
    :param publish_event: The runner's per-session event emitter.
    :returns: ``200`` with the mode reached, or the relaunch's error response.
    """
    if harness != "claude-native":
        return JSONResponse(
            status_code=400,
            content={"error": "claude_bypass_unsupported", "detail": NOT_CLAUDE_DETAIL},
        )
    if await current_mode() == target_mode:
        return JSONResponse({"permission_mode": target_mode, "relaunched": False})
    response = await relaunch_claude_terminal(
        conversation_id,
        turn_in_flight=turn_in_flight,
        terminal_registry=terminal_registry,
        close_terminal=close_terminal,
        ensure_terminal=ensure_terminal,
        publish_event=publish_event,
        refusals=BYPASS_REFUSALS,
    )
    if not 200 <= response.status_code < 300:
        return response
    mode = await settled_mode()
    content: dict[str, object] = {"relaunched": True}
    if mode is not None:
        content["permission_mode"] = mode
    return JSONResponse(content)
