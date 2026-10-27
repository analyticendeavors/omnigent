"""The account a Claude terminal launches on is recorded before its first render (omnigent-ae)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from omnigent.harnesses.claude_native.ae_launch_account import (
    ACCOUNT_LIVE_LABEL,
    record_launch_account,
    write_launch_account,
)
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


async def test_the_launch_labels_the_session_with_its_account() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://server"
    ) as client:
        await record_launch_account(client, "conv_abc", {"OMNIGENT_CLAUDE_ACCOUNT": "AE Backup"})
        await record_launch_account(client, "conv_abc", {})  # the default login

    assert ACCOUNT_LIVE_LABEL == "ae.claude_account"
    assert [r.method for r in seen] == ["PATCH", "PATCH"]
    assert seen[0].url.path == "/v1/sessions/conv_abc"
    assert json.loads(seen[0].content) == {"labels": {ACCOUNT_LIVE_LABEL: "AE Backup"}}
    assert json.loads(seen[1].content) == {"labels": {ACCOUNT_LIVE_LABEL: ""}}


async def test_a_failed_label_does_not_fail_the_launch(caplog: pytest.LogCaptureFixture) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://server"
    ) as client:
        await record_launch_account(client, "conv_abc", {"OMNIGENT_CLAUDE_ACCOUNT": "AE Backup"})

    assert "could not label session conv_abc" in caplog.text
