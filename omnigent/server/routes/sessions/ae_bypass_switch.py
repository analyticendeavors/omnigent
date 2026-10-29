"""Server half of the bypass-permissions switch: pin the launch args around a relaunch.

Claude's shift+tab cycle only reaches bypass on a pane launched into it, so the
runner restarts the pane with ``--permission-mode`` for any switch into or out
of bypass. The restarted pane rebuilds its args from the session row, so the
server pins the target mode there before it forwards the change, and puts the
old args back when the runner refuses.
"""

from __future__ import annotations

import asyncio

from omnigent.server.routes._sessions.helpers import _pin_claude_permission_launch_args
from omnigent.stores.conversation_store import ConversationStore

BYPASS_MODE = "bypassPermissions"

# A relaunch closes the pane, starts Claude again and waits for its prompt, so
# it outlasts the default forward budget.
RELAUNCH_FORWARD_TIMEOUT_S = 90.0


def server_needs_relaunch(requested: str, current_label: str | None) -> bool:
    """
    Say whether a permission-mode change restarts the Claude pane.

    :param requested: Mode asked for, e.g. ``"plan"``.
    :param current_label: The session's recorded permission-mode label, or
        ``None`` when it has none.
    :returns: ``True`` when the target is bypass or the session is in bypass.
    """
    return requested == BYPASS_MODE or current_label == BYPASS_MODE


async def pin_relaunch_launch_args(
    session_id: str,
    conversation_store: ConversationStore,
    current_args: list[str] | None,
    mode: str,
) -> list[str] | None:
    """
    Write ``--permission-mode <mode>`` to the session's launch args.

    :param session_id: Session id, e.g. ``"conv_abc123"``.
    :param conversation_store: Store holding the session row.
    :param current_args: The row's launch args before the pin, or ``None``.
    :param mode: Mode the restarted pane must launch with, e.g. ``"bypassPermissions"``.
    :returns: The previous args, to hand to :func:`restore_launch_args`.
    """
    await asyncio.to_thread(
        conversation_store.update_conversation,
        session_id,
        terminal_launch_args=_pin_claude_permission_launch_args(current_args, mode),
    )
    return current_args


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
    await asyncio.to_thread(
        conversation_store.update_conversation,
        session_id,
        terminal_launch_args=list(previous) if previous else [],
    )
