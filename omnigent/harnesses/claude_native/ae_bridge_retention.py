"""Retention for dead-owner claude-native bridge dirs.

A host restart kills every runner at once, and the runner that relaunches a chat can lag
the host's startup orphan sweep by seconds. The sweep used to remove the whole bridge dir,
so the forwarder cursor and the frontier record a cold relaunch keeps the transcript from
were gone before the relaunch looked. This keeps a dead-owner dir for seven days after its
last activity, the same window codex-native uses, and drops only the runtime files a
re-prep would drop anyway.
"""

from __future__ import annotations

import contextlib
import time
from collections.abc import Iterable
from pathlib import Path

from omnigent.native import native_bridge_common

ORPHAN_RETENTION_SECONDS = 7 * 24 * 60 * 60


def retention_expired(bridge_dir: Path) -> bool:
    """
    Return whether a dead-owner claude-native bridge dir has been idle for 7 days.

    Idle means the ``owner.pid`` marker and whichever of the forwarder cursor and the
    frontier record exist are all older than the window. A missing cursor or record does
    not hold the dir, and a stat error keeps it.

    :param bridge_dir: Bridge dir whose owner is already known to be dead.
    :returns: ``True`` when the dir may be removed.
    """
    from omnigent.harnesses.claude_native.ae_resume_keep import FRONTIER_FILE
    from omnigent.harnesses.claude_native.forwarder import _FORWARDER_STATE_FILE

    cutoff = time.time() - ORPHAN_RETENTION_SECONDS
    for name in (native_bridge_common.OWNER_PID_FILENAME, _FORWARDER_STATE_FILE, FRONTIER_FILE):
        try:
            if (bridge_dir / name).stat().st_mtime > cutoff:
                return False
        except FileNotFoundError:
            if name == native_bridge_common.OWNER_PID_FILENAME:
                return False
        except OSError:
            return False
    return True


def drop_runtime_files(bridge_dir: Path, filenames: Iterable[str]) -> None:
    """
    Unlink the per-launch runtime files from a bridge dir the sweep is keeping.

    A pane that outlived the host restart must not read a stale server URL before the
    relaunch re-prepares the dir.

    :param bridge_dir: Kept bridge dir.
    :param filenames: Runtime files to remove, e.g. ``("server.json", "tmux.json")``.
    """
    for name in filenames:
        with contextlib.suppress(OSError):
            (bridge_dir / name).unlink()
