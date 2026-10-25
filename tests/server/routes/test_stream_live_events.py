"""Unit tests for :func:`_stream_live_events` disconnect / completion cleanup.

Pins the contract that ``finally`` is cleanup-only (presence + nested
subscriber teardown) and that ``data: [DONE]`` is emitted only on
normal stream completion — never during ``aclose`` / ``GeneratorExit``.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from omnigent.runtime import session_stream
from omnigent.server import presence, shutdown_state
from omnigent.server.routes._sessions import ae_session_suggestion
from omnigent.server.routes.sessions import _stream_live_events

pytestmark = pytest.mark.asyncio

SESSION_ID = "conv_stream_live_aclose"
USER_ID = "alice@example.com"


class _ConnectedRequest:
    """Minimal request stand-in: client stays connected."""

    async def is_disconnected(self) -> bool:
        return False


@pytest.fixture(autouse=True)
def _reset_presence_and_subscribers() -> Any:
    """Isolate module-global presence + session_stream state per test."""
    presence.reset_for_tests()
    shutdown_state.reset_for_tests()
    ae_session_suggestion.reset_for_tests()
    session_stream._subscribers.clear()
    yield
    presence.reset_for_tests()
    shutdown_state.reset_for_tests()
    session_stream._subscribers.clear()


async def test_aclose_cleans_presence_and_subscribers_without_runtime_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Client ``aclose`` must not raise, and must tear down presence + slots.

    Regression: yielding ``[DONE]`` from the generator ``finally`` during
    ``aclose`` raised ``RuntimeError: async generator ignored GeneratorExit``,
    which could skip or obscure cleanup.
    """
    monkeypatch.setattr(presence, "_LEAVE_GRACE_S", 0.05)

    gen = _stream_live_events(
        _ConnectedRequest(),  # type: ignore[arg-type]
        SESSION_ID,
        viewer_user_id=USER_ID,
        viewer_idle=False,
        presence_root_id=SESSION_ID,
    )
    # Ready heartbeat proves the subscribe slot is registered before aclose.
    first = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
    assert "session.heartbeat" in first
    assert SESSION_ID in session_stream._subscribers
    assert [v["user_id"] for v in presence.snapshot(SESSION_ID, SESSION_ID)["viewers"]] == [
        USER_ID
    ]

    # Direct close — the path StreamingResponse takes on client disconnect.
    await gen.aclose()

    assert SESSION_ID not in session_stream._subscribers, (
        "subscribe finally must drop the subscriber slot on aclose"
    )
    # Disconnect schedules leave after grace; wait past the shrunken window.
    for _ in range(50):
        if presence.snapshot(SESSION_ID, SESSION_ID)["viewers"] == []:
            break
        await asyncio.sleep(0.02)
    assert presence.snapshot(SESSION_ID, SESSION_ID)["viewers"] == [], (
        "presence.disconnect in finally must clear the viewer after grace"
    )


async def test_server_shutdown_ends_stream_without_done_for_browser_reconnect() -> None:
    gen = _stream_live_events(
        _ConnectedRequest(),  # type: ignore[arg-type]
        SESSION_ID,
    )
    assert "session.heartbeat" in await asyncio.wait_for(gen.__anext__(), timeout=2.0)
    assert SESSION_ID in session_stream._subscribers

    shutdown_state.mark_server_shutting_down()
    session_stream.shutdown_all()
    assert [frame async for frame in gen] == []
    assert SESSION_ID not in session_stream._subscribers


async def test_normal_completion_emits_done_and_cleans_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Subscribe end-of-stream still yields ``[DONE]`` then cleans up."""
    monkeypatch.setattr(presence, "_LEAVE_GRACE_S", 0.05)

    gen = _stream_live_events(
        _ConnectedRequest(),  # type: ignore[arg-type]
        SESSION_ID,
        viewer_user_id=USER_ID,
        viewer_idle=False,
        presence_root_id=SESSION_ID,
    )
    first = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
    assert "session.heartbeat" in first
    assert SESSION_ID in session_stream._subscribers

    session_stream.close(SESSION_ID)
    chunks: list[str] = []
    async for chunk in gen:
        chunks.append(chunk)

    assert chunks[-1] == "data: [DONE]\n\n", (
        f"normal completion must emit [DONE]; got trailing {chunks[-1]!r}"
    )
    assert SESSION_ID not in session_stream._subscribers
    for _ in range(50):
        if presence.snapshot(SESSION_ID, SESSION_ID)["viewers"] == []:
            break
        await asyncio.sleep(0.02)
    assert presence.snapshot(SESSION_ID, SESSION_ID)["viewers"] == []


def _suggestion_event(suggestion: str | None) -> dict[str, Any]:
    return {
        "type": "session.suggestion",
        "sequence_number": None,
        "conversation_id": SESSION_ID,
        "suggestion": suggestion,
        "suggestions": None if suggestion is None else [suggestion],
    }


async def test_held_suggestion_is_replayed_after_ready_before_live_events() -> None:
    """A new subscriber gets the held guess after the heartbeat; a later clear follows it."""
    ae_session_suggestion._remember(SESSION_ID, _suggestion_event("Open a PR"), time.monotonic())

    gen = _stream_live_events(
        _ConnectedRequest(),  # type: ignore[arg-type]
        SESSION_ID,
    )
    try:
        assert "session.heartbeat" in await asyncio.wait_for(gen.__anext__(), timeout=2.0)
        replay = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
        assert "session.suggestion" in replay
        assert "Open a PR" in replay

        session_stream.publish(SESSION_ID, _suggestion_event("Second guess"))
        later = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
        assert "Second guess" in later

        session_stream.publish(SESSION_ID, _suggestion_event(None))
        cleared = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
        assert "session.suggestion" in cleared
        assert '"suggestion": null' in cleared or '"suggestion":null' in cleared
    finally:
        await gen.aclose()


async def test_no_held_suggestion_means_no_extra_frame() -> None:
    """Without a held guess the first frame after the heartbeat is the next live event."""
    gen = _stream_live_events(
        _ConnectedRequest(),  # type: ignore[arg-type]
        SESSION_ID,
    )
    try:
        assert "session.heartbeat" in await asyncio.wait_for(gen.__anext__(), timeout=2.0)
        session_stream.publish(SESSION_ID, _suggestion_event("Live one"))
        frame = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
        assert "Live one" in frame
    finally:
        await gen.aclose()
