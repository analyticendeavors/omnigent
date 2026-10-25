"""Tests for the transient ``external_session_suggestion`` session event."""

from __future__ import annotations

import time
from typing import Any

import httpx
import pytest

from omnigent.server.routes._sessions import ae_session_suggestion
from omnigent.server.routes._sessions import helpers as session_helpers
from omnigent.server.routes._sessions.common import _session_status_cache
from tests.server.helpers import create_test_agent

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _reset_held_suggestions() -> Any:
    ae_session_suggestion.reset_for_tests()
    yield
    ae_session_suggestion.reset_for_tests()


def _post(client: httpx.AsyncClient, session_id: str, data: dict[str, Any]) -> Any:
    return client.post(
        f"/v1/sessions/{session_id}/events",
        json={"type": "external_session_suggestion", "data": data},
    )


async def _session_with_capture(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> tuple[str, list[tuple[str, dict[str, Any]]]]:
    """Create a session and capture what the route publishes to its stream."""
    published: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(
        "omnigent.server.routes.sessions.session_stream.publish",
        lambda session_id, event: published.append((session_id, event)),
    )
    agent = await create_test_agent(client)
    resp = await client.post("/v1/sessions", json={"agent_id": agent["id"]})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"], published


async def test_suggestion_is_published_as_a_transient_session_suggestion(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The ranked prompts reach the stream as ``session.suggestion`` and nothing persists."""
    session_id, published = await _session_with_capture(client, monkeypatch)

    for data in (
        {"suggestion": "  Open a draft PR ", "suggestions": ["  Open a draft PR ", "Ship it"]},
        {"suggestion": "Run the tests"},
        {"suggestion": None, "suggestions": None},
    ):
        resp = await client.post(
            f"/v1/sessions/{session_id}/events",
            json={"type": "external_session_suggestion", "data": data},
        )
        assert resp.status_code == 202, resp.text
        assert resp.json() == {"queued": False}

    # The null post cleared what the earlier posts held.
    assert ae_session_suggestion.snapshot_for(session_id) == []
    assert published == [
        (
            session_id,
            {
                "type": "session.suggestion",
                "sequence_number": None,
                "conversation_id": session_id,
                "suggestion": "Open a draft PR",
                "suggestions": ["Open a draft PR", "Ship it"],
            },
        ),
        (
            session_id,
            {
                "type": "session.suggestion",
                "sequence_number": None,
                "conversation_id": session_id,
                "suggestion": "Run the tests",
                "suggestions": ["Run the tests"],
            },
        ),
        (
            session_id,
            {
                "type": "session.suggestion",
                "sequence_number": None,
                "conversation_id": session_id,
                "suggestion": None,
                "suggestions": None,
            },
        ),
    ]
    items = await client.get(f"/v1/sessions/{session_id}/items")
    assert items.status_code == 200, items.text
    assert items.json()["data"] == []


async def test_latest_suggestion_is_held_for_replay(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A post is held in memory and ``snapshot_for`` returns the newest event."""
    session_id, _ = await _session_with_capture(client, monkeypatch)

    assert ae_session_suggestion.snapshot_for(session_id) == []
    assert (await _post(client, session_id, {"suggestions": ["One", "Two"]})).status_code == 202
    assert (await _post(client, session_id, {"suggestion": "Newest"})).status_code == 202

    assert ae_session_suggestion.snapshot_for(session_id) == [
        {
            "type": "session.suggestion",
            "sequence_number": None,
            "conversation_id": session_id,
            "suggestion": "Newest",
            "suggestions": ["Newest"],
        }
    ]


async def test_suggestion_posted_while_running_is_published_but_not_held(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The web drops a guess that lands mid-turn, so the server does not replay it."""
    session_id, published = await _session_with_capture(client, monkeypatch)
    monkeypatch.setitem(_session_status_cache, session_id, "running")

    assert (await _post(client, session_id, {"suggestion": "Too late"})).status_code == 202

    assert len(published) == 1
    assert ae_session_suggestion.snapshot_for(session_id) == []


async def test_running_status_forgets_the_held_suggestion(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A new turn drops the guess even when no harness posts a clear (Codex)."""
    session_id, _ = await _session_with_capture(client, monkeypatch)
    assert (await _post(client, session_id, {"suggestion": "Stale soon"})).status_code == 202
    assert ae_session_suggestion.snapshot_for(session_id) != []

    session_helpers._publish_status(session_id, "running")

    assert ae_session_suggestion.snapshot_for(session_id) == []


async def test_guess_read_before_a_running_edge_is_not_stored() -> None:
    """A status read that began before ``forget`` ran must not store a stale guess."""
    observed_at = time.monotonic()
    ae_session_suggestion.forget("conv_race")

    ae_session_suggestion._remember("conv_race", {"conversation_id": "conv_race"}, observed_at)

    assert ae_session_suggestion.snapshot_for("conv_race") == []


async def test_held_suggestion_expires_after_six_hours(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    session_id, _ = await _session_with_capture(client, monkeypatch)
    assert (await _post(client, session_id, {"suggestion": "Old"})).status_code == 202
    assert ae_session_suggestion.snapshot_for(session_id) != []

    stored_at = ae_session_suggestion._latest[session_id][0]
    monkeypatch.setattr(
        ae_session_suggestion.time,
        "monotonic",
        lambda: stored_at + ae_session_suggestion._MAX_AGE_S + 1,
    )

    assert ae_session_suggestion.snapshot_for(session_id) == []
    assert session_id not in ae_session_suggestion._latest


async def test_held_suggestions_are_capped_oldest_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ae_session_suggestion, "_MAX_SESSIONS", 2)
    for sid in ("conv_a", "conv_b", "conv_c"):
        ae_session_suggestion._remember(sid, {"conversation_id": sid}, time.monotonic())

    assert ae_session_suggestion.snapshot_for("conv_a") == []
    assert ae_session_suggestion.snapshot_for("conv_b") != []
    assert ae_session_suggestion.snapshot_for("conv_c") != []


@pytest.mark.parametrize(
    "data",
    [
        {"suggestion": ""},
        {"suggestion": "   "},
        {"suggestion": 7},
        {"suggestion": "x" * 121},
        {"suggestion": "two\nlines"},
        {"suggestions": []},
        {"suggestions": "Open a PR"},
        {"suggestions": ["a", "b", "c", "d"]},
        {"suggestions": ["Open a PR", "x" * 121]},
        {"suggestions": ["Open a PR", "  "]},
    ],
)
async def test_suggestion_rejects_bad_shapes(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, data: dict[str, Any]
) -> None:
    """A bad guess (empty, mistyped, overlong, two lines) or list is a 400; nothing publishes."""
    session_id, published = await _session_with_capture(client, monkeypatch)

    resp = await client.post(
        f"/v1/sessions/{session_id}/events",
        json={"type": "external_session_suggestion", "data": data},
    )
    assert resp.status_code == 400, resp.text
    assert "external_session_suggestion" in resp.text
    assert published == []


async def test_suggestion_for_an_unknown_session_is_not_found(client: httpx.AsyncClient) -> None:
    """The event goes through the same session lookup as its siblings."""
    resp = await client.post(
        "/v1/sessions/conv_does_not_exist/events",
        json={"type": "external_session_suggestion", "data": {"suggestion": None}},
    )
    assert resp.status_code == 404, resp.text
