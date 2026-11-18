"""Archiving a session archives its side chats; Undo restores only those."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from omnigent.db.utils import generate_agent_id
from omnigent.server.routes import sessions as sessions_facade
from omnigent.server.routes._sessions import orchestration
from omnigent.server.routes.sessions.ae_side_chat_archive import (
    SIDE_CHAT_ARCHIVED_WITH_LABEL_KEY as MARKER,
)
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.conversation_store import SIDE_CHAT_LABEL_KEY, SIDE_CHAT_SOURCE_LABEL_KEY
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore

pytestmark = pytest.mark.asyncio


@pytest.fixture
def store_and_agent(db_uri: str) -> tuple[SqlAlchemyConversationStore, str]:
    agent_id = generate_agent_id()
    SqlAlchemyAgentStore(db_uri).create(agent_id, name="test", bundle_location="test:///bundle")
    return SqlAlchemyConversationStore(db_uri), agent_id


@pytest.fixture(autouse=True)
def _stub_stop() -> Iterator[AsyncMock]:
    stop = AsyncMock(return_value=True)
    with patch.object(sessions_facade, "_best_effort_stop", stop):
        yield stop


def _side_chat(store: SqlAlchemyConversationStore, source_id: str):
    return store.fork_conversation(
        source_id,
        extra_labels={SIDE_CHAT_LABEL_KEY: "1", SIDE_CHAT_SOURCE_LABEL_KEY: source_id},
    )


def _row(store: SqlAlchemyConversationStore, session_id: str):
    row = store.get_conversation(session_id)
    assert row is not None
    return row


async def _patch(client: httpx.AsyncClient, session_id: str, archived: bool) -> None:
    response = await client.patch(f"/v1/sessions/{session_id}", json={"archived": archived})
    assert response.status_code == 200, response.text


async def _drain() -> None:
    await asyncio.gather(*list(orchestration._detached_stop_tasks), return_exceptions=True)


async def test_archive_parent_archives_side_chats_and_undo_restores(
    client: httpx.AsyncClient,
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
) -> None:
    store, agent_id = store_and_agent
    parent = store.create_conversation(agent_id=agent_id)
    side_a = _side_chat(store, parent.id)
    side_b = _side_chat(store, parent.id)
    with patch.object(sessions_facade, "_ARCHIVE_STOP_UNDO_GRACE_S", 30.0):
        await _patch(client, parent.id, True)
        for side in (side_a, side_b):
            row = _row(store, side.id)
            assert row.archived is True
            assert row.labels[MARKER] == parent.id
            assert side.id in orchestration._pending_archive_stops
        await _patch(client, parent.id, False)
        for side in (side_a, side_b):
            row = _row(store, side.id)
            assert row.archived is False
            assert MARKER not in row.labels
            assert side.id not in orchestration._pending_archive_stops
        await _drain()


async def test_archive_stop_runs_for_side_chats(
    client: httpx.AsyncClient,
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
    _stub_stop: AsyncMock,
) -> None:
    store, agent_id = store_and_agent
    parent = store.create_conversation(agent_id=agent_id)
    side = _side_chat(store, parent.id)
    with patch.object(sessions_facade, "_ARCHIVE_STOP_UNDO_GRACE_S", 0.0):
        await _patch(client, parent.id, True)
        await _drain()
    stopped = {call.args[0] for call in _stub_stop.await_args_list}
    assert {parent.id, side.id} <= stopped


async def test_hand_archived_side_chat_stays_archived_after_undo(
    client: httpx.AsyncClient,
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
) -> None:
    store, agent_id = store_and_agent
    parent = store.create_conversation(agent_id=agent_id)
    by_hand = _side_chat(store, parent.id)
    other = _side_chat(store, parent.id)
    store.update_conversation_with_changes(by_hand.id, archived=True)
    with patch.object(sessions_facade, "_ARCHIVE_STOP_UNDO_GRACE_S", 30.0):
        await _patch(client, parent.id, True)
        assert MARKER not in _row(store, by_hand.id).labels
        assert _row(store, other.id).archived is True
        await _patch(client, parent.id, False)
        await _drain()
    assert _row(store, by_hand.id).archived is True
    assert _row(store, other.id).archived is False


async def test_nested_side_chats_archive_and_restore(
    client: httpx.AsyncClient,
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
) -> None:
    store, agent_id = store_and_agent
    parent = store.create_conversation(agent_id=agent_id)
    side = _side_chat(store, parent.id)
    nested = _side_chat(store, side.id)
    with patch.object(sessions_facade, "_ARCHIVE_STOP_UNDO_GRACE_S", 30.0):
        await _patch(client, parent.id, True)
        assert _row(store, nested.id).archived is True
        assert _row(store, nested.id).labels[MARKER] == parent.id
        await _patch(client, parent.id, False)
        await _drain()
    assert _row(store, side.id).archived is False
    assert _row(store, nested.id).archived is False
    assert MARKER not in _row(store, nested.id).labels


async def test_cross_replica_undo_skips_side_chat_teardown(
    client: httpx.AsyncClient,
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
    _stub_stop: AsyncMock,
) -> None:
    store, agent_id = store_and_agent
    parent = store.create_conversation(agent_id=agent_id)
    side = _side_chat(store, parent.id)
    with patch.object(sessions_facade, "_ARCHIVE_STOP_UNDO_GRACE_S", 1.5):
        await _patch(client, parent.id, True)
        # Another replica undoes through the store; this one's timers stay armed.
        store.update_conversation_with_changes(side.id, archived=False)
        store.update_conversation_with_changes(parent.id, archived=False)
        await _drain()
    stopped = {call.args[0] for call in _stub_stop.await_args_list}
    assert side.id not in stopped
    assert parent.id not in stopped


async def test_unrelated_sessions_are_untouched(
    client: httpx.AsyncClient,
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
) -> None:
    store, agent_id = store_and_agent
    parent = store.create_conversation(agent_id=agent_id)
    plain_fork = store.fork_conversation(parent.id)
    stranger = store.create_conversation(agent_id=agent_id)
    stranger_side = _side_chat(store, stranger.id)
    with patch.object(sessions_facade, "_ARCHIVE_STOP_UNDO_GRACE_S", 30.0):
        await _patch(client, parent.id, True)
        for untouched in (plain_fork, stranger, stranger_side):
            row = _row(store, untouched.id)
            assert row.archived is False
            assert MARKER not in row.labels
        await _patch(client, parent.id, False)
        await _drain()
