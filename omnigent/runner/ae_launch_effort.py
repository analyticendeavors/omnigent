"""Record the effort a claude-native session runs at when none was picked.

With no pick the runner passes no ``--effort`` and Claude Code takes
``effortLevel`` from its settings, which only the host can read. At each
launch the runner writes those levels to the session label
:data:`EFFORT_DEFAULT_LABEL` as compact JSON, the top-level level under
:data:`ANY_MODEL` and each ``modelSettings[<model id>].effortLevel`` under its
id (``{"*": "medium", "claude-opus-5-5": "high"}``), or :data:`NO_LEVEL` when
no settings file names one; the web shows the entry for the session's model.
A label, not ``reasoning_effort``: that field is the user's pick, and saving
the default there would pin it as ``--effort`` on every relaunch.
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
# The key for the level that applies to any model without its own.
ANY_MODEL = "*"
# The server cuts label values at this length (``LABEL_VALUE_MAX_LEN``).
_LABEL_MAX_LEN = 256
# Claude Code's managed policy file on Linux; it outranks every other source.
_MANAGED_SETTINGS = Path("/etc/claude-code/managed-settings.json")


def _valid(level: object) -> str | None:
    return level if isinstance(level, str) and level in CLAUDE_EFFORTS else None


def _settings_levels(path: Path) -> dict[str, str]:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    levels: dict[str, str] = {}
    top = _valid(parsed.get("effortLevel"))
    if top is not None:
        levels[ANY_MODEL] = top
    per_model = parsed.get("modelSettings")
    if isinstance(per_model, dict):
        for model, settings in per_model.items():
            level = _valid(settings.get("effortLevel")) if isinstance(settings, dict) else None
            if isinstance(model, str) and model and level is not None:
                levels[model] = level
    return levels


def claude_settings_efforts(env: Mapping[str, str], cwd: Path) -> dict[str, str]:
    """
    Return the effort levels Claude Code applies for a launch env and workspace.

    Sources in Claude's precedence: managed policy, the workspace's
    ``.claude/settings.local.json`` and ``.claude/settings.json``, then the user
    settings in ``CLAUDE_CONFIG_DIR`` (else ``$HOME/.claude``), so the
    session's Claude account counts. Each key takes its value from the first
    source that sets it: the top-level ``effortLevel`` under :data:`ANY_MODEL`
    and each ``modelSettings[<model id>].effortLevel`` under that id.

    :param env: The Claude pane's launch environment, e.g.
        ``{"HOME": "/home/user", "CLAUDE_CONFIG_DIR": "/home/user/.claude-acct2"}``.
    :param cwd: The pane's working directory, e.g. ``Path("/home/user/repo")``.
    :returns: Levels by model, e.g. ``{"*": "medium", "claude-opus-5-5": "high"}``;
        empty when no file names a valid level.
    """
    config_dir = env.get("CLAUDE_CONFIG_DIR")
    user_dir = Path(config_dir) if config_dir else Path(env.get("HOME") or Path.home()) / ".claude"
    levels: dict[str, str] = {}
    for path in (
        _MANAGED_SETTINGS,
        cwd / ".claude" / "settings.local.json",
        cwd / ".claude" / "settings.json",
        user_dir / "settings.json",
    ):
        for model, level in _settings_levels(path).items():
            levels.setdefault(model, level)
    return levels


def label_value(levels: Mapping[str, str]) -> str:
    """
    Encode levels for the label, dropping per-model entries until it fits.

    :param levels: Levels by model, e.g. ``{"*": "medium", "claude-opus-5-5": "high"}``.
    :returns: Compact JSON within the server's label length, or :data:`NO_LEVEL`.
    """
    kept = dict(sorted(levels.items(), key=lambda item: (item[0] != ANY_MODEL, item[0])))
    while kept:
        value = json.dumps(kept, sort_keys=True, separators=(",", ":"))
        if len(value) <= _LABEL_MAX_LEN:
            return value
        kept.popitem()
    return NO_LEVEL


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
    levels = await asyncio.to_thread(claude_settings_efforts, env, cwd)
    level = label_value(levels)
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
