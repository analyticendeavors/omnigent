"""Archiving a session archives its side chats; Undo restores only those."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import pytest_asyncio

from omnigent.db.utils import generate_agent_id
from omnigent.server.auth import LEVEL_OWNER, LEVEL_READ, UnifiedAuthProvider
from omnigent.server.routes import sessions as sessions_facade
from omnigent.server.routes._sessions import orchestration
from omnigent.server.routes.sessions import ae_side_chat_archive
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


# -- review fixes (patch 0388) ---------------------------------------------------------------

ALICE = "alice@example.com"
BOB = "bob@example.com"


def _as(user: str) -> dict[str, str]:
    return {"X-Forwarded-Email": user}


@pytest_asyncio.fixture()
async def multi_user(
    runtime_init: None, db_uri: str, tmp_path: Path
) -> AsyncIterator[tuple[httpx.AsyncClient, SqlAlchemyConversationStore, str, object]]:
    """Header-auth app with a permission store: (client, conversations, agent id, grants)."""
    from omnigent.runtime.agent_cache import AgentCache
    from omnigent.server.app import create_app
    from omnigent.stores.artifact_store.local import LocalArtifactStore
    from omnigent.stores.comment_store.sqlalchemy_store import SqlAlchemyCommentStore
    from omnigent.stores.file_store.sqlalchemy_store import SqlAlchemyFileStore
    from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore

    agent_id = generate_agent_id()
    SqlAlchemyAgentStore(db_uri).create(agent_id, name="test", bundle_location="test:///bundle")
    conversations = SqlAlchemyConversationStore(db_uri)
    grants = SqlAlchemyPermissionStore(db_uri)
    artifacts = LocalArtifactStore(str(tmp_path / "artifacts"))
    app = create_app(
        agent_store=SqlAlchemyAgentStore(db_uri),
        file_store=SqlAlchemyFileStore(db_uri),
        conversation_store=conversations,
        artifact_store=artifacts,
        agent_cache=AgentCache(artifact_store=artifacts, cache_dir=tmp_path / "cache"),
        comment_store=SqlAlchemyCommentStore(db_uri),
        permission_store=grants,
        auth_provider=UnifiedAuthProvider(source="header", local_single_user=False),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c, conversations, agent_id, grants


async def test_a_side_chat_the_caller_does_not_own_is_left_alone(
    multi_user: tuple[httpx.AsyncClient, SqlAlchemyConversationStore, str, object],
) -> None:
    client, store, agent_id, grants = multi_user
    root = store.create_conversation(agent_id=agent_id)
    grants.grant(ALICE, root.id, LEVEL_OWNER)
    grants.grant(BOB, root.id, LEVEL_READ)
    bobs = _side_chat(store, root.id)
    grants.grant(BOB, bobs.id, LEVEL_OWNER)
    alices = _side_chat(store, root.id)
    grants.grant(ALICE, alices.id, LEVEL_OWNER)
    with patch.object(sessions_facade, "_ARCHIVE_STOP_UNDO_GRACE_S", 30.0):
        resp = await client.patch(
            f"/v1/sessions/{root.id}", json={"archived": True}, headers=_as(ALICE)
        )
        assert resp.status_code == 200, resp.text
        assert _row(store, alices.id).archived is True
        assert _row(store, bobs.id).archived is False
        assert MARKER not in _row(store, bobs.id).labels
        # Bob's own chat archived by Bob stays archived through Alice's Undo.
        store.update_conversation_with_changes(bobs.id, archived=True)
        store.set_labels(bobs.id, {MARKER: root.id})
        resp = await client.patch(
            f"/v1/sessions/{root.id}", json={"archived": False}, headers=_as(ALICE)
        )
        assert resp.status_code == 200, resp.text
        await _drain()
    assert _row(store, alices.id).archived is False
    assert _row(store, bobs.id).archived is True
    assert _row(store, bobs.id).labels[MARKER] == root.id


async def test_the_archived_with_label_is_server_internal(
    client: httpx.AsyncClient,
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
) -> None:
    store, agent_id = store_and_agent
    session = store.create_conversation(agent_id=agent_id)
    resp = await client.patch(f"/v1/sessions/{session.id}", json={"labels": {MARKER: "x"}})
    assert resp.status_code == 400
    assert MARKER not in _row(store, session.id).labels
    from omnigent.server.routes._sessions.helpers import _reject_server_reserved_label_seed

    with pytest.raises(Exception, match="server-internal"):
        _reject_server_reserved_label_seed({MARKER: "x"})


async def test_undo_landing_mid_cascade_leaves_no_side_chat_archived(
    client: httpx.AsyncClient,
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
) -> None:
    store, agent_id = store_and_agent
    parent = store.create_conversation(agent_id=agent_id)
    sides = [_side_chat(store, parent.id) for _ in range(3)]
    real = ae_side_chat_archive._archive_one
    calls = 0

    def undo_after_first(*args, **kwargs):
        nonlocal calls
        result = real(*args, **kwargs)
        calls += 1
        if calls == 1:
            store.update_conversation_with_changes(parent.id, archived=False)
        return result

    with (
        patch.object(sessions_facade, "_ARCHIVE_STOP_UNDO_GRACE_S", 30.0),
        patch.object(ae_side_chat_archive, "_archive_one", undo_after_first),
    ):
        await _patch(client, parent.id, True)
        # The route's own write set the flag; the other replica then undid it.
        store.update_conversation_with_changes(parent.id, archived=False)
        await _drain()
    for side in sides:
        row = _row(store, side.id)
        assert row.archived is False
        assert MARKER not in row.labels
        assert side.id not in orchestration._pending_archive_stops


async def test_a_failed_flag_write_removes_the_marker(
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
) -> None:
    store, agent_id = store_and_agent
    parent = store.create_conversation(agent_id=agent_id)
    side = _side_chat(store, parent.id)

    def boom(*_a, **_k):
        raise RuntimeError("write failed")

    with (
        patch.object(store, "update_conversation_with_changes", boom),
        pytest.raises(RuntimeError),
    ):
        ae_side_chat_archive._archive_one(store, side.id, parent.id, None)
    row = _row(store, side.id)
    assert row.archived is False
    assert MARKER not in row.labels


async def test_the_walk_goes_through_hand_archived_and_hand_restored_chats(
    client: httpx.AsyncClient,
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
) -> None:
    store, agent_id = store_and_agent
    root = store.create_conversation(agent_id=agent_id)
    side = _side_chat(store, root.id)
    nested = _side_chat(store, side.id)
    store.update_conversation_with_changes(side.id, archived=True)
    with patch.object(sessions_facade, "_ARCHIVE_STOP_UNDO_GRACE_S", 30.0):
        await _patch(client, root.id, True)
        assert _row(store, nested.id).archived is True
        assert MARKER not in _row(store, side.id).labels
        await _patch(client, root.id, False)
        assert _row(store, nested.id).archived is False
        # Second round: archive, hand-restore the middle chat, then Undo.
        await _patch(client, root.id, True)
        assert _row(store, side.id).archived is True  # archived by the cascade this time
        await _patch(client, side.id, False)
        assert _row(store, nested.id).archived is True
        await _patch(client, root.id, False)
        await _drain()
    assert _row(store, nested.id).archived is False
    assert MARKER not in _row(store, nested.id).labels


async def test_unarchiving_a_side_chat_directly_clears_its_marker(
    client: httpx.AsyncClient,
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
) -> None:
    store, agent_id = store_and_agent
    parent = store.create_conversation(agent_id=agent_id)
    side = _side_chat(store, parent.id)
    with patch.object(sessions_facade, "_ARCHIVE_STOP_UNDO_GRACE_S", 30.0):
        await _patch(client, parent.id, True)
        assert _row(store, side.id).labels[MARKER] == parent.id
        await _patch(client, side.id, False)
        await _drain()
    assert _row(store, side.id).archived is False
    assert MARKER not in _row(store, side.id).labels


async def test_side_chat_stops_never_delete_the_worktree(
    client: httpx.AsyncClient,
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
) -> None:
    store, agent_id = store_and_agent
    parent = store.create_conversation(agent_id=agent_id)
    side = _side_chat(store, parent.id)
    seen: dict[str, object] = {}
    real = orchestration._spawn_archive_stop

    def spy(session_id, *args, **kwargs):
        seen[session_id] = kwargs.get("delete_worktree")
        return real(session_id, *args, **kwargs)

    with (
        patch.object(sessions_facade, "_ARCHIVE_STOP_UNDO_GRACE_S", 0.0),
        patch.object(orchestration, "_spawn_archive_stop", spy),
    ):
        await _patch(client, parent.id, True)
        await _drain()
    assert seen[side.id] is False


async def test_a_failed_side_chat_still_lets_the_walk_reach_its_children(
    client: httpx.AsyncClient,
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
) -> None:
    store, agent_id = store_and_agent
    root = store.create_conversation(agent_id=agent_id)
    side = _side_chat(store, root.id)
    nested = _side_chat(store, side.id)
    real_archive = ae_side_chat_archive._archive_one
    real_restore = ae_side_chat_archive._restore_one

    def archive_fails_on_side(store_, side_id, *rest):
        if side_id == side.id:
            raise RuntimeError("store blip")
        return real_archive(store_, side_id, *rest)

    def restore_fails_on_side(store_, side_id, *rest):
        if side_id == side.id:
            raise RuntimeError("store blip")
        return real_restore(store_, side_id, *rest)

    with patch.object(sessions_facade, "_ARCHIVE_STOP_UNDO_GRACE_S", 30.0):
        with patch.object(ae_side_chat_archive, "_archive_one", archive_fails_on_side):
            await _patch(client, root.id, True)
        assert _row(store, side.id).archived is False
        assert _row(store, nested.id).archived is True
        assert _row(store, nested.id).labels.get(MARKER) == root.id
        with patch.object(ae_side_chat_archive, "_restore_one", restore_fails_on_side):
            await _patch(client, root.id, False)
        await _drain()
    assert _row(store, nested.id).archived is False
    assert MARKER not in _row(store, nested.id).labels


async def test_a_side_chat_of_an_archived_session_is_refused(
    client: httpx.AsyncClient,
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
) -> None:
    store, agent_id = store_and_agent
    parent = store.create_conversation(agent_id=agent_id)
    store.update_conversation_with_changes(parent.id, archived=True)
    response = await client.post(f"/v1/sessions/{parent.id}/fork", json={"side_chat": True})
    assert response.status_code == 400, response.text
    assert "Unarchive it to open a side chat" in response.text
    assert ae_side_chat_archive.side_chat_ids(store, parent.id) == []


def test_the_refusal_applies_only_to_side_chats_of_archived_sessions(
    store_and_agent: tuple[SqlAlchemyConversationStore, str],
) -> None:
    store, agent_id = store_and_agent
    live = store.create_conversation(agent_id=agent_id)
    gone = store.create_conversation(agent_id=agent_id)
    store.update_conversation_with_changes(gone.id, archived=True)
    ae_side_chat_archive.refuse_side_chat_of_archived(_row(store, live.id), True)
    ae_side_chat_archive.refuse_side_chat_of_archived(_row(store, gone.id), False)
