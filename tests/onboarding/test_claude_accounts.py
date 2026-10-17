from pathlib import Path

import pytest

from omnigent.onboarding.claude_accounts import account_descriptors, account_env, change_account


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("OMNIGENT_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("OMNIGENT_DISABLE_KEYRING", "1")


def test_independent_accounts_and_original_login(tmp_path: Path):
    assert account_env() == {}
    assert change_account("claude-oauth-add", "Work", "sk-ant-oat-test-one").stored
    assert change_account("claude-oauth-add", "Backup", "sk-ant-oat-test-two").stored
    assert account_env()["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat-test-two"
    assert change_account("claude-oauth-select", "Work").stored
    assert account_env()["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat-test-one"
    assert change_account("claude-oauth-select", "").stored
    assert account_env() == {}
    assert "sk-ant-oat" not in (tmp_path / "claude-accounts.json").read_text()
    assert "sk-ant-oat" not in repr(account_descriptors())
    assert len(account_descriptors()) == 3


def test_reject_duplicate_and_invalid_account():
    assert change_account("claude-oauth-add", "Work", "sk-ant-oat-first").stored
    assert not change_account("claude-oauth-add", "Work", "sk-ant-oat-second").stored
    assert not change_account("claude-oauth-add", "../secret", "sk-ant-oat-second").stored
    assert not change_account("claude-oauth-select", "Missing").stored
    assert not change_account("claude-oauth-add", "API", "sk-ant-api-key").stored
    assert account_env()["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat-first"


def test_native_subscription_env_uses_selected_account():
    from omnigent.harnesses.claude_native.main import build_native_claude_terminal_env

    assert change_account("claude-oauth-add", "Backup", "sk-ant-oat-backup").stored
    env = build_native_claude_terminal_env(None)
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat-backup"
    assert env["ANTHROPIC_API_KEY"] == ""


def test_frame_roundtrip_preserves_account_name():
    from omnigent.host.frames import HostStoreSecretFrame, decode_host_frame, encode_host_frame

    frame = HostStoreSecretFrame(
        request_id="request",
        harness="claude-native",
        kind="claude-oauth-select",
        account_name="Backup",
    )
    assert decode_host_frame(encode_host_frame(frame)).account_name == "Backup"


@pytest.mark.parametrize(
    "contents",
    ["{", "[]", '{"accounts": [2], "active": ""}', '{"accounts": [], "active": "missing"}'],
)
def test_bad_metadata_does_not_break_discovery_or_silently_change_account(tmp_path, contents):
    (tmp_path / "claude-accounts.json").write_text(contents)
    assert account_descriptors() == []
    with pytest.raises(RuntimeError, match="Claude accounts"):
        account_env()


@pytest.mark.parametrize(
    "key",
    ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"],
)
def test_explicit_provider_environment_wins(monkeypatch, key):
    from omnigent.onboarding.claude_accounts import account_env_for_launch

    assert change_account("claude-oauth-add", "Backup", "sk-ant-oat-backup").stored
    assert account_env_for_launch({key: "configured"}) == {}
    monkeypatch.setenv(key, "inherited")
    assert account_env_for_launch({}) == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("explicit_key", [False, True])
async def test_sdk_launch_subscription_and_explicit_key(monkeypatch, explicit_key):
    from omnigent.inner.claude_sdk_executor import ClaudeSDKExecutor

    for key in (
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
    ):
        monkeypatch.delenv(key, raising=False)
    assert change_account("claude-oauth-add", "Backup", "sk-ant-oat-backup").stored
    executor = ClaudeSDKExecutor()
    if explicit_key:
        executor._extra_env["ANTHROPIC_API_KEY"] = "explicit-key"
    captured = {}

    async def capture(sdk, *, session_key, options, model):
        captured.update(options.env)
        raise RuntimeError("captured env")

    monkeypatch.setattr(executor, "_get_or_create_client", capture)
    with pytest.raises(RuntimeError, match="captured env"):
        async for _ in executor.run_turn([{"role": "user", "content": "hello"}], [], ""):
            pass
    if explicit_key:
        assert captured["ANTHROPIC_API_KEY"] == "explicit-key"
        assert "CLAUDE_CODE_OAUTH_TOKEN" not in captured
    else:
        assert captured["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat-backup"


def test_rename_labels_preserves_credentials_and_active_account():
    assert change_account("claude-oauth-add", "Backup", "sk-ant-oat-backup").stored
    assert change_account("claude-oauth-rename", "", label="Primary").stored
    assert change_account("claude-oauth-rename", "Backup", label="Personal").stored
    rows = account_descriptors()
    assert [(r["source"], r["env_var"]) for r in rows] == [("Primary", ""), ("Personal", "Backup")]
    assert rows[1]["family"] == "claude-oauth-active"
    assert account_env()["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat-backup"
    assert change_account("claude-oauth-select", "").stored
    assert account_env() == {}
    assert change_account("claude-oauth-select", "Backup").stored
    assert account_env()["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat-backup"


def test_rename_rejects_duplicate_invalid_and_missing_labels():
    assert change_account("claude-oauth-add", "Backup", "sk-ant-oat-backup").stored
    for label in [None, "", " ", "x" * 65, "../secret", "Default CLI account"]:
        assert not change_account("claude-oauth-rename", "Backup", label=label).stored
    assert not change_account("claude-oauth-rename", "missing", label="Personal").stored
    assert change_account("claude-oauth-rename", "Backup", label="Backup").stored
    assert account_env()["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat-backup"


def test_rename_frame_roundtrip():
    from omnigent.host.frames import HostStoreSecretFrame, decode_host_frame, encode_host_frame

    frame = HostStoreSecretFrame(
        request_id="request",
        harness="claude-native",
        kind="claude-oauth-rename",
        account_name="",
        account_label="Primary",
    )
    assert decode_host_frame(encode_host_frame(frame)) == frame
