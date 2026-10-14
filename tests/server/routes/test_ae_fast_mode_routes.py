"""Tests for ``GET`` and ``PUT /v1/sessions/{id}/fast-mode``.

The routes only authorize and forward: the runner answers, so the forward is
stubbed on the sessions facade (the seam the model change tests use too) and
each test checks what was sent and how the runner's answer comes back. The
timeout test keeps the real forward and stubs the runner client instead.
"""

from __future__ import annotations

import json
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
from omnigent.server.routes.sessions.routes_ae_fast_mode import (
    FAST_MODE_FORWARD_TIMEOUT_S,
    UNANSWERED_REASON,
)
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


class _TimedOutRunner:
    """A runner client whose request goes out and gets no answer in time."""

    def __init__(self) -> None:
        self.posts: list[tuple[str, dict[str, Any], float]] = []

    async def post(self, path: str, *, json: dict[str, Any], timeout: float) -> httpx.Response:
        self.posts.append((path, json, timeout))
        raise httpx.ReadTimeout("timed out")


def _runner(monkeypatch: pytest.MonkeyPatch, status: int | None, body: str = "") -> _Runner:
    result = None if status is None else _RunnerForwardResult(status_code=status, body=body)
    runner = _Runner(result)
    monkeypatch.setattr(sessions_facade, "_forward_session_change_to_runner", runner)
    return runner


def _as(user: str) -> dict[str, str]:
    return {"X-Forwarded-Email": user}


@pytest.mark.parametrize(
    ("enabled", "per_session"), [(True, True), (False, True), (None, True), (False, False)]
)
def test_get_returns_what_the_runner_reads(
    setup: tuple[TestClient, str],
    monkeypatch: pytest.MonkeyPatch,
    enabled: bool | None,
    per_session: bool,
) -> None:
    client, sid = setup
    runner = _runner(
        monkeypatch, 200, json.dumps({"enabled": enabled, "per_session": per_session})
    )

    response = client.get(f"/v1/sessions/{sid}/fast-mode", headers=_as(OWNER))

    assert response.status_code == 200, response.text
    assert response.json() == {"enabled": enabled, "per_session": per_session}
    assert runner.calls == [(sid, {"type": "fast_mode_status"}, None)]


def test_get_without_a_runner_is_unknown(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, sid = setup
    _runner(monkeypatch, None)

    response = client.get(f"/v1/sessions/{sid}/fast-mode", headers=_as(VIEWER))

    assert response.status_code == 200, response.text
    assert response.json() == {"enabled": None, "per_session": None}


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


@pytest.mark.parametrize(
    ("status", "code"), [(409, "conflict"), (503, "runner_unavailable")], ids=["409", "503"]
)
def test_put_relays_the_runner_detail_on_failure(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch, status: int, code: str
) -> None:
    client, sid = setup
    _runner(
        monkeypatch,
        status,
        '{"error": "claude_native_no_terminal", '
        '"detail": "No Claude Code terminal right now; send the session a message first."}',
    )

    response = client.put(
        f"/v1/sessions/{sid}/fast-mode", json={"enabled": True}, headers=_as(OWNER)
    )

    assert response.status_code == status
    error = response.json()["error"]
    assert error["code"] == code
    assert error["message"] == (
        "Could not turn fast mode on: No Claude Code terminal right now; "
        "send the session a message first."
    )


def test_put_relays_a_change_the_runner_typed_but_has_not_confirmed(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, sid = setup
    pending = {
        "enabled": True,
        "pending": True,
        "reason": "Applies when the current reply finishes",
    }
    _runner(monkeypatch, 202, json.dumps(pending))

    response = client.put(
        f"/v1/sessions/{sid}/fast-mode", json={"enabled": True}, headers=_as(OWNER)
    )

    assert response.status_code == 202, response.text
    assert response.json() == pending


def test_put_without_an_answer_is_pending(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """No answer may still mean a typed command, so the web re-reads instead of reverting."""
    client, sid = setup
    _runner(monkeypatch, None)

    response = client.put(
        f"/v1/sessions/{sid}/fast-mode", json={"enabled": False}, headers=_as(OWNER)
    )

    assert response.status_code == 202, response.text
    assert response.json() == {"enabled": False, "pending": True, "reason": UNANSWERED_REASON}
    assert UNANSWERED_REASON == "Waiting for Claude Code to confirm"


def test_put_whose_forward_times_out_is_pending(
    setup: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real forward, with a runner that never answers within the budget."""
    client, sid = setup
    runner_client = _TimedOutRunner()

    async def _resolve(session_id: str, runner_router: Any, **kwargs: Any) -> _TimedOutRunner:
        del session_id, runner_router, kwargs
        return runner_client

    monkeypatch.setattr(sessions_facade, "_get_runner_client", _resolve)

    response = client.put(
        f"/v1/sessions/{sid}/fast-mode", json={"enabled": True}, headers=_as(OWNER)
    )

    assert response.status_code == 202, response.text
    assert response.json() == {"enabled": True, "pending": True, "reason": UNANSWERED_REASON}
    assert runner_client.posts == [
        (
            f"/v1/sessions/{sid}/events",
            {"type": "fast_mode_change", "enabled": True},
            FAST_MODE_FORWARD_TIMEOUT_S,
        )
    ]
    assert FAST_MODE_FORWARD_TIMEOUT_S == 75.0


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

    assert (read.status_code, read.json()) == (200, {"enabled": True, "per_session": None})
    assert (change.status_code, change.json()) == (200, {"enabled": True})
    assert [event for _sid, event, _timeout in runner.calls] == [
        {"type": "fast_mode_status"},
        {"type": "fast_mode_change", "enabled": True},
    ]
