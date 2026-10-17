"""Tests for the transient ``external_session_progress`` session event."""

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


async def test_progress_is_published_as_a_transient_session_progress(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The spinner line reaches the stream as ``session.progress`` and nothing persists."""
    session_id, published = await _session_with_capture(client, monkeypatch)

    resp = await client.post(
        f"/v1/sessions/{session_id}/events",
        json={
            "type": "external_session_progress",
            "data": {
                "label": "Crunching",
                "elapsed": "4m 42s",
                "elapsed_s": 282,
                "tokens": "24.5k tokens",
            },
        },
    )
    assert resp.status_code == 202, resp.text
    assert resp.json() == {"queued": False}
    assert published == [
        (
            session_id,
            {
                "type": "session.progress",
                "sequence_number": None,
                "conversation_id": session_id,
                "label": "Crunching",
                "elapsed": "4m 42s",
                "elapsed_s": 282,
                "tokens": "24.5k tokens",
            },
        )
    ]
    items = await client.get(f"/v1/sessions/{session_id}/items")
    assert items.status_code == 200, items.text
    assert items.json()["data"] == []


async def test_progress_clear_and_optional_tokens(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A null label clears the line, and tokens may be left out."""
    session_id, published = await _session_with_capture(client, monkeypatch)

    for data in ({"label": "Thinking", "elapsed": "12s"}, {"label": None}):
        resp = await client.post(
            f"/v1/sessions/{session_id}/events",
            json={"type": "external_session_progress", "data": data},
        )
        assert resp.status_code == 202, resp.text

    assert [(e["label"], e["elapsed"], e["elapsed_s"], e["tokens"]) for _, e in published] == [
        ("Thinking", "12s", None, None),
        (None, None, None, None),
    ]


@pytest.mark.parametrize(
    "data",
    [
        {"label": "Crunching"},
        {"label": 7, "elapsed": "12s"},
        {"label": "", "elapsed": "12s"},
        {"label": "x" * 41, "elapsed": "12s"},
        {"label": "Crunching", "elapsed": "1" * 21},
        {"label": "Crunching", "elapsed": "12s", "tokens": "9" * 31},
        {"label": "Crunching", "elapsed": "12s", "tokens": 12},
        {"label": "Crunching", "elapsed": "12s", "elapsed_s": -1},
        {"label": "Crunching", "elapsed": "12s", "elapsed_s": "12"},
        {"label": "Crunching", "elapsed": "12s", "elapsed_s": True},
        {"label": "Crunching", "elapsed": "12s", "elapsed_s": 7 * 24 * 3600 + 1},
    ],
)
async def test_progress_rejects_bad_shapes(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, data: dict[str, Any]
) -> None:
    """A missing, mistyped or overlong field is a 400 and publishes nothing."""
    session_id, published = await _session_with_capture(client, monkeypatch)

    resp = await client.post(
        f"/v1/sessions/{session_id}/events",
        json={"type": "external_session_progress", "data": data},
    )
    assert resp.status_code == 400, resp.text
    assert "external_session_progress" in resp.text
    assert published == []


async def test_progress_for_an_unknown_session_is_not_found(client: httpx.AsyncClient) -> None:
    """The event goes through the same session lookup as its siblings."""
    resp = await client.post(
        "/v1/sessions/conv_does_not_exist/events",
        json={"type": "external_session_progress", "data": {"label": None}},
    )
    assert resp.status_code == 404, resp.text
