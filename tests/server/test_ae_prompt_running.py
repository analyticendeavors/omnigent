"""A prompt edge plus the first real work item flips a claude-native chat to running.

The Claude status file stays ``busy`` across a Stop while a background helper
lives, so the next turn publishes nothing. The server opens a prompt on the
forwarder's prompt edge and publishes ``running`` on the first assistant or
tool item; a Stop, failure or interrupt closes it.
"""

from __future__ import annotations

from collections.abc import Iterator

import httpx
import pytest

from omnigent.server import ae_prompt_running
from omnigent.server.ae_turn_edges import (
    TurnEdge,
    register_turn_edge_observer,
    reset_turn_edge_observers,
)
from omnigent.server.routes._sessions.helpers import _session_status_cache
from omnigent.server.routes.sessions import routes_events
from tests.server.helpers import create_test_agent

pytestmark = pytest.mark.timeout(30)


@pytest.fixture(autouse=True)
def _clean() -> Iterator[None]:
    reset_turn_edge_observers()
    ae_prompt_running.reset()
    yield
    reset_turn_edge_observers()
    ae_prompt_running.reset()


@pytest.fixture(autouse=True)
def _no_runner(monkeypatch: pytest.MonkeyPatch) -> None:
    async def forward(*args: object, **kwargs: object) -> dict[str, object]:
        return {}

    monkeypatch.setattr(routes_events, "_forward_session_change_to_runner", forward)


# ---- module ----


def test_take_if_open_returns_true_once() -> None:
    ae_prompt_running.note_prompt("s1")
    assert ae_prompt_running.take_if_open("s1") is True
    assert ae_prompt_running.take_if_open("s1") is False


def test_turn_end_clears_the_open_prompt() -> None:
    ae_prompt_running.note_prompt("s2")
    ae_prompt_running.note_turn_end("s2")
    assert ae_prompt_running.take_if_open("s2") is False


def test_map_is_bounded_and_drops_the_oldest() -> None:
    for i in range(ae_prompt_running.MAX_TRACKED_SESSIONS + 10):
        ae_prompt_running.note_prompt(f"b{i}")
    assert ae_prompt_running.take_if_open("b0") is False
    assert ae_prompt_running.take_if_open(f"b{ae_prompt_running.MAX_TRACKED_SESSIONS + 9}") is True


def test_only_assistant_text_and_tool_calls_are_real_work() -> None:
    assert ae_prompt_running.is_real_work("message", "assistant")
    assert ae_prompt_running.is_real_work("function_call")
    assert not ae_prompt_running.is_real_work("message", "user")
    assert not ae_prompt_running.is_real_work("resource_event")
    assert not ae_prompt_running.is_real_work("compaction")


# ---- route ----


async def _session(client: httpx.AsyncClient, name: str) -> str:
    agent = await create_test_agent(client, name=name)
    created = await client.post("/v1/sessions", json={"agent_id": agent["id"]})
    assert created.status_code == 201, created.text
    return created.json()["id"]


async def _post(client: httpx.AsyncClient, sid: str, payload: object) -> None:
    resp = await client.post(f"/v1/sessions/{sid}/events", json=payload)
    assert resp.status_code in (200, 202, 204), resp.text


async def _prompt(client: httpx.AsyncClient, sid: str) -> None:
    await _post(
        client,
        sid,
        {"type": "external_session_status", "data": {"status": "running", "ae_prompt_edge": True}},
    )


def _assistant_item(text: str = "hi", source: str = "a1") -> dict[str, object]:
    return {
        "type": "external_conversation_item",
        "data": {
            "item_type": "message",
            "item_data": {
                "role": "assistant",
                "agent": "claude",
                "content": [{"type": "output_text", "text": text}],
            },
            "source_id": source,
        },
    }


def _tool_item(source: str = "t1") -> dict[str, object]:
    return {
        "type": "external_conversation_item",
        "data": {
            "item_type": "function_call",
            "item_data": {
                "agent": "claude",
                "name": "Bash",
                "arguments": "{}",
                "call_id": f"call_{source}",
            },
            "source_id": source,
        },
    }


def _user_item(source: str = "u1") -> dict[str, object]:
    return {
        "type": "external_conversation_item",
        "data": {
            "item_type": "message",
            "item_data": {"role": "user", "content": [{"type": "input_text", "text": "x"}]},
            "source_id": source,
        },
    }


def _stop() -> dict[str, object]:
    return {
        "type": "external_session_status",
        "data": {"status": "idle", "turn_completed": True},
    }


async def test_prompt_then_assistant_item_publishes_running(client: httpx.AsyncClient) -> None:
    sid = await _session(client, "pr-assistant")
    _session_status_cache[sid] = "idle"
    seen: list[TurnEdge] = []
    register_turn_edge_observer(seen.append)

    await _prompt(client, sid)
    assert _session_status_cache.get(sid) == "idle"
    await _post(client, sid, _assistant_item())

    assert _session_status_cache.get(sid) == "running"
    assert "running" in [e.status for e in seen if e.session_id == sid]


async def test_batched_tool_item_publishes_running(client: httpx.AsyncClient) -> None:
    sid = await _session(client, "pr-batch")
    _session_status_cache[sid] = "idle"
    await _prompt(client, sid)
    await _post(client, sid, [_tool_item()])
    assert _session_status_cache.get(sid) == "running"


async def test_user_item_leaves_the_chat_idle(client: httpx.AsyncClient) -> None:
    sid = await _session(client, "pr-user")
    _session_status_cache[sid] = "idle"
    await _prompt(client, sid)
    await _post(client, sid, _user_item())
    assert _session_status_cache.get(sid) == "idle"


async def test_late_items_after_stop_stay_idle(client: httpx.AsyncClient) -> None:
    sid = await _session(client, "pr-late")
    _session_status_cache[sid] = "idle"
    await _prompt(client, sid)
    await _post(client, sid, _stop())
    await _post(client, sid, _assistant_item("late", "late1"))
    assert _session_status_cache.get(sid) == "idle"


async def test_already_running_publishes_nothing_new(client: httpx.AsyncClient) -> None:
    sid = await _session(client, "pr-running")
    _session_status_cache[sid] = "running"
    await _prompt(client, sid)
    seen: list[TurnEdge] = []
    register_turn_edge_observer(seen.append)
    await _post(client, sid, _assistant_item())
    assert [e for e in seen if e.session_id == sid] == []


async def test_failed_clears_the_open_prompt(client: httpx.AsyncClient) -> None:
    sid = await _session(client, "pr-failed")
    _session_status_cache[sid] = "idle"
    await _prompt(client, sid)
    await _post(client, sid, {"type": "external_session_status", "data": {"status": "failed"}})
    _session_status_cache[sid] = "idle"
    await _post(client, sid, _assistant_item())
    assert _session_status_cache.get(sid) == "idle"


async def test_interrupt_clears_the_open_prompt(client: httpx.AsyncClient) -> None:
    sid = await _session(client, "pr-int")
    _session_status_cache[sid] = "idle"
    await _prompt(client, sid)
    await _post(client, sid, {"type": "stop_session", "data": {}})
    assert ae_prompt_running.take_if_open(sid) is False
