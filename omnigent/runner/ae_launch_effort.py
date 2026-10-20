"""Record the effort a claude-native session runs at when none was picked.

Reid, 2026-10-20: the composer's Effort menu showed no level and no check on a
web-created Claude session, so he could not tell the effort before changing
it. With no pick the runner passes no ``--effort`` and Claude Code takes
``effortLevel`` from its settings, which only the host can read. At each
launch the runner writes that level to the session label
:data:`EFFORT_DEFAULT_LABEL` (:data:`NO_LEVEL` when no settings file names
one), and the web shows it as the default. A label, not ``reasoning_effort``:
that field is the user's pick, and saving the default there would pin it as
``--effort`` on every relaunch and could overwrite a pick made mid-launch.
"""

from __future__ import annotations

import asyncio
import json
import logging
import urllib.parse
from collections.abc import Mapping, Sequence
from pathlib import Path

import httpx

from omnigent.util.reasoning_effort import CLAUDE_EFFORTS

_logger = logging.getLogger(__name__)

EFFORT_DEFAULT_LABEL = "ae.claude_effort_default"
NO_LEVEL = "none"
# Claude Code's managed policy file on Linux; it outranks every other source.
_MANAGED_SETTINGS = Path("/etc/claude-code/managed-settings.json")


def _settings_level(path: Path) -> str | None:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    effort = parsed.get("effortLevel") if isinstance(parsed, dict) else None
    return effort if isinstance(effort, str) and effort in CLAUDE_EFFORTS else None


def claude_settings_effort(env: Mapping[str, str], cwd: Path) -> str | None:
    """
    Return the ``effortLevel`` Claude Code applies for a launch env and workspace.

    Sources in Claude's precedence: managed policy, the workspace's
    ``.claude/settings.local.json`` and ``.claude/settings.json``, then the user
    settings in ``CLAUDE_CONFIG_DIR`` (else ``$HOME/.claude``), so the
    session's Claude account counts.

    :param env: The Claude pane's launch environment, e.g.
        ``{"HOME": "/home/user", "CLAUDE_CONFIG_DIR": "/home/user/.claude-acct2"}``.
    :param cwd: The pane's working directory, e.g. ``Path("/home/user/repo")``.
    :returns: A Claude effort, e.g. ``"high"``; ``None`` when no file names a
        valid level.
    """
    config_dir = env.get("CLAUDE_CONFIG_DIR")
    user_dir = Path(config_dir) if config_dir else Path(env.get("HOME") or Path.home()) / ".claude"
    for path in (
        _MANAGED_SETTINGS,
        cwd / ".claude" / "settings.local.json",
        cwd / ".claude" / "settings.json",
        user_dir / "settings.json",
    ):
        level = _settings_level(path)
        if level is not None:
            return level
    return None


def _effort_in_args(args: Sequence[str]) -> bool:
    return any(arg == "--effort" or arg.startswith("--effort=") for arg in args)


async def record_launch_effort(
    server_client: httpx.AsyncClient,
    session_id: str,
    *,
    env: Mapping[str, str],
    cwd: Path,
    args: Sequence[str],
) -> None:
    """
    Label the session with the effort Claude Code defaults to; never fails a launch.

    Skipped when the launch passes ``--effort`` (a pick or a pass-through
    argument), since that, not the settings, is what the pane runs at.

    :param server_client: The runner's Omnigent client.
    :param session_id: Session id, e.g. ``"conv_abc123"``.
    :param env: The Claude pane's launch environment.
    :param cwd: The pane's working directory.
    :param args: The pane's launch arguments, e.g. ``["--effort", "low"]``.
    """
    if _effort_in_args(args):
        return
    level = await asyncio.to_thread(claude_settings_effort, env, cwd) or NO_LEVEL
    try:
        resp = await server_client.patch(
            f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
            json={"labels": {EFFORT_DEFAULT_LABEL: level}},
            params={"include_usage": "false"},
            timeout=10.0,
        )
        resp.raise_for_status()
    except Exception:  # noqa: BLE001 - a failed record must not sink the launch
        _logger.warning(
            "claude-native: could not label session %s with default effort %s; "
            "the Effort menu shows no default until the next launch",
            session_id,
            level,
            exc_info=True,
            extra={"session_id": session_id},
        )
