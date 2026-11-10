"""The context probe is only dispatched after session authorization."""

import json
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.routes._sessions.helpers import _RunnerForwardResult
from omnigent.server.routes.sessions import routes_ae_context_usage as routes
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.host_store import HostStore
from tests.server.routes.test_ae_fast_mode_routes import OWNER, VIEWER, _app, _seed_session


@pytest.mark.parametrize(
    "user,expected", [(OWNER, 200), (VIEWER, 403), ("stranger@example.com", 404)]
)
def test_access(db_uri, monkeypatch, user, expected):
    session = _seed_session(db_uri)
    forward = AsyncMock(
        return_value=_RunnerForwardResult(
            status_code=200, body=json.dumps({"available": True}).encode()
        )
    )
    monkeypatch.setattr(routes, "_forward_session_change_to_runner", forward)
    with TestClient(_app(db_uri)) as client:
        response = client.get(
            f"/v1/sessions/{session}/context-usage", headers={"X-Forwarded-Email": user}
        )
    assert response.status_code == expected
    assert forward.await_count == (1 if expected == 200 else 0)


@pytest.fixture(autouse=True)
def _clear_wakes():
    """Each TestClient runs its own loop, so no wake task may outlive its test."""
    routes._wakes.clear()
    yield
    for task in routes._wakes.values():
        task.cancel()
    routes._wakes.clear()


def test_offline_runner_answers_offline(db_uri, monkeypatch):
    session = _seed_session(db_uri)
    monkeypatch.setattr(routes, "_forward_session_change_to_runner", AsyncMock(return_value=None))
    with TestClient(_app(db_uri)) as client:
        response = client.get(
            f"/v1/sessions/{session}/context-usage", headers={"X-Forwarded-Email": OWNER}
        )
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is False
    assert body["offline"] is True


@pytest.mark.parametrize(
    "query,payload",
    [("", {"type": "context_usage"}), ("?fresh=true", {"type": "context_usage", "fresh": True})],
)
def test_fresh_query_reaches_the_runner(db_uri, monkeypatch, query, payload):
    session = _seed_session(db_uri)
    forward = AsyncMock(
        return_value=_RunnerForwardResult(
            status_code=200, body=json.dumps({"available": True}).encode()
        )
    )
    monkeypatch.setattr(routes, "_forward_session_change_to_runner", forward)
    with TestClient(_app(db_uri)) as client:
        response = client.get(
            f"/v1/sessions/{session}/context-usage{query}", headers={"X-Forwarded-Email": OWNER}
        )
    assert response.status_code == 200
    assert forward.await_args.args[2] == payload


def _ok_forward():
    return AsyncMock(
        return_value=_RunnerForwardResult(
            status_code=200, body=json.dumps({"available": True}).encode()
        )
    )


def _get(db_uri, session, query, user=OWNER):
    with TestClient(_app(db_uri)) as client:
        return client.get(
            f"/v1/sessions/{session}/context-usage{query}", headers={"X-Forwarded-Email": user}
        )


def test_wake_flag_wakes_a_sleeping_runner_then_reads(db_uri, monkeypatch):
    session = _seed_session(db_uri)
    _with_host(db_uri, session)
    forward = _ok_forward()
    wake = AsyncMock()
    monkeypatch.setattr(routes, "_forward_session_change_to_runner", forward)
    monkeypatch.setattr(routes, "_get_runner_client", AsyncMock(return_value=None))
    monkeypatch.setattr(routes, "_wake_runner_for_model_change", wake)
    monkeypatch.setattr(routes, "_is_native_terminal_session", lambda conv: True)
    response = _get(db_uri, session, "?fresh=true&wake=true")
    assert response.status_code == 200
    assert wake.await_count == 1
    assert wake.await_args.kwargs["action"] == "read context"
    assert forward.await_count == 1


def test_wake_flag_with_a_runner_client_does_not_wake(db_uri, monkeypatch):
    session = _seed_session(db_uri)
    wake = AsyncMock()
    monkeypatch.setattr(routes, "_forward_session_change_to_runner", _ok_forward())
    monkeypatch.setattr(routes, "_get_runner_client", AsyncMock(return_value=object()))
    monkeypatch.setattr(routes, "_wake_runner_for_model_change", wake)
    monkeypatch.setattr(routes, "_is_native_terminal_session", lambda conv: True)
    assert _get(db_uri, session, "?wake=true").status_code == 200
    assert wake.await_count == 0


def test_no_wake_flag_never_wakes_and_gives_the_new_reason(db_uri, monkeypatch):
    session = _seed_session(db_uri)
    wake = AsyncMock()
    monkeypatch.setattr(routes, "_forward_session_change_to_runner", AsyncMock(return_value=None))
    monkeypatch.setattr(routes, "_get_runner_client", AsyncMock(return_value=None))
    monkeypatch.setattr(routes, "_wake_runner_for_model_change", wake)
    monkeypatch.setattr(routes, "_is_native_terminal_session", lambda conv: True)
    body = _get(db_uri, session, "?fresh=true").json()
    assert wake.await_count == 0
    assert body["offline"] is True
    assert (
        body["reason"] == "The session's runner is asleep or did not answer. Try again wakes it."
    )


def _with_host(db_uri, session):
    host = HostStore(db_uri).upsert_on_connect("6b9c07bfb42f687d53af44f018adebec", "laptop", OWNER)
    SqlAlchemyConversationStore(db_uri).set_host_id(
        session, host_id=host.host_id, workspace="/tmp/ctx"
    )


def _failing(monkeypatch, code, message="boom"):
    monkeypatch.setattr(routes, "_get_runner_client", AsyncMock(return_value=None))
    monkeypatch.setattr(routes, "_is_native_terminal_session", lambda conv: True)
    monkeypatch.setattr(
        routes,
        "_wake_runner_for_model_change",
        AsyncMock(side_effect=OmnigentError(message, code=code)),
    )
    forward = _ok_forward()
    monkeypatch.setattr(routes, "_forward_session_change_to_runner", forward)
    return forward


def test_runner_unavailable_passes_the_helper_message_through(db_uri, monkeypatch):
    session = _seed_session(db_uri)
    _with_host(db_uri, session)
    forward = _failing(monkeypatch, ErrorCode.RUNNER_UNAVAILABLE, "Session init failed.")
    body = _get(db_uri, session, "?wake=true").json()
    assert body == {"available": False, "offline": True, "reason": "Session init failed."}
    assert forward.await_count == 0


@pytest.mark.parametrize("code", [ErrorCode.HARNESS_NOT_CONFIGURED, ErrorCode.WORKSPACE_MISSING])
def test_host_refusals_give_a_final_answer(db_uri, monkeypatch, code):
    session = _seed_session(db_uri)
    _with_host(db_uri, session)
    forward = _failing(monkeypatch, code, "Refused.")
    body = _get(db_uri, session, "?wake=true").json()
    assert body == {"available": False, "reason": "Refused."}
    assert "final" not in body
    assert forward.await_count == 0


@pytest.mark.parametrize("has_host,native", [(False, True), (True, False)])
def test_no_host_or_non_native_session_never_wakes_and_still_forwards(
    db_uri, monkeypatch, has_host, native
):
    session = _seed_session(db_uri)
    if has_host:
        _with_host(db_uri, session)
    wake = AsyncMock()
    forward = _ok_forward()
    monkeypatch.setattr(routes, "_forward_session_change_to_runner", forward)
    monkeypatch.setattr(routes, "_get_runner_client", AsyncMock(return_value=None))
    monkeypatch.setattr(routes, "_is_native_terminal_session", lambda conv: native)
    monkeypatch.setattr(routes, "_wake_runner_for_model_change", wake)
    assert _get(db_uri, session, "?wake=true").status_code == 200
    assert wake.await_count == 0
    assert forward.await_count == 1


def test_wake_over_budget_answers_pending(db_uri, monkeypatch):
    import asyncio

    session = _seed_session(db_uri)
    _with_host(db_uri, session)
    done = []

    async def slow(*args, **kwargs):
        await asyncio.sleep(0.2)
        done.append(True)

    forward = _ok_forward()
    monkeypatch.setattr(routes, "_forward_session_change_to_runner", forward)
    monkeypatch.setattr(routes, "_get_runner_client", AsyncMock(return_value=None))
    monkeypatch.setattr(routes, "_is_native_terminal_session", lambda conv: True)
    monkeypatch.setattr(routes, "_wake_runner_for_model_change", slow)
    monkeypatch.setattr(routes, "WAKE_BUDGET_S", 0.01)
    body = _get(db_uri, session, "?wake=true").json()
    assert body["pending"] is True
    assert body["available"] is False
    assert forward.await_count == 0


@pytest.mark.parametrize("user,expected", [(VIEWER, 403), ("stranger@example.com", 404)])
def test_access_check_runs_before_the_wake(db_uri, monkeypatch, user, expected):
    session = _seed_session(db_uri)
    wake = AsyncMock()
    monkeypatch.setattr(routes, "_get_runner_client", AsyncMock(return_value=None))
    monkeypatch.setattr(routes, "_wake_runner_for_model_change", wake)
    monkeypatch.setattr(routes, "_is_native_terminal_session", lambda conv: True)
    assert _get(db_uri, session, "?wake=true", user=user).status_code == expected
    assert wake.await_count == 0


def _wake_setup(db_uri, monkeypatch, wake):
    routes._wakes.clear()
    session = _seed_session(db_uri)
    _with_host(db_uri, session)
    forward = _ok_forward()
    monkeypatch.setattr(routes, "_forward_session_change_to_runner", forward)
    monkeypatch.setattr(routes, "_get_runner_client", AsyncMock(return_value=None))
    monkeypatch.setattr(routes, "_is_native_terminal_session", lambda conv: True)
    monkeypatch.setattr(routes, "_wake_runner_for_model_change", wake)
    return session, forward


def test_non_wake_read_joins_a_wake_in_flight_and_never_starts_one(db_uri, monkeypatch):
    import asyncio

    calls = []

    async def slow(*args, **kwargs):
        calls.append(1)
        await asyncio.sleep(0.3)

    session, forward = _wake_setup(db_uri, monkeypatch, slow)
    monkeypatch.setattr(routes, "WAKE_BUDGET_S", 0.05)
    with TestClient(_app(db_uri)) as client:
        h = {"X-Forwarded-Email": OWNER}
        first = client.get(f"/v1/sessions/{session}/context-usage?wake=true", headers=h).json()
        joined = client.get(f"/v1/sessions/{session}/context-usage", headers=h).json()
        assert first["pending"] is True and joined["pending"] is True
        assert forward.await_count == 0
        monkeypatch.setattr(routes, "WAKE_BUDGET_S", 5)
        done = client.get(f"/v1/sessions/{session}/context-usage", headers=h)
        assert done.json() == {"available": True}
    assert len(calls) == 1
    assert forward.await_count == 1


def test_two_concurrent_wake_requests_call_the_helper_once(db_uri, monkeypatch):
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    calls = []

    async def slow(*args, **kwargs):
        calls.append(1)
        await asyncio.sleep(0.3)

    session, _ = _wake_setup(db_uri, monkeypatch, slow)
    with TestClient(_app(db_uri)) as client:
        h = {"X-Forwarded-Email": OWNER}

        def go():
            return client.get(f"/v1/sessions/{session}/context-usage?wake=true", headers=h)

        with ThreadPoolExecutor(2) as pool:
            results = [f.result() for f in [pool.submit(go), pool.submit(go)]]
    assert [r.status_code for r in results] == [200, 200]
    assert len(calls) == 1


@pytest.mark.parametrize("fails", [False, True])
def test_wake_map_is_cleared_after_completion_and_failure(db_uri, monkeypatch, fails):
    wake = AsyncMock(
        side_effect=OmnigentError("x", code=ErrorCode.RUNNER_UNAVAILABLE) if fails else None
    )
    session, _ = _wake_setup(db_uri, monkeypatch, wake)
    _get(db_uri, session, "?wake=true")
    assert routes._wakes == {}


def test_forward_timeout_shrinks_after_a_wake(db_uri, monkeypatch):
    session, forward = _wake_setup(db_uri, monkeypatch, AsyncMock())
    _get(db_uri, session, "?wake=true")
    assert 5.0 <= forward.await_args.kwargs["timeout_s"] <= routes.REQUEST_BUDGET_S
    assert forward.await_args.kwargs["timeout_s"] > 35
    forward.reset_mock()
    _get(db_uri, session, "")
    assert forward.await_args.kwargs["timeout_s"] == 35


def test_a_hung_wake_ends_offline_and_leaves_the_map(db_uri, monkeypatch):
    import asyncio

    async def hung(*args, **kwargs):
        await asyncio.sleep(60)

    session, forward = _wake_setup(db_uri, monkeypatch, hung)
    monkeypatch.setattr(routes, "WAKE_LIMIT_S", 0.05)
    body = _get(db_uri, session, "?wake=true").json()
    assert body["offline"] is True
    assert "took too long" in body["reason"]
    assert routes._wakes == {}
    assert forward.await_count == 0
