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


def test_a_chat_keeps_the_login_it_started_with() -> None:
    from omnigent.harnesses.claude_native.ae_launch_account import locked_launch_account

    # The server label (a fork's pick or a switch) wins over the last launch.
    assert locked_launch_account("Backup", "Work", provider_auth=False) == "Backup"
    assert locked_launch_account("", "Work", provider_auth=False) == ""
    # No server label: the last launch's login stands, "" being the default login.
    assert locked_launch_account(None, "Work", provider_auth=False) == "Work"
    assert locked_launch_account(None, "", provider_auth=False) == ""
    # A chat never launched keeps today's behaviour (the host's selected login).
    assert locked_launch_account(None, None, provider_auth=False) is None
    # Provider credentials own authentication, so the live label never applies.
    assert locked_launch_account(None, "", provider_auth=True) is None


async def test_launch_metadata_carries_the_live_label_beside_the_server_label() -> None:
    from omnigent.onboarding.claude_accounts import CLAUDE_ACCOUNT_LABEL_KEY
    from omnigent.runner.native.orchestration import _load_legacy_claude_launch_metadata

    labels = {ACCOUNT_LIVE_LABEL: "Work", CLAUDE_ACCOUNT_LABEL_KEY: "Backup"}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"labels": labels})

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://server"
    ) as client:
        both = await _load_legacy_claude_launch_metadata(client, "conv_abc")
        del labels[CLAUDE_ACCOUNT_LABEL_KEY]
        live_only = await _load_legacy_claude_launch_metadata(client, "conv_abc")

    assert (both.claude_account, both.live_claude_account) == ("Backup", "Work")
    assert (live_only.claude_account, live_only.live_claude_account) == (None, "Work")
