"""The runner labels a claude-native session with the effort Claude defaults to."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from omnigent.runner import ae_launch_effort
from omnigent.runner.ae_launch_effort import (
    EFFORT_DEFAULT_LABEL,
    NO_LEVEL,
    claude_settings_effort,
    record_launch_effort,
)


@pytest.fixture(autouse=True)
def _no_managed_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ae_launch_effort, "_MANAGED_SETTINGS", tmp_path / "managed.json")


def _settings(path: Path, body: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body), encoding="utf-8")


def test_reads_the_launch_accounts_config_dir_over_home(tmp_path: Path) -> None:
    _settings(tmp_path / "home" / ".claude" / "settings.json", {"effortLevel": "high"})
    _settings(tmp_path / "acct2" / "settings.json", {"effortLevel": "low"})
    home = str(tmp_path / "home")
    cwd = tmp_path / "repo"
    assert claude_settings_effort({"HOME": home}, cwd) == "high"
    assert (
        claude_settings_effort({"HOME": home, "CLAUDE_CONFIG_DIR": str(tmp_path / "acct2")}, cwd)
        == "low"
    )


def test_follows_claudes_precedence(tmp_path: Path) -> None:
    env = {"CLAUDE_CONFIG_DIR": str(tmp_path / "user")}
    cwd = tmp_path / "repo"
    _settings(tmp_path / "user" / "settings.json", {"effortLevel": "low"})
    assert claude_settings_effort(env, cwd) == "low"
    _settings(cwd / ".claude" / "settings.json", {"effortLevel": "medium"})
    assert claude_settings_effort(env, cwd) == "medium"
    _settings(cwd / ".claude" / "settings.local.json", {"effortLevel": "high"})
    assert claude_settings_effort(env, cwd) == "high"
    _settings(tmp_path / "managed.json", {"effortLevel": "max"})
    assert claude_settings_effort(env, cwd) == "max"


@pytest.mark.parametrize("body", [{}, {"effortLevel": "turbo"}, {"effortLevel": 3}, ["high"]])
def test_no_valid_level_gives_none(tmp_path: Path, body: object) -> None:
    _settings(tmp_path / "settings.json", body)
    assert claude_settings_effort({"CLAUDE_CONFIG_DIR": str(tmp_path)}, tmp_path / "repo") is None


def test_missing_or_broken_settings_give_none(tmp_path: Path) -> None:
    env = {"CLAUDE_CONFIG_DIR": str(tmp_path)}
    assert claude_settings_effort(env, tmp_path / "repo") is None
    (tmp_path / "settings.json").write_text("{not json", encoding="utf-8")
    assert claude_settings_effort(env, tmp_path / "repo") is None


async def test_labels_the_session_and_swallows_a_server_error(tmp_path: Path) -> None:
    _settings(tmp_path / "settings.json", {"effortLevel": "xhigh"})
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(500 if len(seen) == 2 else 200, json={})

    env = {"CLAUDE_CONFIG_DIR": str(tmp_path)}
    cwd = tmp_path / "repo"
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://server"
    ) as client:
        await record_launch_effort(client, "conv_abc", env=env, cwd=cwd, args=["claude"])
        await record_launch_effort(client, "conv_abc", env=env, cwd=cwd, args=[])  # 500, no raise
        await record_launch_effort(
            client, "conv_abc", env={"CLAUDE_CONFIG_DIR": str(tmp_path / "x")}, cwd=cwd, args=[]
        )

    assert len(seen) == 3
    assert seen[0].method == "PATCH"
    assert seen[0].url.path == "/v1/sessions/conv_abc"
    assert json.loads(seen[0].content) == {"labels": {EFFORT_DEFAULT_LABEL: "xhigh"}}
    assert json.loads(seen[2].content) == {"labels": {EFFORT_DEFAULT_LABEL: NO_LEVEL}}


@pytest.mark.parametrize(
    "args", [["--effort", "low"], ["--effort=low"], ["CLAUDE_X=1", "claude", "--effort", "max"]]
)
async def test_an_explicit_effort_argument_is_left_alone(tmp_path: Path, args: list[str]) -> None:
    _settings(tmp_path / "settings.json", {"effortLevel": "high"})

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no PATCH expected")

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://server"
    ) as client:
        await record_launch_effort(
            client, "conv_abc", env={"CLAUDE_CONFIG_DIR": str(tmp_path)}, cwd=tmp_path, args=args
        )
