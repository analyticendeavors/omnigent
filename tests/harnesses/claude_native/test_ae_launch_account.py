"""The account a Claude terminal launches on is recorded before its first render (omnigent-ae)."""

from __future__ import annotations

from pathlib import Path

from omnigent.harnesses.claude_native.ae_launch_account import write_launch_account
from omnigent.harnesses.claude_native.main import build_native_claude_terminal_env
from omnigent.harnesses.claude_native.status import CLAUDE_ACCOUNT_FILE


def test_default_login_is_recorded_as_empty(tmp_path: Path) -> None:
    write_launch_account(tmp_path, build_native_claude_terminal_env(None, account_name=None))

    assert (tmp_path / CLAUDE_ACCOUNT_FILE).read_text(encoding="utf-8") == ""


def test_backup_account_is_recorded_by_name(tmp_path: Path) -> None:
    write_launch_account(tmp_path, {"OMNIGENT_CLAUDE_ACCOUNT": "shared:AE Backup"})

    assert (tmp_path / CLAUDE_ACCOUNT_FILE).read_text(encoding="utf-8") == "shared:AE Backup"


def test_a_rewrite_replaces_the_file_and_leaves_no_temp_file(tmp_path: Path) -> None:
    (tmp_path / CLAUDE_ACCOUNT_FILE).write_text("old", encoding="utf-8")

    write_launch_account(tmp_path, {"OMNIGENT_CLAUDE_ACCOUNT": "AE Backup"})

    assert (tmp_path / CLAUDE_ACCOUNT_FILE).read_text(encoding="utf-8") == "AE Backup"
    assert [p.name for p in tmp_path.iterdir()] == [CLAUDE_ACCOUNT_FILE]


def test_a_missing_bridge_dir_is_skipped(tmp_path: Path) -> None:
    write_launch_account(tmp_path / "gone", {"OMNIGENT_CLAUDE_ACCOUNT": "AE Backup"})
