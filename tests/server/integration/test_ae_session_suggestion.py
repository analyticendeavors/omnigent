"""Tests for the transient ``external_session_suggestion`` session event."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from tests.server.helpers import create_test_agent

pytestmark = pytest.mark.asyncio


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
    """The predicted prompt reaches the stream as ``session.suggestion`` and nothing persists."""
    session_id, published = await _session_with_capture(client, monkeypatch)

    for data in ({"suggestion": "  Open a draft PR "}, {"suggestion": None}):
        resp = await client.post(
            f"/v1/sessions/{session_id}/events",
            json={"type": "external_session_suggestion", "data": data},
        )
        assert resp.status_code == 202, resp.text
        assert resp.json() == {"queued": False}

    assert published == [
        (
            session_id,
            {
                "type": "session.suggestion",
                "sequence_number": None,
                "conversation_id": session_id,
                "suggestion": "Open a draft PR",
            },
        ),
        (
            session_id,
            {
                "type": "session.suggestion",
                "sequence_number": None,
                "conversation_id": session_id,
                "suggestion": None,
            },
        ),
    ]
    items = await client.get(f"/v1/sessions/{session_id}/items")
    assert items.status_code == 200, items.text
    assert items.json()["data"] == []


@pytest.mark.parametrize(
    "data",
    [
        {"suggestion": ""},
        {"suggestion": "   "},
        {"suggestion": 7},
        {"suggestion": "x" * 121},
        {"suggestion": "two\nlines"},
    ],
)
async def test_suggestion_rejects_bad_shapes(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, data: dict[str, Any]
) -> None:
    """An empty, mistyped, overlong or multi-line suggestion is a 400 and publishes nothing."""
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
