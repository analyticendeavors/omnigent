"""The Claude account a fork can pick, checked against the source session's host."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.onboarding.claude_accounts import CLAUDE_ACCOUNT_LABEL_KEY
from omnigent.server.routes.sessions import ae_fork_claude_account
from tests.server.routes.test_sessions_fork import (
    _build_app,
    _ConversationStore,
    _make_conversation,
    _make_item,
    _StubAgentCache,
    _switch_agent_store,
)

_SOURCE_ID = "e9f8f58523cec9a57d3bdf93be543e8c"
_CLAUDE_TARGET = "280d725b404d2915f9e9d6cccce91303"
_CODEX_TARGET = "44b4151dd6cdfed6ee19430832398e05"


class _Spec:
    def __init__(self, harness: str, *, auth: object = None, env: dict[str, str] | None = None):
        self.env = env
        self.executor = SimpleNamespace(harness_kind=harness, auth=auth, profile=None, config={})


def _host_state(*, connected: bool, owner: str) -> SimpleNamespace:
    connection = object()
    hosts = SimpleNamespace(
        get=lambda host: connection if connected and host == "host-local" else None
    )
    host_store = SimpleNamespace(
        get_host=lambda host: SimpleNamespace(user_id=owner, sandbox_provider=None)
    )
    return SimpleNamespace(host_store=host_store, host_registry=hosts)


def _request(*, connected: bool, owner: str) -> Any:
    return SimpleNamespace(
        app=SimpleNamespace(state=_host_state(connected=connected, owner=owner))
    )


@pytest.fixture
def detected(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    from omnigent.server.routes import hosts

    credentials = [
        {"family": "claude-oauth", "source": "Work", "env_var": "Work"},
        {"family": "claude-oauth", "source": "Default CLI account", "env_var": None},
    ]

    async def detect(**kwargs: Any) -> dict[str, Any]:
        return {"credentials": credentials}

    monkeypatch.setattr(hosts, "_proxy_detect_credentials", detect)
    return credentials


def _use_spec(monkeypatch: pytest.MonkeyPatch, spec: _Spec) -> None:
    cache = SimpleNamespace(load=lambda agent_id, location: SimpleNamespace(spec=spec))
    monkeypatch.setattr("omnigent.server.routes.sessions.get_agent_cache", lambda: cache)


@pytest.mark.parametrize(
    "account,connected,host_id,harness,owner,host_type,expected",
    [
        ("Work", True, "host-local", "claude-native", "local", "external", None),
        ("", True, "host-local", "claude-native", "local", "external", None),
        (
            "Missing",
            True,
            "host-local",
            "claude-native",
            "local",
            "external",
            ErrorCode.INVALID_INPUT,
        ),
        ("Work", False, "host-local", "claude-native", "local", "external", ErrorCode.CONFLICT),
        ("Work", True, None, "claude-native", "local", "external", ErrorCode.INVALID_INPUT),
        ("Work", True, "host-local", "codex-native", "local", "external", ErrorCode.INVALID_INPUT),
        (
            "Work",
            True,
            "host-local",
            "claude-native",
            "another-user",
            "external",
            ErrorCode.FORBIDDEN,
        ),
        ("Work", True, "host-local", "claude-native", "local", "managed", ErrorCode.INVALID_INPUT),
    ],
)
async def test_validates_the_account_against_the_source_host(
    monkeypatch: pytest.MonkeyPatch,
    detected: list[dict[str, Any]],
    account: str,
    connected: bool,
    host_id: str | None,
    harness: str,
    owner: str,
    host_type: str,
    expected: ErrorCode | None,
) -> None:
    _use_spec(monkeypatch, _Spec(harness))
    check = ae_fork_claude_account.validate_fork_claude_account(
        _request(connected=connected, owner=owner),
        account=account,
        agent=SimpleNamespace(id="agent", bundle_location="bundle"),
        source=SimpleNamespace(host_id=host_id, inference_snapshot=None),
        user_id=None,
        host_type=host_type,
    )
    if expected is None:
        await check
        return
    with pytest.raises(OmnigentError) as error:
        await check
    assert error.value.code == expected


@pytest.mark.parametrize("binding", ["session", "auth", "env", "host"])
async def test_refuses_provider_credentials_before_signing_in(
    monkeypatch: pytest.MonkeyPatch, detected: list[dict[str, Any]], binding: str
) -> None:
    spec = _Spec(
        "claude-native",
        auth=object() if binding == "auth" else None,
        env={"ANTHROPIC_API_KEY": "sk-test"} if binding == "env" else None,
    )
    _use_spec(monkeypatch, spec)
    if binding == "host":
        detected.append({"family": "claude-provider-env", "source": "ANTHROPIC_API_KEY"})
    with pytest.raises(OmnigentError, match="provider authentication") as error:
        await ae_fork_claude_account.validate_fork_claude_account(
            _request(connected=True, owner="local"),
            account="Work",
            agent=SimpleNamespace(id="agent", bundle_location="bundle"),
            source=SimpleNamespace(
                host_id="host-local",
                inference_snapshot={"harness": "claude-native"} if binding == "session" else None,
            ),
            user_id=None,
            host_type="external",
        )
    assert error.value.code == ErrorCode.INVALID_INPUT


def _fork_store(
    *, host_id: str | None = None, labels: dict[str, str] | None = None
) -> _ConversationStore:
    source = _make_conversation(labels=labels)
    source.host_id = host_id
    return _ConversationStore(
        conversations={_SOURCE_ID: source},
        items_by_conv={_SOURCE_ID: [_make_item("9980c8a9248139f14f4165e5d53088aa", "Hi")]},
    )


def _client_with_host(conv_store: _ConversationStore, *, owner: str) -> TestClient:
    app = _build_app(conv_store, agent_store=_switch_agent_store())
    hosts = _host_state(connected=True, owner=owner)
    app.state.host_store = hosts.host_store
    app.state.host_registry = hosts.host_registry
    return TestClient(app)


def _stub_targets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "omnigent.server.routes.sessions.get_agent_cache",
        lambda: _StubAgentCache(
            {
                "087b7cb7ac30abf4debfaa578d052ec6": "claude_sdk",
                _CLAUDE_TARGET: "claude-native",
                _CODEX_TARGET: "codex-native",
            }
        ),
    )


def test_fork_stamps_the_picked_account(monkeypatch: pytest.MonkeyPatch) -> None:
    checked: list[str] = []

    async def accept(request: Any, *, account: str, **kwargs: Any) -> None:
        checked.append(account)

    monkeypatch.setattr(ae_fork_claude_account, "validate_fork_claude_account", accept)
    _stub_targets(monkeypatch)
    conv_store = _fork_store()
    client = TestClient(_build_app(conv_store, agent_store=_switch_agent_store()))

    resp = client.post(
        f"/v1/sessions/{_SOURCE_ID}/fork",
        json={"agent_id": _CLAUDE_TARGET, "claude_account": "Work"},
    )

    assert resp.status_code == 201, resp.text
    assert checked == ["Work"]
    assert conv_store.fork_calls[0]["extra_labels"] == {CLAUDE_ACCOUNT_LABEL_KEY: "Work"}


def test_fork_without_a_pick_keeps_the_source_account(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_targets(monkeypatch)
    conv_store = _fork_store()
    client = TestClient(_build_app(conv_store, agent_store=_switch_agent_store()))

    resp = client.post(f"/v1/sessions/{_SOURCE_ID}/fork", json={"agent_id": _CLAUDE_TARGET})

    assert resp.status_code == 201, resp.text
    assert CLAUDE_ACCOUNT_LABEL_KEY not in (conv_store.fork_calls[0]["extra_labels"] or {})
    assert CLAUDE_ACCOUNT_LABEL_KEY not in conv_store.fork_calls[0]["dropped_label_keys"]


def test_fork_refuses_an_account_for_a_codex_target(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_targets(monkeypatch)
    conv_store = _fork_store()
    client = TestClient(_build_app(conv_store, agent_store=_switch_agent_store()))

    resp = client.post(
        f"/v1/sessions/{_SOURCE_ID}/fork",
        json={"agent_id": _CODEX_TARGET, "claude_account": "Work"},
    )

    assert resp.status_code == 400, resp.text
    assert "Claude native target" in resp.text
    assert conv_store.fork_calls == []


def test_fork_refuses_an_account_on_a_host_the_caller_does_not_own(
    monkeypatch: pytest.MonkeyPatch, detected: list[dict[str, Any]]
) -> None:
    _stub_targets(monkeypatch)
    conv_store = _fork_store(host_id="host-local")
    client = _client_with_host(conv_store, owner="another-user")

    resp = client.post(
        f"/v1/sessions/{_SOURCE_ID}/fork",
        json={"agent_id": _CLAUDE_TARGET, "claude_account": "Work"},
    )

    assert resp.status_code == 403, resp.text
    assert "ownership of the session's host" in resp.text
    assert conv_store.fork_calls == []


def test_fork_checks_the_switched_target_and_replaces_the_source_account(
    monkeypatch: pytest.MonkeyPatch, detected: list[dict[str, Any]]
) -> None:
    # The source runs a Claude SDK agent, so only a check of the target passes.
    _stub_targets(monkeypatch)
    conv_store = _fork_store(host_id="host-local", labels={CLAUDE_ACCOUNT_LABEL_KEY: "Personal"})
    client = _client_with_host(conv_store, owner="local")

    resp = client.post(
        f"/v1/sessions/{_SOURCE_ID}/fork",
        json={"agent_id": _CLAUDE_TARGET, "claude_account": "Work"},
    )

    assert resp.status_code == 201, resp.text
    assert resp.json()["labels"][CLAUDE_ACCOUNT_LABEL_KEY] == "Work"


def test_fork_refuses_an_account_name_past_the_host_limit() -> None:
    conv_store = _fork_store()
    client = TestClient(_build_app(conv_store, agent_store=_switch_agent_store()))

    resp = client.post(
        f"/v1/sessions/{_SOURCE_ID}/fork",
        json={"agent_id": _CLAUDE_TARGET, "claude_account": "a" * 65},
    )

    assert resp.status_code == 422, resp.text
    assert conv_store.fork_calls == []
