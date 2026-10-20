"""Shared Claude accounts on a host: picked by id, fetched from the server at launch only."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest

from omnigent.onboarding import ae_shared_claude_accounts as shared
from omnigent.onboarding.claude_accounts import (
    account_descriptors,
    account_env,
    account_label,
    change_account,
)

TOKEN = "sk-ant-oat01-shared-" + "x" * 20


@pytest.fixture(autouse=True)
def isolated(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("OMNIGENT_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("OMNIGENT_DISABLE_KEYRING", "1")
    monkeypatch.setenv("RUNNER_SERVER_URL", "https://omni.test/")


@pytest.fixture()
def server(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """The server's token route, answered in process; records each request."""
    calls: list[dict[str, Any]] = []
    answers = {"Team": {"name": "Team", "label": "Company Max", "token": TOKEN}}

    def get(url: str, *, headers: dict[str, str], **kwargs: Any) -> httpx.Response:
        calls.append({"url": url, "headers": headers})
        name = url.rsplit("/", 2)[-2]
        request = httpx.Request("GET", url)
        if name in answers:
            return httpx.Response(200, json=answers[name], request=request)
        body = {"error": {"code": "shared_account_not_found", "message": "No such account."}}
        return httpx.Response(404, json=body, request=request)

    monkeypatch.setattr(httpx, "get", get)

    def factory(server_url: str | None = None, **_kwargs: Any) -> Any:
        # The host's model-catalog probe has no RUNNER_SERVER_URL; only an explicit
        # URL finds the stored login, so a call without one gets no credential.
        return (lambda: "runner-jwt") if server_url else None

    monkeypatch.setattr("omnigent.runner._entry._make_auth_token_factory", factory)
    return calls


def _files(root: Path) -> str:
    return "".join(path.read_text(errors="ignore") for path in root.rglob("*") if path.is_file())


def test_selecting_a_shared_account_keeps_only_its_id(tmp_path: Path) -> None:
    assert change_account("claude-oauth-add", "Team", "sk-ant-oat-local-one").stored
    assert change_account("claude-oauth-select", "shared:Team").stored
    descriptors = account_descriptors()
    # The host's own "Team" and the shared one are two rows with distinct ids.
    assert [(row["env_var"], row["family"]) for row in descriptors] == [
        ("", "claude-oauth"),
        ("Team", "claude-oauth"),
        ("shared:Team", "claude-oauth-active"),
    ]
    assert descriptors[-1]["source"] == "Team (shared)"
    assert account_label("shared:Team") == "Team (shared)"
    assert TOKEN not in _files(tmp_path)


def test_a_shared_account_cannot_be_added_or_renamed_on_a_host() -> None:
    added = change_account("claude-oauth-add", "shared:Team", "sk-ant-oat-x")
    assert (added.stored, added.reason) == (False, "Shared accounts are managed in Admin Center.")
    assert not change_account("claude-oauth-rename", "shared:Team", label="Mine").stored
    assert not change_account("claude-oauth-select", "shared:../x").stored


def test_launch_fetches_the_token_with_the_runner_credential(
    server: list[dict[str, Any]], tmp_path: Path
) -> None:
    assert change_account("claude-oauth-select", "shared:Team").stored
    env = account_env()
    assert env == {
        "CLAUDE_CODE_OAUTH_TOKEN": TOKEN,
        "ANTHROPIC_API_KEY": "",
        "ANTHROPIC_AUTH_TOKEN": "",
        "OMNIGENT_CLAUDE_ACCOUNT": "shared:Team",
    }
    assert server[0]["url"] == "https://omni.test/v1/ae/claude-accounts/shared/Team/token"
    assert server[0]["headers"]["Authorization"] == "Bearer runner-jwt"
    # Fetched for this launch only: nothing on disk, and the next launch asks again.
    assert TOKEN not in _files(tmp_path)
    account_env()
    assert len(server) == 2


def test_the_native_terminal_gets_the_shared_token(server: list[dict[str, Any]]) -> None:
    from omnigent.harnesses.claude_native.main import build_native_claude_terminal_env

    env = build_native_claude_terminal_env(None, account_name="shared:Team")
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN
    assert env["OMNIGENT_CLAUDE_ACCOUNT"] == "shared:Team"


def test_a_refusal_says_what_failed(server: list[dict[str, Any]]) -> None:
    with pytest.raises(RuntimeError, match="No such account") as error:
        account_env("shared:Gone")
    assert "Admin Center" in str(error.value)


def test_no_server_url_fails_clearly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RUNNER_SERVER_URL")
    monkeypatch.delenv("OMNIGENT_SERVER_URL", raising=False)
    with pytest.raises(RuntimeError, match="needs the OmniGent server"):
        account_env("shared:Team")


def test_detection_counts_a_shared_pick_without_fetching(monkeypatch: pytest.MonkeyPatch) -> None:
    from omnigent.onboarding import ambient

    def refuse(*args: Any, **kwargs: Any) -> httpx.Response:
        raise AssertionError("detection must not fetch the token")

    monkeypatch.setattr(httpx, "get", refuse)
    monkeypatch.setattr(ambient, "claude_auth_has_credential", lambda path: False)
    assert change_account("claude-oauth-select", "shared:Team").stored
    assert ambient._claude_login_detected()


def test_the_server_resolver_answers_for_a_fork(monkeypatch: pytest.MonkeyPatch) -> None:
    assert not shared.known_on_server("shared:Team")
    monkeypatch.setattr(shared, "_server_resolver", lambda account: account == "shared:Team")
    assert shared.known_on_server("shared:Team")
    assert not shared.known_on_server("shared:Other")
    assert not shared.known_on_server("Team")
