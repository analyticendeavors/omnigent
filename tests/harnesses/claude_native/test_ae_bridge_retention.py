"""A host restart's orphan sweep keeps a claude-native bridge dir for 7 days."""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from omnigent.harnesses.claude_native import ae_bridge_retention as retention
from omnigent.harnesses.claude_native import ae_resume_keep as keep
from omnigent.harnesses.claude_native import bridge, forwarder
from omnigent.native import native_bridge_common
from tests.runner.helpers import NullServerClient

CONV = "conv_x"
DAY = 24 * 60 * 60
RUNTIME_FILES = (
    "server.json",
    "state.json",
    "hooks.jsonl",
    "observer_hook.stderr",
    "tool_relay.json",
    "tool_relay.env",
    "tmux.json",
)


@pytest.fixture(autouse=True)
def _bridge_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "claude-native"
    root.mkdir(mode=0o700)
    monkeypatch.setattr(bridge, "_BRIDGE_ROOT", root)
    monkeypatch.setattr(bridge, "_APPROVAL_WAIT_ROOT", root / "approval-waits")
    return root


def _dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def _prepared(tmp_path: Path, *, with_files: bool = True) -> Path:
    """Prepare the dir for CONV, write the cursor and the record, and orphan it."""
    bridge_dir = bridge.prepare_bridge_dir(CONV, workspace=tmp_path)
    if with_files:
        forwarder._write_forward_state(
            bridge_dir,
            forwarder.TranscriptForwardState(
                transcript_path=tmp_path / "t.jsonl",
                line_cursor=3,
                byte_offset=120,
                cursor_fingerprint="fp",
            ),
        )
        keep.write_frontier(
            bridge_dir, keep.Frontier(tmp_path / "t.jsonl", 120, "fp", 2, "item_2")
        )
    (bridge_dir / native_bridge_common.OWNER_PID_FILENAME).write_text(str(_dead_pid()))
    return bridge_dir


def _age(bridge_dir: Path, days: float, *names: str) -> None:
    when = time.time() - days * DAY
    for name in names or (
        native_bridge_common.OWNER_PID_FILENAME,
        forwarder._FORWARDER_STATE_FILE,
        keep.FRONTIER_FILE,
    ):
        if (bridge_dir / name).exists():
            os.utime(bridge_dir / name, (when, when))


def test_relaunch_after_the_sweep_still_has_the_cursor_and_the_record(tmp_path: Path) -> None:
    bridge_dir = _prepared(tmp_path)

    assert bridge.prune_orphaned_bridge_dirs() == 0
    assert bridge.prepare_bridge_dir(CONV, workspace=tmp_path) == bridge_dir

    ctx = keep.read_context(bridge.bridge_dir_for_conversation_id(CONV))
    assert ctx.cursor is not None
    assert ctx.frontier is not None
    assert ctx.frontier.last_item_id == "item_2"


def test_dir_idle_past_seven_days_is_pruned(tmp_path: Path) -> None:
    bridge_dir = _prepared(tmp_path)
    _age(bridge_dir, 8)

    assert bridge.prune_orphaned_bridge_dirs() == 1
    assert not bridge_dir.exists()


def test_recent_cursor_holds_a_dir_whose_marker_is_old(tmp_path: Path) -> None:
    bridge_dir = _prepared(tmp_path)
    _age(bridge_dir, 8, native_bridge_common.OWNER_PID_FILENAME, keep.FRONTIER_FILE)

    assert bridge.prune_orphaned_bridge_dirs() == 0


def test_recent_record_holds_a_dir_whose_marker_is_old(tmp_path: Path) -> None:
    bridge_dir = _prepared(tmp_path)
    _age(bridge_dir, 8, native_bridge_common.OWNER_PID_FILENAME, forwarder._FORWARDER_STATE_FILE)

    assert bridge.prune_orphaned_bridge_dirs() == 0


@pytest.mark.parametrize("missing", [forwarder._FORWARDER_STATE_FILE, keep.FRONTIER_FILE])
def test_a_missing_cursor_or_record_counts_as_expired(tmp_path: Path, missing: str) -> None:
    bridge_dir = _prepared(tmp_path)
    (bridge_dir / missing).unlink()
    _age(bridge_dir, 8)

    assert retention.retention_expired(bridge_dir) is True
    assert bridge.prune_orphaned_bridge_dirs() == 1


def test_a_recent_marker_alone_holds_a_dir_with_no_cursor_or_record(tmp_path: Path) -> None:
    bridge_dir = _prepared(tmp_path, with_files=False)

    assert bridge.prune_orphaned_bridge_dirs() == 0
    assert bridge_dir.exists()


def _stamp(bridge_dir: Path, mtime: float) -> None:
    for name in (
        native_bridge_common.OWNER_PID_FILENAME,
        forwarder._FORWARDER_STATE_FILE,
        keep.FRONTIER_FILE,
    ):
        os.utime(bridge_dir / name, (mtime, mtime))


def test_exactly_seven_days_old_is_expired_and_a_second_younger_is_not(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = 2_000_000_000.0
    monkeypatch.setattr(retention.time, "time", lambda: now)
    bridge_dir = _prepared(tmp_path)

    _stamp(bridge_dir, now - 7 * DAY)
    assert retention.retention_expired(bridge_dir) is True

    _stamp(bridge_dir, now - 7 * DAY + 1)
    assert retention.retention_expired(bridge_dir) is False


def test_a_future_mtime_keeps_the_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    now = 2_000_000_000.0
    monkeypatch.setattr(retention.time, "time", lambda: now)
    bridge_dir = _prepared(tmp_path)

    _stamp(bridge_dir, now + 3600)

    assert retention.retention_expired(bridge_dir) is False


def test_a_stat_error_keeps_the_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    bridge_dir = _prepared(tmp_path)
    _age(bridge_dir, 8)
    real_stat = Path.stat

    def _stat(self: Path, *args: object, **kwargs: object) -> os.stat_result:
        if self.name == keep.FRONTIER_FILE:
            raise PermissionError(13, "denied")
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", _stat)

    assert retention.retention_expired(bridge_dir) is False


def test_a_dir_with_no_owner_marker_is_untouched(tmp_path: Path) -> None:
    bridge_dir = _prepared(tmp_path)
    (bridge_dir / native_bridge_common.OWNER_PID_FILENAME).unlink()
    _age(bridge_dir, 30)

    assert bridge.prune_orphaned_bridge_dirs() == 0
    assert bridge_dir.exists()


def test_a_live_owner_is_never_pruned_past_the_window(tmp_path: Path) -> None:
    bridge_dir = _prepared(tmp_path)
    (bridge_dir / native_bridge_common.OWNER_PID_FILENAME).write_text(str(os.getpid()))
    _age(bridge_dir, 30)

    assert bridge.prune_orphaned_bridge_dirs() == 0
    assert bridge_dir.exists()


def test_a_reused_pid_reads_alive_so_the_dir_is_kept(tmp_path: Path) -> None:
    """Existing behaviour: a pid another process now holds is indistinguishable from the owner."""
    bridge_dir = _prepared(tmp_path)
    (bridge_dir / native_bridge_common.OWNER_PID_FILENAME).write_text(str(os.getppid()))
    _age(bridge_dir, 30)

    assert bridge.prune_orphaned_bridge_dirs() == 0


def test_the_keep_path_unlinks_exactly_the_runtime_files(tmp_path: Path) -> None:
    bridge_dir = _prepared(tmp_path)
    for name in RUNTIME_FILES:
        (bridge_dir / name).write_text("{}")
    (bridge_dir / "permission_hook.json").write_text("{}")
    before = {p.name for p in bridge_dir.iterdir()}
    assert set(RUNTIME_FILES) == {
        bridge._SERVER_FILE,
        bridge._STATE_FILE,
        bridge._HOOKS_FILE,
        bridge.OBSERVER_HOOK_STDERR_FILE,
        bridge._TOOL_RELAY_FILE,
        bridge._TOOL_RELAY_ENV_FILE,
        bridge._TMUX_FILE,
    }

    assert bridge.prune_orphaned_bridge_dirs() == 0

    assert before - {p.name for p in bridge_dir.iterdir()} == set(RUNTIME_FILES)
    assert {p.name for p in bridge_dir.iterdir()} - before == set()


def test_the_sweep_skips_a_dir_whose_cleanup_lock_is_held(tmp_path: Path) -> None:
    bridge_dir = _prepared(tmp_path)
    _age(bridge_dir, 8)

    with bridge.native_bridge_common.bridge_dir_preparation_lock(bridge_dir):
        assert bridge.prune_orphaned_bridge_dirs() == 0
    assert bridge_dir.exists()
    assert bridge.prune_orphaned_bridge_dirs() == 1


async def test_an_explicit_delete_removes_a_kept_dir_at_once(tmp_path: Path) -> None:
    from omnigent.runner.native.orchestration import _delete_native_bridge_dirs

    bridge_dir = _prepared(tmp_path)
    assert bridge.prune_orphaned_bridge_dirs() == 0

    await _delete_native_bridge_dirs(server_client=NullServerClient(), session_id=CONV)  # type: ignore[arg-type]

    assert not bridge_dir.exists()


def test_the_cold_launch_line_carries_booleans_sizes_and_times_only(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    bridge_dir = _prepared(tmp_path)
    (bridge_dir / keep.FRONTIER_FILE).unlink()

    with caplog.at_level(logging.INFO, logger=keep.__name__):
        keep.read_context(bridge_dir, session_id=CONV)

    lines = [r.getMessage() for r in caplog.records if "cold launch" in r.getMessage()]
    assert len(lines) == 1
    assert lines[0].startswith(f"claude-native: cold launch for {CONV}: cursor=present size=")
    assert "frontier=absent" in lines[0]
    assert str(tmp_path) not in lines[0]
    assert "t.jsonl" not in lines[0]
    assert "fp" not in lines[0].split("cursor=")[1].replace("present", "").replace("mtime", "")
