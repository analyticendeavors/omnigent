"""
Name a Claude session's account in its bridge dir at launch.

The statusLine shim writes ``claude_account`` on Claude Code's first render, so
until a new session's first reply the box could not say which login it runs on
and the Usage panel showed the default login's numbers for a session on a
backup account. The runner writes the same file once, before the terminal
starts, from the environment it just built for it.

It also labels the session with the same account, so the box learns the login at
every launch (a relaunch after a deploy can land on another login) instead of
waiting for the host relay's next post.
"""

from __future__ import annotations

import contextlib
import logging
import os
import urllib.parse
from collections.abc import Mapping
from pathlib import Path

import httpx

from omnigent.harnesses.claude_native.status import CLAUDE_ACCOUNT_FILE

_logger = logging.getLogger(__name__)

# The login the session's terminal last launched on; "" is the default login. The
# out-of-tree limits router reads this key by the same string (ACCOUNT_LIVE_LABEL
# in ae_omni_policies.limits); keep the two in step.
ACCOUNT_LIVE_LABEL = "ae.claude_account"


def locked_launch_account(
    server_label: str | None, live_label: str | None, *, provider_auth: bool
) -> str | None:
    """
    The login a terminal launches on: a chat stays on the one it started with.

    The server's label (a fork's pick, or a switch made in place) wins. Without
    one, the live label of the last launch keeps a restart (a deploy, an idle
    close) from moving the chat to the host's new default. A chat with no label
    yet, or one on provider credentials, launches as before.

    :param server_label: ``omnigent.claude_native.account``, or ``None``.
    :param live_label: ``ae.claude_account`` from the last launch, or ``None``.
    :param provider_auth: Whether the launch carries provider credentials.
    :returns: The account name (``""`` is the default login), or ``None`` for the
        host's selected login.
    """
    if server_label is not None or provider_auth:
        return server_label
    return live_label


def write_launch_account(bridge_dir: Path, terminal_env: Mapping[str, str]) -> None:
    """
    Record the account the terminal is about to run on.

    Written to a temp file and renamed, so it never races the shim's own
    rename of the same file. A failed write is logged and skipped: the shim
    writes the file on the first render anyway.

    :param bridge_dir: The session's bridge dir.
    :param terminal_env: The environment the terminal launches with; its
        ``OMNIGENT_CLAUDE_ACCOUNT`` is empty for the default login.
    """
    account = terminal_env.get("OMNIGENT_CLAUDE_ACCOUNT", "")
    target = bridge_dir / CLAUDE_ACCOUNT_FILE
    tmp = target.with_name(f"{CLAUDE_ACCOUNT_FILE}.launch.{os.getpid()}.tmp")
    try:
        tmp.write_text(account, encoding="utf-8")
        os.replace(tmp, target)
    except OSError as exc:
        _logger.warning("could not record the Claude account in %s: %s", bridge_dir, exc)
        with contextlib.suppress(OSError):
            tmp.unlink()


async def record_launch_account(
    server_client: httpx.AsyncClient,
    session_id: str,
    terminal_env: Mapping[str, str],
) -> None:
    """
    Label the session with the login its terminal is launching on; never fails a launch.

    :param server_client: The runner's Omnigent client.
    :param session_id: Session id, e.g. ``"conv_abc123"``.
    :param terminal_env: The environment the terminal launches with.
    """
    account = terminal_env.get("OMNIGENT_CLAUDE_ACCOUNT", "")
    try:
        resp = await server_client.patch(
            f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
            json={"labels": {ACCOUNT_LIVE_LABEL: account}},
            params={"include_usage": "false"},
            timeout=10.0,
        )
        resp.raise_for_status()
    except Exception:  # noqa: BLE001 - a failed label must not sink the launch
        _logger.warning(
            "claude-native: could not label session %s with its account; the Usage "
            "panel falls back to the host relay until it reports",
            session_id,
            exc_info=True,
            extra={"session_id": session_id},
        )
