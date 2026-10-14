"""Tests for ``GET`` and ``PUT /v1/sessions/{id}/fast-mode``.

The routes only authorize and forward: the runner answers, so the forward is
stubbed on the sessions facade (the seam the model change tests use too) and
each test checks what was sent and how the runner's answer comes back.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from omnigent.errors import OmnigentError
from omnigent.server.auth import LEVEL_OWNER, LEVEL_READ, UnifiedAuthProvider
from omnigent.server.routes import sessions as sessions_facade
from omnigent.server.routes._sessions.helpers import _RunnerForwardResult
from omnigent.server.routes.sessions import create_sessions_router
from omnigent.server.routes.sessions.routes_ae_fast_mode import FAST_MODE_FORWARD_TIMEOUT_S
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore
from tests.server.helpers import create_test_agent

OWNER = "reid@example.com"
VIEWER = "viewer@example.com"
AGENT_ID = "6f0c2b7e9a4d4c1e8b3a5d7f9e1c3a5b"


class _Runner:
    """Stands in for the bound runner behind ``_forward_session_change_to_runner``."""

    def __init__(self, result: _RunnerForwardResult | None) -> None:
        self.result = result
        self.calls: list[tuple[str, dict[str, Any], float | None]] = []

    async def __call__(
        self,
        session_id: str,
        runner_router: Any,
        event: dict[str, Any],
        timeout_s: float | None = None,
    ) -> _RunnerForwardResult | None:
        del runner_router
        self.calls.append((session_id, event, timeout_s))
        return self.result


def _app(db_uri: str) -> FastAPI:
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _handle(request: Request, exc: OmnigentError) -> JSONResponse:
        del request
        return JSONResponse(
            status_code=exc.http_status,
            content={"error": {"code": exc.code, "message": exc.message}},
        )

    app.include_router(
        create_sessions_router(
            conversation_store=SqlAlchemyConversationStore(db_uri),
            agent_store=SqlAlchemyAgentStore(db_uri),
            auth_provider=UnifiedAuthProvider(source="header"),
            permission_store=SqlAlchemyPermissionStore(db_uri),
        ),
        prefix="/v1",
    )
    return app


def _seed_session(db_uri: str) -> str:
    """A session the owner owns and the viewer may only read."""
    agents = SqlAlchemyAgentStore(db_uri)
    if agents.get(AGENT_ID) is None:
        agents.create(agent_id=AGENT_ID, name="claude", bundle_location=f"{AGENT_ID}/bundle")
    conv = SqlAlchemyConversationStore(db_uri).create_conversation(title="t", agent_id=AGENT_ID)
    perms = SqlAlchemyPermissionStore(db_uri)
    for user in (OWNER, VIEWER):
        perms.ensure_user(user)
    perms.grant(OWNER, conv.id, LEVEL_OWNER)
    perms.grant(VIEWER, conv.id, LEVEL_READ)
    return conv.id


@pytest.fixture
def setup(db_uri: str) -> tuple[TestClient, str]:
    return TestClient(_app(db_uri)), _seed_session(db_uri)


def _runner(monkeypatch: pytest.MonkeyPatch, status: int | None, body: str = "") -> _Runner:
    result = None if status is None else _RunnerForwardResult(status_code=status, body=body)
    runner = _Runner(result)
    monkeypatch.setattr(sessions_facade, "_forward_session_change_to_runner", runner)
    return runner


def _as(user: str) -> dict[str, str]:
    return {"X-Forwarded-Email": user}


@pytest.mark.parametrize("enabled", [True, False, None])
def test_get_returns_what_the_runner_reads(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch, enabled: bool | None
) -> None:
    client, sid = setup
    runner = _runner(
        monkeypatch, 200, f'{{"enabled": {"null" if enabled is None else str(enabled).lower()}}}'
    )

    response = client.get(f"/v1/sessions/{sid}/fast-mode", headers=_as(OWNER))

    assert response.status_code == 200, response.text
    assert response.json() == {"enabled": enabled}
    assert runner.calls == [(sid, {"type": "fast_mode_status"}, None)]


def test_get_without_a_runner_is_unknown(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, sid = setup
    _runner(monkeypatch, None)

    response = client.get(f"/v1/sessions/{sid}/fast-mode", headers=_as(VIEWER))

    assert response.status_code == 200, response.text
    assert response.json() == {"enabled": None}


def test_get_relays_a_runner_refusal(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, sid = setup
    _runner(
        monkeypatch,
        409,
        '{"error": "fast_mode_unsupported", '
        '"detail": "Fast mode is a Claude Code setting; this session runs codex-native."}',
    )

    response = client.get(f"/v1/sessions/{sid}/fast-mode", headers=_as(OWNER))

    assert response.status_code == 409
    assert response.json()["error"]["message"] == (
        "Could not read fast mode: Fast mode is a Claude Code setting; "
        "this session runs codex-native."
    )


@pytest.mark.parametrize("enabled", [True, False])
def test_put_forwards_the_change_and_returns_the_confirmed_state(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch, enabled: bool
) -> None:
    client, sid = setup
    runner = _runner(monkeypatch, 200, f'{{"enabled": {str(enabled).lower()}}}')

    response = client.put(
        f"/v1/sessions/{sid}/fast-mode", json={"enabled": enabled}, headers=_as(OWNER)
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"enabled": enabled}
    assert runner.calls == [
        (sid, {"type": "fast_mode_change", "enabled": enabled}, FAST_MODE_FORWARD_TIMEOUT_S)
    ]


def test_put_relays_the_runner_detail_on_failure(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, sid = setup
    _runner(
        monkeypatch,
        503,
        '{"error": "claude_native_fast_mode_unconfirmed", '
        '"detail": "Claude Code did not confirm the change within 10s."}',
    )

    response = client.put(
        f"/v1/sessions/{sid}/fast-mode", json={"enabled": True}, headers=_as(OWNER)
    )

    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "runner_unavailable"
    assert error["message"] == (
        "Could not turn fast mode on: Claude Code did not confirm the change within 10s."
    )


def test_put_without_a_runner_says_how_to_recover(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, sid = setup
    _runner(monkeypatch, None)

    response = client.put(
        f"/v1/sessions/{sid}/fast-mode", json={"enabled": False}, headers=_as(OWNER)
    )

    assert response.status_code == 503
    message = response.json()["error"]["message"]
    assert message.startswith("Could not turn fast mode off: no live runner")
    assert "Send a message to wake it" in message


def test_put_needs_edit_access(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, sid = setup
    runner = _runner(monkeypatch, 200, '{"enabled": true}')

    response = client.put(
        f"/v1/sessions/{sid}/fast-mode", json={"enabled": True}, headers=_as(VIEWER)
    )

    assert response.status_code == 403
    assert runner.calls == []


@pytest.mark.parametrize(
    "body", [{"enabled": "true"}, {"enabled": 1}, {}, {"enabled": True, "model": "opus"}]
)
def test_put_takes_only_a_boolean(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch, body: dict[str, Any]
) -> None:
    client, sid = setup
    runner = _runner(monkeypatch, 200, '{"enabled": true}')

    response = client.put(f"/v1/sessions/{sid}/fast-mode", json=body, headers=_as(OWNER))

    assert response.status_code == 422
    assert runner.calls == []


def test_put_rejects_a_non_json_body(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, sid = setup
    runner = _runner(monkeypatch, 200, '{"enabled": true}')

    response = client.put(
        f"/v1/sessions/{sid}/fast-mode",
        content='{"enabled": true}',
        headers={**_as(OWNER), "Content-Type": "text/plain"},
    )

    assert response.status_code == 415
    assert runner.calls == []


@pytest.mark.parametrize("method", ["get", "put"])
def test_unknown_session_is_404(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch, method: str
) -> None:
    client, _sid = setup
    runner = _runner(monkeypatch, 200, '{"enabled": true}')
    kwargs: dict[str, Any] = {"json": {"enabled": True}} if method == "put" else {}

    response = getattr(client, method)(
        "/v1/sessions/0123456789abcdef0123456789abcdef/fast-mode", headers=_as(OWNER), **kwargs
    )

    assert response.status_code == 404
    assert runner.calls == []


async def test_the_full_app_serves_both_routes(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No earlier route in ``create_app`` shadows the two paths."""
    runner = _runner(monkeypatch, 200, '{"enabled": true}')
    agent = await create_test_agent(client)
    created = await client.post("/v1/sessions", json={"agent_id": agent["id"]})
    assert created.status_code == 201, created.text
    sid = created.json()["id"]

    read = await client.get(f"/v1/sessions/{sid}/fast-mode")
    change = await client.put(f"/v1/sessions/{sid}/fast-mode", json={"enabled": True})

    assert (read.status_code, read.json()) == (200, {"enabled": True})
    assert (change.status_code, change.json()) == (200, {"enabled": True})
    assert [event for _sid, event, _timeout in runner.calls] == [
        {"type": "fast_mode_status"},
        {"type": "fast_mode_change", "enabled": True},
    ]
