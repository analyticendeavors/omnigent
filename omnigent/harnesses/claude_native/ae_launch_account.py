"""
Name a Claude session's account in its bridge dir at launch.

The statusLine shim writes ``claude_account`` on Claude Code's first render, so
until a new session's first reply the box could not say which login it runs on
and the Usage panel showed the default login's numbers for a session on a
backup account. The runner writes the same file once, before the terminal
starts, from the environment it just built for it.
"""

from __future__ import annotations

import contextlib
import logging
import os
from collections.abc import Mapping
from pathlib import Path

from omnigent.harnesses.claude_native.status import CLAUDE_ACCOUNT_FILE

_logger = logging.getLogger(__name__)


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
