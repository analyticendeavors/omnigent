"""Server half of the Claude permission switch: pin the launch args around a relaunch.

Claude's shift+tab cycle only reaches bypass on a pane launched into it, and a
pane launched into it passes through bypass whenever it cycles, so the runner
restarts the pane with ``--permission-mode`` for a switch into or out of bypass,
and for a pane whose mode it cannot read. The server cannot tell which switch it
is looking at (the stored label can be stale), so every claude-native permission
change goes through here: the target mode is pinned in the session's launch args
before the runner is called, because the restarted pane rebuilds its args from
the session row.

What happens to the pin depends on what the runner did:

* answered 2xx: the pin stays (the caller re-pins with the confirmed mode);
* refused with a non-2xx answer, or never reached: the old args are put back;
* outcome unknown (read timeout, cancellation, any other failure): the runner may
  still be finishing, so keep whichever of the old and pinned args does not ask
  for bypass. Never leave a bypass pin nobody confirmed, and never restore a
  bypass pin when the switch was leaving bypass. The label stays as it is; the
  forwarder's footer observation stamps the mode the pane really reached.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from typing import Any, Literal

import httpx

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.routes._sessions.helpers import (
    _get_runner_client,
    _pin_claude_permission_launch_args,
    _require_permission_mode_forward,
    _RunnerForwardResult,
)
from omnigent.stores.conversation_store import ConversationStore

BYPASS_MODE = "bypassPermissions"

SwitchOutcome = Literal["switched", "restarted", "unconfirmed"]

# A relaunch closes the pane, starts Claude again and reads its mode, which the
# runner bounds at 70 s; this is the server's wait for that answer.
RELAUNCH_FORWARD_TIMEOUT_S = 90.0


def args_request_bypass(args: Sequence[str] | None) -> bool:
    """
    Say whether Claude launch args start the pane in bypass.

    :param args: Launch args, e.g. ``["--permission-mode", "bypassPermissions"]``, or ``None``.
    :returns: ``True`` for the standalone skip flag or a last ``--permission-mode`` of bypass.
    """
    mode: str | None = None
    items = list(args or ())
    for index, arg in enumerate(items):
        if arg == "--dangerously-skip-permissions":
            mode = BYPASS_MODE
        elif arg == "--permission-mode" and index + 1 < len(items):
            mode = items[index + 1]
        elif arg.startswith("--permission-mode="):
            mode = arg.split("=", 1)[1]
    return mode == BYPASS_MODE


def args_to_keep_when_unsure(previous: list[str] | None, pinned: list[str]) -> list[str]:
    """
    Pick the launch args to leave behind when the runner's outcome is unknown.

    :param previous: Args before the pin, or ``None`` for none.
    :param pinned: Args with the target mode pinned.
    :returns: The pinned args unless they ask for bypass; else the previous args
        unless they do; else the pinned args (nothing to choose between).
    """
    if not args_request_bypass(pinned):
        return pinned
    if not args_request_bypass(previous):
        return list(previous or [])
    return pinned


def relaunch_unconfirmed(result: _RunnerForwardResult | None) -> bool:
    """
    Say whether the runner restarted Claude but could not read the mode it landed in.

    :param result: The runner's answer.
    :returns: ``True`` for a 2xx that says ``relaunched`` and names no mode.
    """
    if result is None or not 200 <= result.status_code < 300:
        return False
    try:
        body = json.loads(result.body)
    except (TypeError, ValueError):
        return False
    if not isinstance(body, dict) or body.get("relaunched") is not True:
        return False
    mode = body.get("permission_mode")
    return not (isinstance(mode, str) and mode)


async def _write_args(
    session_id: str, conversation_store: ConversationStore, args: list[str]
) -> None:
    await asyncio.to_thread(
        conversation_store.update_conversation,
        session_id,
        terminal_launch_args=args,
    )


async def pin_relaunch_launch_args(
    session_id: str,
    conversation_store: ConversationStore,
    current_args: list[str] | None,
    mode: str,
) -> tuple[list[str] | None, list[str]]:
    """
    Write ``--permission-mode <mode>`` to the session's launch args.

    A cold launch that starts between this write and the runner's answer also
    starts in *mode*; that window is accepted.

    :param session_id: Session id, e.g. ``"conv_abc123"``.
    :param conversation_store: Store holding the session row.
    :param current_args: The row's launch args before the pin, or ``None``.
    :param mode: Mode the restarted pane must launch with, e.g. ``"bypassPermissions"``.
    :returns: The previous args and the pinned args.
    """
    pinned = _pin_claude_permission_launch_args(current_args, mode)
    await _write_args(session_id, conversation_store, pinned)
    return current_args, pinned


async def restore_launch_args(
    session_id: str,
    conversation_store: ConversationStore,
    previous: list[str] | None,
) -> None:
    """
    Put back the launch args saved by :func:`pin_relaunch_launch_args`.

    ``update_conversation`` reads ``None`` as "leave unchanged", so a session
    that had no args is restored to an empty list, which launches with no flag.

    :param session_id: Session id, e.g. ``"conv_abc123"``.
    :param conversation_store: Store holding the session row.
    :param previous: Args returned by the pin call, or ``None`` for none.
    """
    await _write_args(session_id, conversation_store, list(previous) if previous else [])


async def _forward(
    session_id: str,
    runner_router: Any,
    event: dict[str, Any],
) -> tuple[_RunnerForwardResult | None, bool]:
    """
    Post *event* to the session's runner.

    :returns: The runner's answer (``None`` when none came) and whether the
        runner was reached at all. Not reaching it is certain only for a
        missing client or a connect failure; a read timeout leaves it unknown.
    """
    from omnigent.runtime import get_runner_client

    client = await _get_runner_client(session_id, runner_router)
    if client is None:
        client = get_runner_client()
    if client is None:
        return None, False
    try:
        resp = await client.post(
            f"/v1/sessions/{session_id}/events",
            json=event,
            timeout=RELAUNCH_FORWARD_TIMEOUT_S,
        )
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
        return None, False
    except (httpx.HTTPError, ConnectionError):
        return None, True
    return _RunnerForwardResult(status_code=resp.status_code, body=resp.text), True


def _runner_timed_out(result: _RunnerForwardResult) -> bool:
    # The runner answers 504 when its own deadline ran out mid-restart; a gateway
    # or tunnel in front of it answers 504 when it gave up waiting. Either way the
    # restart may still be going, so no 504 is a refusal.
    return result.status_code == 504


def switch_outcome(result: _RunnerForwardResult | None) -> SwitchOutcome:
    """
    Name what the runner did, for the PATCH response.

    :param result: The runner's 2xx answer.
    :returns: ``"unconfirmed"`` when Claude restarted but its mode was not read,
        ``"restarted"`` when it restarted, else ``"switched"`` (shift+tab, or
        already in the mode).
    """
    if relaunch_unconfirmed(result):
        return "unconfirmed"
    try:
        body = json.loads(result.body) if result is not None else None
    except (TypeError, ValueError):
        body = None
    return "restarted" if isinstance(body, dict) and body.get("relaunched") is True else "switched"


async def switch_claude_permission_mode(
    session_id: str,
    conversation_store: ConversationStore,
    runner_router: Any,
    current_args: list[str] | None,
    mode: str,
) -> _RunnerForwardResult:
    """
    Pin *mode* in the launch args, ask the runner to switch, and settle the args.

    :param session_id: Session id, e.g. ``"conv_abc123"``.
    :param conversation_store: Store holding the session row.
    :param runner_router: Router that resolves the session's runner, or ``None``.
    :param current_args: The row's launch args before the switch.
    :param mode: Requested permission mode, e.g. ``"plan"``.
    :returns: The runner's 2xx answer.
    :raises OmnigentError: When the runner refused or was not reached (the old
        args are back), or when the outcome is unknown (see the module text).
    """
    previous, pinned = await pin_relaunch_launch_args(
        session_id, conversation_store, current_args, mode
    )

    async def keep_safe_args() -> None:
        # Shielded: a cancelled request must still leave the row in a safe state.
        await asyncio.shield(
            _write_args(session_id, conversation_store, args_to_keep_when_unsure(previous, pinned))
        )

    try:
        result, reached = await _forward(
            session_id,
            runner_router,
            {"type": "permission_mode_change", "permission_mode": mode},
        )
    except BaseException:
        await keep_safe_args()
        raise
    if result is not None and _runner_timed_out(result):
        result, reached = None, True
    if result is None and reached:
        await keep_safe_args()
        raise OmnigentError(
            f"Could not confirm the switch to {mode} mode for session {session_id!r}. "
            "Claude may still be restarting; the mode shown will update when it settles.",
            code=ErrorCode.RUNNER_UNAVAILABLE,
        )
    try:
        _require_permission_mode_forward(session_id, mode, result)
    except OmnigentError:
        await asyncio.shield(restore_launch_args(session_id, conversation_store, previous))
        raise
    assert result is not None  # _require_permission_mode_forward raised otherwise
    return result
