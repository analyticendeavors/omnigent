"""The item-observers registry and its two call sites.

``omnigent.server.item_observers`` lets out-of-tree code read conversation
items the server persists for a harness. Both call sites are covered: the
native transcript bridge (``external_conversation_item`` through the real
app) and the runner relay's assistant text flush (``_flush_relay_text``
against a stub store). The contract under test: every observer sees every
persisted item exactly once, a deduplicated re-post notifies nobody, and an
observer that raises is logged and never fails the request.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from omnigent.entities import Conversation, ConversationItem
from omnigent.server import item_observers
from omnigent.server.item_observers import (
    drain_item_observers,
    notify_items_persisted,
    register_item_observer,
    registered_item_observers,
    reset_item_observers,
    unregister_item_observer,
)
from omnigent.server.routes._sessions.helpers import _flush_relay_text
from tests.server.helpers import create_test_agent


@pytest.fixture(autouse=True)
def _clean_registry() -> Iterator[None]:
    reset_item_observers()
    yield
    reset_item_observers()


class _Recorder:
    """A sync observer that records every batch it is handed."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, list[ConversationItem]]] = []

    def __call__(self, session_id: str, items: Sequence[ConversationItem]) -> None:
        self.calls.append((session_id, list(items)))


def _item(index: int, text: str, role: str = "assistant") -> ConversationItem:
    return ConversationItem(
        id=f"item_{index}",
        type="message",
        status="completed",
        response_id="resp_1",
        created_at=1,
        data={
            "role": role,
            "content": [{"type": "output_text", "text": text}],
            **({"agent": "worker"} if role == "assistant" else {}),
        },
    )


# ── The registry ─────────────────────────────────────────────────────


async def test_sync_and_async_observers_each_see_the_batch() -> None:
    sync_seen = _Recorder()
    async_seen: list[tuple[str, list[ConversationItem]]] = []

    async def async_observer(session_id: str, items: Sequence[ConversationItem]) -> None:
        async_seen.append((session_id, list(items)))

    register_item_observer(sync_seen)
    register_item_observer(async_observer)
    items = [_item(1, "one"), _item(2, "two")]

    notify_items_persisted("conv_a", items)
    await drain_item_observers()

    assert sync_seen.calls == [("conv_a", items)]
    assert async_seen == [("conv_a", items)]


async def test_registration_is_idempotent_and_reversible() -> None:
    seen = _Recorder()
    register_item_observer(seen)
    register_item_observer(seen)
    assert registered_item_observers() == [seen]

    notify_items_persisted("conv_a", [_item(1, "once")])
    await drain_item_observers()
    assert len(seen.calls) == 1

    unregister_item_observer(seen)
    unregister_item_observer(seen)
    assert registered_item_observers() == []
    notify_items_persisted("conv_a", [_item(2, "never")])
    await drain_item_observers()
    assert len(seen.calls) == 1


async def test_empty_batch_notifies_nobody() -> None:
    seen = _Recorder()
    register_item_observer(seen)
    notify_items_persisted("conv_a", [])
    await drain_item_observers()
    assert seen.calls == []


async def test_a_failing_observer_is_logged_and_the_others_still_run(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def broken(session_id: str, items: Sequence[ConversationItem]) -> None:
        raise RuntimeError("observer exploded")

    async def broken_async(session_id: str, items: Sequence[ConversationItem]) -> None:
        raise RuntimeError("async observer exploded")

    seen = _Recorder()
    register_item_observer(broken)
    register_item_observer(broken_async)
    register_item_observer(seen)

    with caplog.at_level(logging.ERROR, logger=item_observers.__name__):
        notify_items_persisted("conv_a", [_item(1, "still delivered")])
        await drain_item_observers()

    assert [call[0] for call in seen.calls] == ["conv_a"]
    messages = [record.getMessage() for record in caplog.records]
    assert any("broken failed for session=conv_a" in m for m in messages)
    assert any("broken_async failed for session=conv_a" in m for m in messages)


async def test_a_sync_observer_runs_off_the_event_loop() -> None:
    """Store I/O in an observer must not block the loop that serves requests."""
    loop_thread: list[bool] = []
    main_thread = asyncio.get_running_loop()

    def observer(session_id: str, items: Sequence[ConversationItem]) -> None:
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        loop_thread.append(running is main_thread)

    register_item_observer(observer)
    notify_items_persisted("conv_a", [_item(1, "x")])
    await drain_item_observers()
    assert loop_thread == [False]


def test_outside_an_event_loop_observers_are_skipped(
    caplog: pytest.LogCaptureFixture,
) -> None:
    seen = _Recorder()
    register_item_observer(seen)
    with caplog.at_level(logging.WARNING, logger=item_observers.__name__):
        notify_items_persisted("conv_a", [_item(1, "x")])
    assert seen.calls == []
    assert any("outside an event loop" in r.getMessage() for r in caplog.records)


# ── Call site: the native transcript bridge ──────────────────────────


async def _create_session(client: httpx.AsyncClient, name: str) -> str:
    agent = await create_test_agent(client, name=name)
    resp = await client.post("/v1/sessions", json={"agent_id": agent["id"]})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _post_item(
    client: httpx.AsyncClient,
    session_id: str,
    *,
    text: str,
    role: str = "assistant",
    source_id: str | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "item_type": "message",
        "item_data": {
            "role": role,
            "content": [
                {"type": "output_text" if role == "assistant" else "input_text", "text": text}
            ],
            **({"agent": "worker"} if role == "assistant" else {}),
        },
        "response_id": "resp_claude_echo",
    }
    if source_id is not None:
        data["source_id"] = source_id
    resp = await client.post(
        f"/v1/sessions/{session_id}/events",
        json={"type": "external_conversation_item", "data": data},
    )
    assert resp.status_code in (200, 201, 202), resp.text
    return resp.json()


async def test_external_conversation_items_reach_observers(client: httpx.AsyncClient) -> None:
    seen = _Recorder()
    register_item_observer(seen)
    session_id = await _create_session(client, "observed")

    user = await _post_item(client, session_id, text="fix the padding", role="user")
    assistant = await _post_item(client, session_id, text="FORK: build the testimonials section")
    await drain_item_observers()

    assert [sid for sid, _ in seen.calls] == [session_id, session_id]
    delivered = [item for _, items in seen.calls for item in items]
    assert [item.id for item in delivered] == [user["item_id"], assistant["item_id"]]
    assert delivered[1].data.role == "assistant"
    assert delivered[1].data.content[0]["text"] == "FORK: build the testimonials section"


async def test_a_deduplicated_repost_notifies_nobody(client: httpx.AsyncClient) -> None:
    seen = _Recorder()
    register_item_observer(seen)
    session_id = await _create_session(client, "observed-idempotent")

    first = await _post_item(client, session_id, text="same", source_id="rec-1:0:message")
    second = await _post_item(client, session_id, text="same", source_id="rec-1:0:message")
    await drain_item_observers()

    assert first["item_id"] == second["item_id"]
    assert len(seen.calls) == 1


async def test_a_failing_observer_never_fails_the_request(
    client: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    def broken(session_id: str, items: Sequence[ConversationItem]) -> None:
        raise RuntimeError("observer exploded")

    register_item_observer(broken)
    session_id = await _create_session(client, "observed-broken")
    with caplog.at_level(logging.ERROR, logger=item_observers.__name__):
        posted = await _post_item(client, session_id, text="persisted anyway")
        await drain_item_observers()

    items = (await client.get(f"/v1/sessions/{session_id}/items")).json()["data"]
    assert [item["id"] for item in items if item["type"] == "message"] == [posted["item_id"]]
    assert any("broken failed" in r.getMessage() for r in caplog.records)


# ── Call site: the runner relay's text flush ─────────────────────────


@dataclass
class _FakeConversationStore:
    """The stub ``test_relay_output_policy_deny.py`` uses, trimmed to what the flush needs."""

    appended: list[Any] = field(default_factory=list)

    def get_conversation(self, conversation_id: str) -> Conversation:
        return Conversation(
            id=conversation_id,
            created_at=1,
            updated_at=1,
            root_conversation_id=conversation_id,
            agent_id="ag_test",
        )

    def append(self, conversation_id: str, items: list[Any]) -> list[ConversationItem]:
        result = []
        for index, item in enumerate(items):
            self.appended.append(item)
            result.append(
                ConversationItem(
                    id=f"item_{len(self.appended)}_{index}",
                    type=item.type,
                    response_id=item.response_id,
                    data=item.data,
                    created_at=1,
                    status="completed",
                )
            )
        return result


async def test_relay_flush_notifies_with_the_persisted_segment() -> None:
    seen = _Recorder()
    register_item_observer(seen)
    store = _FakeConversationStore()
    text_acc = ["Absorbed: bumped the CTA radius, ", "same file already open."]

    await _flush_relay_text(store, "conv_relay", text_acc, "resp_1", "test-agent")  # type: ignore[arg-type]
    await drain_item_observers()

    assert not text_acc
    assert len(seen.calls) == 1
    session_id, items = seen.calls[0]
    assert session_id == "conv_relay"
    assert [item.id for item in items] == [store.appended and "item_1_0"]
    assert items[0].data.role == "assistant"
    assert items[0].data.content[0]["text"] == (
        "Absorbed: bumped the CTA radius, same file already open."
    )


async def test_relay_flush_skips_observers_when_nothing_persists() -> None:
    seen = _Recorder()
    register_item_observer(seen)
    store = _FakeConversationStore()

    await _flush_relay_text(store, "conv_relay", ["   \n"], "resp_1", "test-agent")  # type: ignore[arg-type]
    await _flush_relay_text(None, "conv_relay", ["dropped"], "resp_1", "test-agent")
    await drain_item_observers()

    assert store.appended == []
    assert seen.calls == []
