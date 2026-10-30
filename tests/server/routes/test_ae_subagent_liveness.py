"""A Claude Code subagent child stays running until its parent records the return."""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from typing import Any
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
from omnigent.server.routes._sessions.helpers import (
    _child_session_summary_from_conversation,
    _persist_session_status_error_labels,
)
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


async def _wait_for_stale_check(child_id: str) -> None:
    for _ in range(100):
        if ae_subagent_liveness._stale_checks or child_id not in (
            ae_subagent_liveness._stale_timers
        ):
            break
        await asyncio.sleep(0.01)
    await asyncio.gather(*ae_subagent_liveness._stale_checks)


async def test_first_running_arms_cap_for_child_that_never_lulls(
    db_uri: str, monkeypatch: pytest.MonkeyPatch, published: Mock
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    _, child_id = _claude_child(store)
    conv = store.get_conversation(child_id)
    assert conv is not None
    common._session_status_cache[child_id] = "running"
    try:
        # The real cap: the first running edge arms it, a later one keeps that timer.
        await ae_subagent_liveness.note_claude_subagent_status(conv, "running", store)
        timer = ae_subagent_liveness._stale_timers[child_id]
        remaining = timer.when() - asyncio.get_running_loop().time()
        assert abs(remaining - CLAUDE_SUBAGENT_STALE_AFTER_S) < 5
        await ae_subagent_liveness.note_claude_subagent_status(conv, "running", store)
        assert ae_subagent_liveness._stale_timers[child_id] is timer
        ae_subagent_liveness.cancel_stale_timer(child_id)
        # The child dies before any lull; nothing but that timer can settle it.
        monkeypatch.setattr(ae_subagent_liveness, "CLAUDE_SUBAGENT_STALE_AFTER_S", 0.01)
        await ae_subagent_liveness.note_claude_subagent_status(conv, "running", store)
        await _wait_for_stale_check(child_id)
        assert common._session_status_cache[child_id] == "idle"
        assert _statuses(published, child_id) == ["idle"]
    finally:
        ae_subagent_liveness.cancel_stale_timer(child_id)
        common._session_status_cache.pop(child_id, None)


async def test_running_edge_arms_nothing_for_other_children(db_uri: str) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    plain = store.create_conversation(kind="sub_agent", parent_conversation_id=parent.id)
    _, child_id = _claude_child(store)
    claude = store.get_conversation(child_id)
    assert claude is not None
    try:
        await ae_subagent_liveness.note_claude_subagent_status(plain, "running", store)
        await ae_subagent_liveness.note_claude_subagent_status(claude, "idle", store)
        assert plain.id not in ae_subagent_liveness._stale_timers
        assert child_id not in ae_subagent_liveness._stale_timers
    finally:
        ae_subagent_liveness.cancel_stale_timer(plain.id)
        ae_subagent_liveness.cancel_stale_timer(child_id)


@pytest.mark.parametrize(
    ("quiet_s", "completion", "settled"),
    [
        pytest.param(CLAUDE_SUBAGENT_STALE_AFTER_S + 1, None, True, id="quiet-past-cap"),
        pytest.param(600, None, False, id="recent-rearmed"),
        pytest.param(CLAUDE_SUBAGENT_STALE_AFTER_S + 1, "completed", False, id="returned"),
    ],
)
async def test_startup_sweep_settles_children_a_restart_left_running(
    db_uri: str, published: Mock, quiet_s: int, completion: str | None, settled: bool
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    parent_id, child_id = _claude_child(store)
    other = store.create_conversation(kind="sub_agent", parent_conversation_id=parent_id)
    if completion is not None:
        store.append(parent_id, [_completion_marker("task", "agent-1", completion)])
    # After a restart: no timers, an empty cache, and the rows still say running.
    for session_id in (child_id, other.id):
        store.set_session_live_status(session_id, "running")
        common._session_status_cache.pop(session_id, None)
        ae_subagent_liveness.cancel_stale_timer(session_id)
    conv = store.get_conversation(child_id)
    assert conv is not None and conv.live_status == "running"
    try:
        result = await ae_subagent_liveness.sweep_stale_claude_subagents(
            store, now=conv.updated_at + quiet_s
        )
        assert result == (1 if settled else 0)
        assert common._session_status_cache.get(child_id) == ("idle" if settled else None)
        assert _statuses(published, child_id) == (["idle"] if settled else [])
        timer = ae_subagent_liveness._stale_timers.get(child_id)
        if quiet_s < CLAUDE_SUBAGENT_STALE_AFTER_S:
            assert timer is not None
            remaining = timer.when() - asyncio.get_running_loop().time()
            assert abs(remaining - (CLAUDE_SUBAGENT_STALE_AFTER_S - quiet_s)) < 5
        else:
            assert timer is None
        # A sub-agent that is not a Claude Code child is left to its own paths.
        assert other.id not in ae_subagent_liveness._stale_timers
        assert _statuses(published, other.id) == []
    finally:
        ae_subagent_liveness.cancel_stale_timer(child_id)
        common._session_status_cache.pop(child_id, None)


async def test_startup_sweep_failure_is_logged_not_raised(
    caplog: pytest.LogCaptureFixture,
) -> None:
    store = Mock(spec=SqlAlchemyConversationStore)
    store._session = Mock(side_effect=RuntimeError("database is down"))
    assert await ae_subagent_liveness.sweep_stale_claude_subagents(store) == 0
    assert "Could not sweep stale Claude subagents" in caplog.text


async def test_startup_sweep_only_arms_a_child_restored_since_startup(
    db_uri: str, published: Mock
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    _, child_id = _claude_child(store)
    store.set_session_live_status(child_id, "running")
    ae_subagent_liveness.cancel_stale_timer(child_id)
    conv = store.get_conversation(child_id)
    assert conv is not None
    # A reconnect republished running before the sweep reached this row.
    common._session_status_cache[child_id] = "running"
    try:
        result = await ae_subagent_liveness.sweep_stale_claude_subagents(
            store, now=conv.updated_at + CLAUDE_SUBAGENT_STALE_AFTER_S + 1
        )
        assert result == 0
        assert common._session_status_cache[child_id] == "running"
        assert _statuses(published, child_id) == []
        assert child_id in ae_subagent_liveness._stale_timers
    finally:
        ae_subagent_liveness.cancel_stale_timer(child_id)
        common._session_status_cache.pop(child_id, None)


async def test_startup_sweep_warns_at_its_row_limit(
    db_uri: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    for _ in range(2):
        row = store.create_conversation(kind="sub_agent", parent_conversation_id=parent.id)
        store.set_session_live_status(row.id, "running")
    monkeypatch.setattr(ae_subagent_liveness, "_SWEEP_LIMIT", 2)
    assert len(ae_subagent_liveness._running_sub_agent_ids(store)) == 2
    assert "read only the first 2 running or waiting sub-agent rows" in caplog.text


async def test_startup_sweep_warns_without_a_sql_store(
    caplog: pytest.LogCaptureFixture,
) -> None:
    assert await ae_subagent_liveness.sweep_stale_claude_subagents(Mock(spec=[])) == 0
    assert "conversation store has no _session" in caplog.text


@pytest.mark.parametrize(
    ("live_status", "task_status"),
    [("failed", "failed"), ("idle", None), ("running", None)],
)
def test_child_summary_keeps_a_persisted_failure_after_a_restart(
    db_uri: str, live_status: str, task_status: str | None
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    parent_id, child_id = _claude_child(store)
    # After a restart the status cache is empty; only the row remembers the end.
    store.set_session_live_status(child_id, live_status)
    common._session_status_cache.pop(child_id, None)
    conv = store.get_conversation(child_id)
    assert conv is not None and conv.live_status == live_status
    summary = _child_session_summary_from_conversation(conv, parent_id, None)
    assert summary.current_task_status == task_status
    assert summary.busy is False
    # A live edge still wins over the row.
    common._session_status_cache[child_id] = "running"
    try:
        live = _child_session_summary_from_conversation(conv, parent_id, None)
        assert live.current_task_status == "in_progress"
        assert live.busy is True
    finally:
        common._session_status_cache.pop(child_id, None)


def _append_message(store: SqlAlchemyConversationStore, session_id: str) -> None:
    store.append(
        session_id,
        [
            NewConversationItem(
                type="message",
                response_id="turn-1",
                data=MessageData(
                    role="assistant",
                    agent="claude-native",
                    content=[{"type": "output_text", "text": "working"}],
                ),
            )
        ],
    )


def _two_hours_later(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the liveness module see a clock two hours past every stored item."""
    real = time.time()
    monkeypatch.setattr(
        ae_subagent_liveness, "time", SimpleNamespace(time=lambda: real + 2 * 60 * 60)
    )


async def test_restart_reposted_items_do_not_extend_the_settle(
    db_uri: str, monkeypatch: pytest.MonkeyPatch, published: Mock
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    _, child_id = _claude_child(store)
    _append_message(store, child_id)
    # A restarted runner re-sends old items and reports running: the row is touched
    # but no new item is stored, so the newest item is still two hours old.
    store.set_session_live_status(child_id, "running")
    conv = store.get_conversation(child_id)
    assert conv is not None
    common._session_status_cache[child_id] = "running"
    _two_hours_later(monkeypatch)
    try:
        await ae_subagent_liveness.note_claude_subagent_status(conv, "running", store)
        assert (
            ae_subagent_liveness._stale_timers[child_id].when()
            - (asyncio.get_running_loop().time())
            < 5
        )
        await _wait_for_stale_check(child_id)
        assert common._session_status_cache[child_id] == "idle"
        assert _statuses(published, child_id) == ["idle"]
    finally:
        ae_subagent_liveness.cancel_stale_timer(child_id)
        common._session_status_cache.pop(child_id, None)


async def test_lull_hold_keeps_the_original_deadline(db_uri: str, published: Mock) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    _, child_id = _claude_child(store)
    _append_message(store, child_id)
    conv = store.get_conversation(child_id)
    assert conv is not None
    common._session_status_cache[child_id] = "running"
    try:
        held = await ae_subagent_liveness.hold_premature_lull_idle(
            conv,
            store,
            response_id=None,
            background_task_count=None,
            background_tasks=None,
            blocked_on=None,
        )
        assert held is True
        remaining = (
            ae_subagent_liveness._stale_timers[child_id].when() - asyncio.get_running_loop().time()
        )
        # The item is fresh, so the deadline is about a full cap away, and never more.
        assert CLAUDE_SUBAGENT_STALE_AFTER_S - 10 < remaining <= CLAUDE_SUBAGENT_STALE_AFTER_S
    finally:
        ae_subagent_liveness.cancel_stale_timer(child_id)
        common._session_status_cache.pop(child_id, None)


async def test_lull_hold_past_the_cap_settles_at_once(
    db_uri: str, monkeypatch: pytest.MonkeyPatch, published: Mock
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    _, child_id = _claude_child(store)
    _append_message(store, child_id)
    conv = store.get_conversation(child_id)
    assert conv is not None
    common._session_status_cache[child_id] = "running"
    _two_hours_later(monkeypatch)
    try:
        assert await ae_subagent_liveness.hold_premature_lull_idle(
            conv,
            store,
            response_id=None,
            background_task_count=None,
            background_tasks=None,
            blocked_on=None,
        )
        await _wait_for_stale_check(child_id)
        assert common._session_status_cache[child_id] == "idle"
    finally:
        ae_subagent_liveness.cancel_stale_timer(child_id)
        common._session_status_cache.pop(child_id, None)


@pytest.mark.parametrize("cached", ["running", "waiting"])
async def test_settle_marks_child_disconnected_and_resume_clears_it(
    db_uri: str, published: Mock, cached: str
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    parent_id, child_id = _claude_child(store)
    conv = store.get_conversation(child_id)
    assert conv is not None
    common._session_status_cache[child_id] = cached
    try:
        assert await ae_subagent_liveness.settle_stale_claude_subagent(
            child_id, store, now=conv.updated_at + CLAUDE_SUBAGENT_STALE_AFTER_S + 1
        )
        settled = store.get_conversation(child_id)
        assert settled is not None
        summary = _child_session_summary_from_conversation(settled, parent_id, None)
        assert summary.busy is False
        assert summary.last_task_error is not None
        assert summary.last_task_error["code"] == "runner_disconnected"
        # A real resume's running edge clears the labels.
        await _persist_session_status_error_labels(child_id, None, store)
        resumed = store.get_conversation(child_id)
        assert resumed is not None
        assert (
            _child_session_summary_from_conversation(resumed, parent_id, None).last_task_error
            is None
        )
    finally:
        common._session_status_cache.pop(child_id, None)


async def test_stale_after_env_override(
    db_uri: str, monkeypatch: pytest.MonkeyPatch, published: Mock
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    _, child_id = _claude_child(store)
    conv = store.get_conversation(child_id)
    assert conv is not None
    assert ae_subagent_liveness.stale_after_s() == CLAUDE_SUBAGENT_STALE_AFTER_S
    monkeypatch.setenv("OMNIGENT_AE_CLAUDE_SUBAGENT_STALE_AFTER_S", "120")
    assert ae_subagent_liveness.stale_after_s() == 120
    for bad in ("soon", "-5"):
        monkeypatch.setenv("OMNIGENT_AE_CLAUDE_SUBAGENT_STALE_AFTER_S", bad)
        assert ae_subagent_liveness.stale_after_s() == CLAUDE_SUBAGENT_STALE_AFTER_S
    monkeypatch.setenv("OMNIGENT_AE_CLAUDE_SUBAGENT_STALE_AFTER_S", "120")
    common._session_status_cache[child_id] = "running"
    try:
        assert not await ae_subagent_liveness.settle_stale_claude_subagent(
            child_id, store, now=conv.updated_at + 60
        )
        assert await ae_subagent_liveness.settle_stale_claude_subagent(
            child_id, store, now=conv.updated_at + 121
        )
    finally:
        ae_subagent_liveness.cancel_stale_timer(child_id)
        common._session_status_cache.pop(child_id, None)


async def test_settle_decides_for_a_child_with_a_stored_older_item(
    db_uri: str, monkeypatch: pytest.MonkeyPatch, published: Mock
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    parent_id, child_id = _claude_child(store)
    _append_message(store, child_id)
    store.set_session_live_status(child_id, "running")
    common._session_status_cache[child_id] = "running"
    _two_hours_later(monkeypatch)
    try:
        assert await ae_subagent_liveness.settle_stale_claude_subagent(child_id, store)
        settled = store.get_conversation(child_id)
        assert settled is not None
        summary = _child_session_summary_from_conversation(settled, parent_id, None)
        assert summary.busy is False
        assert summary.last_task_error is not None
        assert summary.last_task_error["code"] == "runner_disconnected"
        assert _statuses(published, child_id) == ["idle"]
    finally:
        common._session_status_cache.pop(child_id, None)


async def test_running_edge_during_the_label_write_aborts_the_settle(
    db_uri: str, monkeypatch: pytest.MonkeyPatch, published: Mock
) -> None:
    from omnigent.server.routes._sessions import helpers

    store = SqlAlchemyConversationStore(db_uri)
    parent_id, child_id = _claude_child(store)
    conv = store.get_conversation(child_id)
    assert conv is not None
    common._session_status_cache[child_id] = "running"
    real = helpers._persist_session_status_error_labels
    calls = 0

    async def racing(*args: Any, **kwargs: Any) -> None:
        nonlocal calls
        calls += 1
        await real(*args, **kwargs)
        if calls == 1:
            # The runner resumes while the Disconnected labels are being written.
            await ae_subagent_liveness.note_claude_subagent_status(conv, "running", store)

    monkeypatch.setattr(helpers, "_persist_session_status_error_labels", racing)
    try:
        assert not await ae_subagent_liveness.settle_stale_claude_subagent(
            child_id, store, now=conv.updated_at + CLAUDE_SUBAGENT_STALE_AFTER_S + 1
        )
        assert calls == 2
        assert common._session_status_cache[child_id] == "running"
        assert _statuses(published, child_id) == []
        after = store.get_conversation(child_id)
        assert after is not None
        assert (
            _child_session_summary_from_conversation(after, parent_id, None).last_task_error
            is None
        )
    finally:
        ae_subagent_liveness.cancel_stale_timer(child_id)
        common._session_status_cache.pop(child_id, None)


async def test_waiting_child_blocked_on_a_prompt_is_never_settled(
    db_uri: str, published: Mock
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    _, child_id = _claude_child(store)
    conv = store.get_conversation(child_id)
    assert conv is not None
    common._session_status_cache[child_id] = "waiting"
    common._session_blocked_on_cache[child_id] = "user_input"
    try:
        assert not await ae_subagent_liveness.settle_stale_claude_subagent(
            child_id, store, now=conv.updated_at + CLAUDE_SUBAGENT_STALE_AFTER_S + 1
        )
        assert common._session_status_cache[child_id] == "waiting"
        assert _statuses(published, child_id) == []
    finally:
        common._session_status_cache.pop(child_id, None)
        common._session_blocked_on_cache.pop(child_id, None)


async def test_startup_sweep_picks_up_a_persisted_waiting_row(
    db_uri: str, published: Mock
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    _, child_id = _claude_child(store)
    store.set_session_live_status(child_id, "waiting")
    common._session_status_cache.pop(child_id, None)
    ae_subagent_liveness.cancel_stale_timer(child_id)
    conv = store.get_conversation(child_id)
    assert conv is not None and conv.live_status == "waiting"
    try:
        assert child_id in ae_subagent_liveness._running_sub_agent_ids(store)
        assert (
            await ae_subagent_liveness.sweep_stale_claude_subagents(
                store, now=conv.updated_at + CLAUDE_SUBAGENT_STALE_AFTER_S + 1
            )
            == 1
        )
        assert common._session_status_cache[child_id] == "idle"
    finally:
        common._session_status_cache.pop(child_id, None)


@pytest.mark.parametrize("bad", ["inf", "-inf", "nan", "Infinity"])
def test_stale_after_env_rejects_non_finite(monkeypatch: pytest.MonkeyPatch, bad: str) -> None:
    monkeypatch.setenv("OMNIGENT_AE_CLAUDE_SUBAGENT_STALE_AFTER_S", bad)
    assert ae_subagent_liveness.stale_after_s() == CLAUDE_SUBAGENT_STALE_AFTER_S
