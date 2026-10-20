"""A Claude Code subagent child stays running until its parent records the return."""

from __future__ import annotations

import asyncio
from unittest.mock import Mock

import pytest

from omnigent.entities import (
    FunctionCallOutputData,
    MessageData,
    NewConversationItem,
)
from omnigent.server import ae_subagent_liveness
from omnigent.server.ae_subagent_liveness import CLAUDE_SUBAGENT_STALE_AFTER_S
from omnigent.server.routes._sessions import common
from omnigent.server.routes._sessions.helpers import _child_session_summary_from_conversation
from omnigent.server.subagent_activity import (
    _completion_marker,
    record_claude_subagent_return,
    record_subagent_activity,
)
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore

_CLAUDE_WRAPPER = "claude-code-native-ui-subagent"


@pytest.mark.parametrize(
    ("status", "expected"),
    [("completed", "idle"), ("failed", "failed"), ("killed", "idle")],
)
@pytest.mark.parametrize("late", [False, True], ids=["discovered-first", "returned-first"])
async def test_recorded_completion_ends_claude_subagent(
    db_uri: str, monkeypatch: pytest.MonkeyPatch, status: str, expected: str, late: bool
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    child = store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=parent.id,
        title="Explore:agent-1",
        labels={
            "omnigent.wrapper": _CLAUDE_WRAPPER,
            "omnigent.claude_native.subagent_id": "agent-1",
            "omnigent.claude_native.tool_use_id": "tool-1",
        },
    )
    monkeypatch.setattr("omnigent.server.subagent_activity.session_stream.publish", Mock())
    common._session_status_cache[child.id] = "running"
    if status == "completed":
        notification = NewConversationItem(
            type="function_call_output",
            response_id="parent-turn",
            data=FunctionCallOutputData(
                call_id="tool-1", output="Done", subagent_return_id="agent-1"
            ),
        )
    else:
        text = (
            "<task-notification><task-id>agent-1</task-id>"
            f"<status>{status}</status></task-notification>"
        )
        notification = NewConversationItem(
            type="message",
            response_id="parent-turn",
            data=MessageData(
                role="user", is_meta=True, content=[{"type": "input_text", "text": text}]
            ),
        )
    try:
        if late:
            # The result lands before child discovery: the delegated edge replays it.
            store.append(
                parent.id,
                [
                    _completion_marker(
                        "task", "agent-1", "cancelled" if status == "killed" else status
                    )
                ],
            )
            await record_subagent_activity(child.id, "delegated", store)
        else:
            await record_subagent_activity(child.id, "delegated", store)
            assert common._session_status_cache[child.id] == "running"
            await record_claude_subagent_return(parent.id, notification, store)
        assert common._session_status_cache[child.id] == expected
        conv = store.get_conversation(child.id)
        assert conv is not None
        summary = _child_session_summary_from_conversation(conv, parent.id, None)
        assert summary.busy is False
        assert summary.current_task_status == ("completed" if expected == "idle" else "failed")
    finally:
        common._session_status_cache.pop(child.id, None)
        common._session_active_response_cache.pop(child.id, None)


def _claude_child(store: SqlAlchemyConversationStore) -> tuple[str, str]:
    parent = store.create_conversation()
    child = store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=parent.id,
        title="Explore:agent-1",
        labels={
            "omnigent.wrapper": _CLAUDE_WRAPPER,
            "omnigent.claude_native.subagent_id": "agent-1",
        },
    )
    return parent.id, child.id


@pytest.fixture
def published(monkeypatch: pytest.MonkeyPatch) -> Mock:
    publish = Mock()
    monkeypatch.setattr("omnigent.server.subagent_activity.session_stream.publish", publish)
    return publish


def _statuses(published: Mock, session_id: str) -> list[str]:
    return [
        c.args[1]["status"]
        for c in published.call_args_list
        if c.args[0] == session_id and c.args[1].get("type") == "session.status"
    ]


async def test_stale_timer_settles_quiet_subagent_idle(
    db_uri: str, monkeypatch: pytest.MonkeyPatch, published: Mock
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    _, child_id = _claude_child(store)
    common._session_status_cache[child_id] = "running"
    monkeypatch.setattr(ae_subagent_liveness, "CLAUDE_SUBAGENT_STALE_AFTER_S", 0)
    try:
        ae_subagent_liveness.arm_stale_timer(child_id, store, 0.01)
        assert child_id in ae_subagent_liveness._stale_timers
        for _ in range(100):
            if ae_subagent_liveness._stale_checks or child_id not in (
                ae_subagent_liveness._stale_timers
            ):
                break
            await asyncio.sleep(0.01)
        await asyncio.gather(*ae_subagent_liveness._stale_checks)
        assert common._session_status_cache[child_id] == "idle"
        assert _statuses(published, child_id) == ["idle"]
        assert child_id not in ae_subagent_liveness._stale_timers
    finally:
        ae_subagent_liveness.cancel_stale_timer(child_id)
        common._session_status_cache.pop(child_id, None)


@pytest.mark.parametrize(
    ("quiet_s", "completion", "settled"),
    [
        pytest.param(CLAUDE_SUBAGENT_STALE_AFTER_S + 1, None, True, id="quiet-past-cap"),
        pytest.param(600, None, False, id="transcript-moved"),
        pytest.param(CLAUDE_SUBAGENT_STALE_AFTER_S + 1, "completed", False, id="returned"),
    ],
)
async def test_stale_check_settles_or_rearms(
    db_uri: str, published: Mock, quiet_s: int, completion: str | None, settled: bool
) -> None:
    assert CLAUDE_SUBAGENT_STALE_AFTER_S == 60 * 60
    store = SqlAlchemyConversationStore(db_uri)
    parent_id, child_id = _claude_child(store)
    if completion is not None:
        store.append(parent_id, [_completion_marker("task", "agent-1", completion)])
    conv = store.get_conversation(child_id)
    assert conv is not None
    common._session_status_cache[child_id] = "running"
    try:
        result = await ae_subagent_liveness.settle_stale_claude_subagent(
            child_id, store, now=conv.updated_at + quiet_s
        )
        assert result is settled
        assert common._session_status_cache[child_id] == ("idle" if settled else "running")
        assert _statuses(published, child_id) == (["idle"] if settled else [])
        timer = ae_subagent_liveness._stale_timers.get(child_id)
        if quiet_s < CLAUDE_SUBAGENT_STALE_AFTER_S:
            assert timer is not None
            remaining = timer.when() - asyncio.get_running_loop().time()
            assert abs(remaining - (CLAUDE_SUBAGENT_STALE_AFTER_S - quiet_s)) < 5
        else:
            assert timer is None
    finally:
        ae_subagent_liveness.cancel_stale_timer(child_id)
        common._session_status_cache.pop(child_id, None)


async def test_replayed_return_only_settles_an_empty_cache(db_uri: str, published: Mock) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    _, child_id = _claude_child(store)

    async def returned() -> None:
        await record_subagent_activity(
            child_id, "returned", store, turn_id="tool-1", status="completed"
        )

    try:
        common._session_status_cache[child_id] = "running"
        await returned()
        assert common._session_status_cache[child_id] == "idle"
        # A resumed child must not be ended by a replay of its earlier return.
        common._session_status_cache[child_id] = "running"
        await returned()
        assert common._session_status_cache[child_id] == "running"
        # After a server restart the cache is empty, and the replay settles it.
        common._session_status_cache.pop(child_id)
        await returned()
        assert common._session_status_cache[child_id] == "idle"
        assert _statuses(published, child_id) == ["idle", "idle"]
    finally:
        common._session_status_cache.pop(child_id, None)
        common._session_active_response_cache.pop(child_id, None)
