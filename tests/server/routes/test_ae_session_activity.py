"""Session-row activity counts on ``GET /v1/sessions`` and ``WS /v1/sessions/updates``.

A row whose turn ended can still be waiting on background shells or on busy
child sessions. Every list row carries ``background_task_count`` and
``active_child_count`` so the sidebar can show that state, and the updates
stream pushes a ``changed`` frame for the parent when either count moves.
``turn_active`` and ``blocked_on`` carry the session's own turn and dialog,
which the rolled-up ``status`` hides.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import omnigent.server.routes.sessions as sessions_routes
from omnigent.runtime import pending_elicitations
from omnigent.server.auth import LEVEL_OWNER, UnifiedAuthProvider
from omnigent.server.routes._sessions import orchestration
from omnigent.server.routes._sessions.ae_session_activity import (
    session_active_child_count,
    session_background_task_count,
    session_blocked_on,
    settle_archived_session,
)
from omnigent.server.routes._sessions.common import _session_blocked_on_cache
from omnigent.server.routes.sessions import create_sessions_router
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore

ALICE = "alice@example.com"
_AGENT_ID = "087b7cb7ac30abf4debfaa578d052ec6"
_HEADERS = {"X-Forwarded-Email": ALICE}

Stores = tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore]


@pytest.fixture
def stores(db_uri: str) -> Stores:
    """File-backed stores so test-thread writes are visible to the WS thread."""
    return (
        SqlAlchemyConversationStore(db_uri),
        SqlAlchemyAgentStore(db_uri),
        SqlAlchemyPermissionStore(db_uri),
    )


@pytest.fixture
def app(stores: Stores) -> FastAPI:
    """Sessions router with header auth and a real permission store."""
    conversation_store, agent_store, permission_store = stores
    app = FastAPI()
    app.include_router(
        create_sessions_router(
            conversation_store=conversation_store,
            agent_store=agent_store,
            auth_provider=UnifiedAuthProvider(source="header"),
            permission_store=permission_store,
        ),
        prefix="/v1",
    )
    return app


@pytest.fixture
def touched() -> Iterator[list[str]]:
    """Session ids whose relay caches a test seeds, cleared afterwards."""
    ids: list[str] = []
    yield ids
    for sid in ids:
        sessions_routes._session_status_cache.pop(sid, None)
        sessions_routes._session_background_task_count_cache.pop(sid, None)
        sessions_routes._session_background_tasks_cache.pop(sid, None)
        _session_blocked_on_cache.pop(sid, None)
        for elicitation_id in [
            e.get("elicitation_id") for e in pending_elicitations.snapshot_for(sid)
        ]:
            if isinstance(elicitation_id, str):
                pending_elicitations.resolve(sid, elicitation_id)


@pytest.fixture
def fast_rescan(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shrink the updates-stream rescan so ``changed`` frames land promptly."""
    monkeypatch.setattr(sessions_routes, "_SESSION_UPDATES_RESCAN_INTERVAL_S", 0.05)
    monkeypatch.setattr(sessions_routes, "_SESSION_UPDATES_HEARTBEAT_INTERVAL_S", 0.1)


def _seed_parent(stores: Stores, touched: list[str], title: str) -> str:
    """Create an owned top-level session and return its id."""
    conversation_store, agent_store, permission_store = stores
    if agent_store.get(_AGENT_ID) is None:
        agent_store.create(agent_id=_AGENT_ID, name="test-agent", bundle_location=f"{_AGENT_ID}/b")
    conv = conversation_store.create_conversation(title=title, agent_id=_AGENT_ID)
    permission_store.ensure_user(ALICE)
    permission_store.grant(ALICE, conv.id, LEVEL_OWNER)
    touched.append(conv.id)
    return conv.id


def _seed_child(stores: Stores, touched: list[str], parent_id: str, status: str | None) -> str:
    """Create a direct child session with the given relay status (``None`` for none)."""
    child = stores[0].create_conversation(
        kind="sub_agent",
        title=f"coder:task{len(touched)}",
        parent_conversation_id=parent_id,
        agent_id=_AGENT_ID,
    )
    touched.append(child.id)
    if status is not None:
        sessions_routes._session_status_cache[child.id] = status
    return child.id


def _list_rows(app: FastAPI) -> dict[str, dict[str, object]]:
    """Fetch the top-level session list keyed by id."""
    resp = TestClient(app).get("/v1/sessions", headers=_HEADERS)
    assert resp.status_code == 200
    return {item["id"]: item for item in resp.json()["data"]}


def _recv_until(ws: object, wanted: set[str], *, max_frames: int = 50) -> dict[str, object]:
    """Read frames until one whose ``type`` is in ``wanted`` arrives."""
    for _ in range(max_frames):
        frame = json.loads(ws.receive_text())  # type: ignore[attr-defined]
        if frame.get("type") in wanted:
            return frame
    raise AssertionError(f"no frame in {wanted} after {max_frames} frames")


def _recv_parent_change(ws: object, parent_id: str) -> dict[str, object]:
    """Return the parent's row from the next ``changed`` frame that carries it."""
    for _ in range(50):
        frame = _recv_until(ws, {"changed"})
        for item in frame["items"]:  # type: ignore[union-attr]
            if item["id"] == parent_id:
                return item
    raise AssertionError(f"no changed frame for {parent_id}")


def test_list_row_with_no_activity_reports_zero(app: FastAPI, stores: Stores, touched) -> None:
    """A quiet session carries both counts as explicit zeros."""
    parent_id = _seed_parent(stores, touched, "quiet")

    row = _list_rows(app)[parent_id]

    assert row["background_task_count"] == 0
    assert row["active_child_count"] == 0
    assert row["status"] == "idle"


def test_list_row_counts_only_busy_children(app: FastAPI, stores: Stores, touched) -> None:
    """Running and approval-blocked children count; idle, failed and unreported do not."""
    parent_id = _seed_parent(stores, touched, "parent")
    _seed_child(stores, touched, parent_id, "running")
    _seed_child(stores, touched, parent_id, "waiting")
    _seed_child(stores, touched, parent_id, "idle")
    _seed_child(stores, touched, parent_id, "failed")
    _seed_child(stores, touched, parent_id, None)

    row = _list_rows(app)[parent_id]

    assert row["active_child_count"] == 2
    # The parent's own turn is over; the counts carry the waiting state.
    assert row["background_task_count"] == 0


def test_list_row_counts_child_with_outstanding_approval(
    app: FastAPI, stores: Stores, touched
) -> None:
    """A child whose approval prompt landed before its status edge still counts."""
    parent_id = _seed_parent(stores, touched, "parent")
    asking = _seed_child(stores, touched, parent_id, None)
    _seed_child(stores, touched, parent_id, "idle")
    pending_elicitations.record_publish(
        asking, {"type": "response.elicitation_request", "elicitation_id": "elicit_ask"}
    )

    assert _list_rows(app)[parent_id]["active_child_count"] == 1

    pending_elicitations.resolve(asking, "elicit_ask")
    assert _list_rows(app)[parent_id]["active_child_count"] == 0


def test_list_row_reads_background_count_from_cache(app: FastAPI, stores: Stores, touched) -> None:
    """The background-shell tally the Stop hook reported rides on the row."""
    parent_id = _seed_parent(stores, touched, "shells")
    sessions_routes._session_background_task_count_cache[parent_id] = 2

    row = _list_rows(app)[parent_id]

    assert row["background_task_count"] == 2
    # Background shells never make the row itself read as running.
    assert row["status"] == "idle"


def test_list_row_own_turn_idle_with_busy_child_reads_turn_inactive(
    app: FastAPI, stores: Stores, touched
) -> None:
    """A busy child rolls the row up to running while its own turn reads over."""
    parent_id = _seed_parent(stores, touched, "waiting")
    sessions_routes._session_status_cache[parent_id] = "idle"
    _seed_child(stores, touched, parent_id, "running")

    row = _list_rows(app)[parent_id]

    assert row["status"] == "running"
    assert row["turn_active"] is False
    assert row["active_child_count"] == 1


def test_list_row_own_turn_running_reads_turn_active(
    app: FastAPI, stores: Stores, touched
) -> None:
    """A session whose own turn runs reads active, with or without children."""
    parent_id = _seed_parent(stores, touched, "running")
    sessions_routes._session_status_cache[parent_id] = "running"
    _seed_child(stores, touched, parent_id, "running")

    row = _list_rows(app)[parent_id]

    assert row["status"] == "running"
    assert row["turn_active"] is True
    assert row["active_child_count"] == 1


def test_list_row_quiet_session_reads_turn_inactive(app: FastAPI, stores: Stores, touched) -> None:
    """A session with no turn and no children reads inactive and not parked."""
    parent_id = _seed_parent(stores, touched, "quiet")

    row = _list_rows(app)[parent_id]

    assert row["turn_active"] is False
    assert row.get("blocked_on") is None


def test_list_row_carries_dialog_a_running_session_is_parked_on(
    app: FastAPI, stores: Stores, touched
) -> None:
    """The latest status edge's dialog rides on the row until an edge clears it."""
    parent_id = _seed_parent(stores, touched, "parked")

    sessions_routes._publish_status(parent_id, "running", blocked_on="input needed")
    row = _list_rows(app)[parent_id]
    assert row["blocked_on"] == "input needed"
    assert row["turn_active"] is True

    sessions_routes._publish_status(parent_id, "running")
    assert _list_rows(app)[parent_id].get("blocked_on") is None

    sessions_routes._publish_status(parent_id, "running", blocked_on="input needed")
    sessions_routes._publish_status(parent_id, "idle")
    assert _list_rows(app)[parent_id].get("blocked_on") is None


def test_runner_status_probe_drops_a_remembered_dialog(
    app: FastAPI, stores: Stores, touched
) -> None:
    """A probe resets the status without naming a dialog, so the old one goes."""
    parent_id = _seed_parent(stores, touched, "probed")
    sessions_routes._publish_status(parent_id, "running", blocked_on="input needed")
    transport = httpx.MockTransport(lambda _req: httpx.Response(200, json={"status": "running"}))

    async def probe() -> str | None:
        async with httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
            return await orchestration._run_runner_status_probe(client, parent_id, None)

    assert asyncio.run(probe()) == "running"
    row = _list_rows(app)[parent_id]
    assert row.get("blocked_on") is None
    assert row["turn_active"] is True


def test_relinquished_session_reads_not_parked(app: FastAPI, stores: Stores, touched) -> None:
    """A session handed to another replica drops its dialog with its status."""
    parent_id = _seed_parent(stores, touched, "moved")
    sessions_routes._publish_status(parent_id, "running", blocked_on="input needed")

    orchestration._relinquish_session_live_state(parent_id)

    assert _session_blocked_on_cache.get(parent_id) is None
    assert _list_rows(app)[parent_id].get("blocked_on") is None


def test_dialog_is_served_only_while_the_session_still_runs(stores: Stores, touched) -> None:
    """A status written outside the publish path hides a remembered dialog."""
    parent_id = _seed_parent(stores, touched, "reset")
    sessions_routes._publish_status(parent_id, "running", blocked_on="input needed")
    assert session_blocked_on(parent_id) == "input needed"

    sessions_routes._session_status_cache[parent_id] = "idle"

    assert session_blocked_on(parent_id) is None


def test_failed_child_with_stale_approval_does_not_count(stores: Stores, touched) -> None:
    """A failed child is done even if an approval entry lingers in the index."""
    parent_id = _seed_parent(stores, touched, "parent")
    child = _seed_child(stores, touched, parent_id, "failed")
    pending_elicitations.record_publish(
        child, {"type": "response.elicitation_request", "elicitation_id": "elicit_stale"}
    )

    assert session_active_child_count([child]) == 0
    assert session_active_child_count([]) == 0
    assert session_background_task_count(parent_id) == 0


def test_updates_stream_pushes_parent_change_when_child_status_moves(
    app: FastAPI, stores: Stores, touched, fast_rescan: None
) -> None:
    """A child starting and finishing pushes ``changed`` frames for the watched parent."""
    parent_id = _seed_parent(stores, touched, "parent")
    child_id = _seed_child(stores, touched, parent_id, None)

    with TestClient(app).websocket_connect("/v1/sessions/updates", headers=_HEADERS) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [parent_id]}))
        snapshot = _recv_until(ws, {"snapshot"})
        first = snapshot["items"][0]  # type: ignore[index]
        assert first["active_child_count"] == 0
        assert first["background_task_count"] == 0

        sessions_routes._session_status_cache[child_id] = "running"
        assert _recv_parent_change(ws, parent_id)["active_child_count"] == 1

        sessions_routes._session_status_cache[child_id] = "idle"
        assert _recv_parent_change(ws, parent_id)["active_child_count"] == 0


def test_updates_stream_pushes_change_when_background_count_moves(
    app: FastAPI, stores: Stores, touched, fast_rescan: None
) -> None:
    """A new background-shell tally, and its clearing, push ``changed`` frames."""
    parent_id = _seed_parent(stores, touched, "shells")

    with TestClient(app).websocket_connect("/v1/sessions/updates", headers=_HEADERS) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [parent_id]}))
        _recv_until(ws, {"snapshot"})

        sessions_routes._session_background_task_count_cache[parent_id] = 3
        assert _recv_parent_change(ws, parent_id)["background_task_count"] == 3

        sessions_routes._session_background_task_count_cache.pop(parent_id, None)
        assert _recv_parent_change(ws, parent_id)["background_task_count"] == 0


def test_closed_child_stops_counting_while_open_sibling_still_counts(
    app: FastAPI, stores: Stores, touched, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Archiving a running child (``sys_session_close``) drops it from the badge at once."""
    # Keep the deferred teardown from firing; it is covered on its own below.
    monkeypatch.setattr(sessions_routes, "_ARCHIVE_STOP_UNDO_GRACE_S", 3600.0)
    parent_id = _seed_parent(stores, touched, "parent")
    closed = _seed_child(stores, touched, parent_id, "running")
    _seed_child(stores, touched, parent_id, "running")
    client = TestClient(app)
    assert _list_rows(app)[parent_id]["active_child_count"] == 2

    resp = client.patch(f"/v1/sessions/{closed}", json={"archived": True}, headers=_HEADERS)
    assert resp.status_code == 200, resp.text
    assert _list_rows(app)[parent_id]["active_child_count"] == 1

    # An Undo brings a still-running child back into the count.
    resp = client.patch(f"/v1/sessions/{closed}", json={"archived": False}, headers=_HEADERS)
    assert resp.status_code == 200, resp.text
    assert _list_rows(app)[parent_id]["active_child_count"] == 2


def test_archived_child_with_outstanding_approval_does_not_count(
    app: FastAPI, stores: Stores, touched
) -> None:
    """A closed child is left out even with an approval and a busy cached status."""
    parent_id = _seed_parent(stores, touched, "parent")
    child = _seed_child(stores, touched, parent_id, "waiting")
    pending_elicitations.record_publish(
        child, {"type": "response.elicitation_request", "elicitation_id": "elicit_closed"}
    )
    assert _list_rows(app)[parent_id]["active_child_count"] == 1

    stores[0].update_conversation(child, archived=True)

    assert _list_rows(app)[parent_id]["active_child_count"] == 0


def test_child_id_query_leaves_archived_children_out_only_when_asked(
    stores: Stores, touched
) -> None:
    """The default keeps archived children, for recovery and the stop sweep."""
    conversation_store = stores[0]
    parent_id = _seed_parent(stores, touched, "parent")
    closed = _seed_child(stores, touched, parent_id, None)
    open_child = _seed_child(stores, touched, parent_id, None)
    conversation_store.update_conversation(closed, archived=True)

    every = conversation_store.list_child_conversation_ids_by_parent([parent_id])
    unarchived = conversation_store.list_child_conversation_ids_by_parent(
        [parent_id], include_archived=False
    )

    assert set(every[parent_id]) == {closed, open_child}
    assert unarchived[parent_id] == [open_child]


def test_settle_archived_session_publishes_idle_only_for_busy(stores: Stores, touched) -> None:
    """Running, waiting and a stored running settle idle; idle and failed stay put."""
    parent_id = _seed_parent(stores, touched, "parent")
    running = _seed_child(stores, touched, parent_id, "running")
    waiting = _seed_child(stores, touched, parent_id, "waiting")
    failed = _seed_child(stores, touched, parent_id, "failed")
    idle = _seed_child(stores, touched, parent_id, "idle")
    restarted = _seed_child(stores, touched, parent_id, None)

    assert settle_archived_session(running) is True
    assert settle_archived_session(waiting) is True
    assert settle_archived_session(failed) is False
    assert settle_archived_session(idle) is False
    assert settle_archived_session(restarted, "running") is True

    cache = sessions_routes._session_status_cache
    assert [cache.get(c) for c in (running, waiting, failed, idle, restarted)] == [
        "idle",
        "idle",
        "failed",
        "idle",
        "idle",
    ]


def test_archive_teardown_settles_a_closed_child_still_marked_running(
    stores: Stores, touched
) -> None:
    """The deferred archive stop leaves a closed child idle, not running for good."""
    conversation_store = stores[0]
    parent_id = _seed_parent(stores, touched, "parent")
    child = _seed_child(stores, touched, parent_id, "running")
    conversation_store.update_conversation(child, archived=True)

    asyncio.run(orchestration._archive_stop(child, conversation_store, None, None))

    assert sessions_routes._session_status_cache.get(child) == "idle"
    assert session_active_child_count([child]) == 0
