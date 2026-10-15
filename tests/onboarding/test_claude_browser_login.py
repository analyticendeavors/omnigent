"""Browser login keeps credentials on the host and isolates the primary login."""

from __future__ import annotations

import time
from unittest.mock import Mock

import pytest

from omnigent.onboarding import claude_browser_login as login
from omnigent.onboarding.claude_accounts import account_env


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("OMNIGENT_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("OMNIGENT_DISABLE_KEYRING", "1")
    monkeypatch.setattr(login, "_JOBS", {})


def test_only_provider_authorization_url_is_exposed():
    assert login.authorization_url("https://evil.test/oauth/authorize?code=x\n") is None
    assert login.authorization_url("https://claude.com.evil.test/oauth/authorize?code=x\n") is None
    assert login.authorization_url("https://claude.com/oauth/authorize?state=partial") is None
    url = "https://claude.com/cai/oauth/authorize?state=example&code=true"
    assert login.authorization_url(f"\x1b]8;;{url}\x07label\x1b]8;;\x07") == url


def test_start_validation_cancel_and_expiry(monkeypatch):
    monkeypatch.setattr(login.threading, "Thread", Mock())
    with pytest.raises(ValueError):
        login.login_action("claude-login-start", "../primary")
    result = login.login_action("claude-login-start", "Backup")
    assert result["login_status"] == "starting"
    assert "token" not in repr(result)
    with pytest.raises(ValueError, match="already open"):
        login.login_action("claude-login-start", "Backup")
    job = login._JOBS[result["login_id"]]
    job.status = "waiting"
    with pytest.raises(ValueError):
        login.login_action("claude-login-code", job.id, "code\ncommand")
    login.login_action("claude-login-code", job.id, "one-time-code#state")
    assert job.code == "one-time-code#state"
    assert job.status == "exchanging"
    assert "one-time-code" not in repr(job.public())
    assert login.login_action("claude-login-cancel", job.id)["login_status"] == "cancelled"
    assert job.cancel.is_set()
    job.created = time.monotonic() - 700
    with pytest.raises(ValueError, match="expired"):
        login.login_action("claude-login-poll", job.id)


def test_cli_token_saved_but_never_returned(monkeypatch):
    import pexpect

    token = "sk-ant-oat01-" + "x" * 45
    process = Mock()
    process.read_nonblocking.side_effect = [
        "\x1b]8;;https://claude.com/oauth/authorize?state=abc\x07",
        f"\n{token}\r\n",
    ]
    spawn = Mock(return_value=process)
    monkeypatch.setattr(pexpect, "spawn", spawn)
    monkeypatch.setattr(login.shutil, "which", lambda _: "/usr/bin/claude")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "original-token")
    job = login.Login("Backup")
    login._run(job)
    assert job.status == "complete"
    assert account_env()["CLAUDE_CODE_OAUTH_TOKEN"] == token
    assert token not in repr(job.public())
    env = spawn.call_args.kwargs["env"]
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in env
    assert "omnigent-claude-login-" in env["CLAUDE_CONFIG_DIR"]
    process.close.assert_called_once_with(force=True)


def test_cli_failure_does_not_return_terminal_output(monkeypatch):
    import pexpect

    monkeypatch.setattr(login.shutil, "which", lambda _: "/usr/bin/claude")
    monkeypatch.setattr(pexpect, "spawn", Mock(side_effect=RuntimeError("secret-value")))
    job = login.Login("Backup")
    login._run(job)
    assert job.status == "failed"
    assert "secret-value" not in repr(job.public())


def test_login_frame_roundtrip():
    from omnigent.host.frames import (
        HostStoreSecretResultFrame,
        decode_host_frame,
        encode_host_frame,
    )

    frame = HostStoreSecretResultFrame(
        request_id="id",
        status="ok",
        login_id="login",
        login_status="waiting",
        login_url="https://claude.com/oauth/authorize?state=test",
    )
    assert decode_host_frame(encode_host_frame(frame)) == frame


def test_code_submitted_with_enter(monkeypatch):
    import pexpect

    process = Mock()
    process.read_nonblocking.side_effect = pexpect.EOF
    monkeypatch.setattr(pexpect, "spawn", Mock(return_value=process))
    monkeypatch.setattr(login.shutil, "which", lambda _: "/usr/bin/claude")
    job = login.Login("Backup", code="dummy#state")
    login._run(job)
    process.send.assert_called_once_with("dummy#state\r")
    process.sendline.assert_not_called()


def test_cli_oauth_error_is_reported_without_secrets(monkeypatch):
    import pexpect

    process = Mock()
    process.read_nonblocking.return_value = "OAuth error: secret-provider-detail"
    monkeypatch.setattr(pexpect, "spawn", Mock(return_value=process))
    monkeypatch.setattr(login.shutil, "which", lambda _: "/usr/bin/claude")
    job = login.Login("Backup")
    login._run(job)
    assert job.status == "failed"
    assert "rejected" in job.error
    assert "secret-provider-detail" not in repr(job.public())
