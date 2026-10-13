"""Tests for :mod:`omnigent.server.scheduled.retention`.

The ``keep_runs`` setting (its own table, the default when never set), the
fire-observer seam (awaited after a successful fire only, never failing it),
and the request-free session delete.
"""

from __future__ import annotations

from typing import Any

import pytest

from omnigent.entities.scheduled_task import DEFAULT_KEEP_RUNS
from omnigent.server.scheduled import retention
from omnigent.server.scheduled.fire import build_on_fire
from tests.server.scheduled.test_fire import (
    FakeScheduledTaskStore,
    _deps,
    _drain,
    _task,
)


@pytest.fixture(autouse=True)
def _no_observers() -> Any:
    saved = retention.registered_fire_observers()
    for fn in saved:
        retention.unregister_fire_observer(fn)
    yield
    for fn in retention.registered_fire_observers():
        retention.unregister_fire_observer(fn)
    for fn in saved:
        retention.register_fire_observer(fn)


# ── The setting ──────────────────────────────────────────────────────────


def test_keep_runs_defaults_round_trips_and_forgets_in_sqlite(db_uri: str) -> None:
    from omnigent.stores.scheduled_task_store.sqlalchemy_store import (
        SqlAlchemyScheduledTaskStore,
    )

    store = SqlAlchemyScheduledTaskStore(db_uri)
    assert retention.keep_runs_for(store, ["a", "b"]) == {
        "a": DEFAULT_KEEP_RUNS,
        "b": DEFAULT_KEEP_RUNS,
    }
    retention.set_keep_runs(store, "a", 2)
    retention.set_keep_runs(store, "b", None)
    retention.set_keep_runs(store, "a", 3)
    assert retention.keep_runs_for(store, ["a", "b"]) == {"a": 3, "b": None}
    retention.forget_keep_runs(store, "a")
    assert retention.keep_runs_for(store, ["a"]) == {"a": DEFAULT_KEEP_RUNS}


def test_set_keep_runs_rejects_out_of_range() -> None:
    store = FakeScheduledTaskStore()
    with pytest.raises(ValueError, match="keep_runs"):
        retention.set_keep_runs(store, "a", 0)
    with pytest.raises(ValueError, match="keep_runs"):
        retention.set_keep_runs(store, "a", retention.MAX_KEEP_RUNS + 1)


def test_with_keep_runs_fills_the_entity() -> None:
    store = FakeScheduledTaskStore()
    retention.set_keep_runs(store, "task_1", 7)
    [task] = retention.with_keep_runs(store, [_task()])
    assert task.keep_runs == 7


# ── The seam ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_observer_awaited_after_a_successful_fire_with_keep_runs() -> None:
    store = FakeScheduledTaskStore(rows={"task_1": _task()})
    retention.set_keep_runs(store, "task_1", 2)
    seen: list[retention.FireEvent] = []

    async def _observer(event: retention.FireEvent) -> None:
        seen.append(event)

    async def _launch(conv: Any, task: Any) -> None:
        return None

    retention.register_fire_observer(_observer)
    on_fire = build_on_fire(_deps(store), launch_dispatch=_launch)
    await on_fire(0, "task_1")
    await _drain()

    assert [(e.task.id, e.conversation_id, e.task.keep_runs) for e in seen] == [
        ("task_1", "conv_1", 2)
    ]
    # The run was recorded before observers ran.
    assert store.runs and store.runs[-1]["status"] == "running"


@pytest.mark.asyncio
async def test_observer_not_called_when_the_fire_fails() -> None:
    store = FakeScheduledTaskStore(rows={"task_1": _task()})
    seen: list[Any] = []

    async def _observer(event: retention.FireEvent) -> None:
        seen.append(event)

    async def _launch(conv: Any, task: Any) -> None:
        raise RuntimeError("host went away")

    retention.register_fire_observer(_observer)
    on_fire = build_on_fire(_deps(store), launch_dispatch=_launch)
    await on_fire(0, "task_1")
    await _drain()

    assert seen == []
    assert store.runs[-1]["status"] == "failed"


@pytest.mark.asyncio
async def test_a_failing_observer_does_not_stop_the_next_one() -> None:
    store = FakeScheduledTaskStore(rows={"task_1": _task()})
    seen: list[str] = []

    async def _broken(event: retention.FireEvent) -> None:
        raise RuntimeError("boom")

    async def _after(event: retention.FireEvent) -> None:
        seen.append(event.conversation_id)

    async def _launch(conv: Any, task: Any) -> None:
        return None

    retention.register_fire_observer(_broken)
    retention.register_fire_observer(_after)
    retention.register_fire_observer(_after)  # idempotent
    on_fire = build_on_fire(_deps(store), launch_dispatch=_launch)
    await on_fire(0, "task_1")
    await _drain()

    assert seen == ["conv_1"]


# ── The delete ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_session_server_side_removes_the_row(db_uri: str) -> None:
    from omnigent.stores.conversation_store.sqlalchemy_store import (
        SqlAlchemyConversationStore,
    )

    conv_store = SqlAlchemyConversationStore(db_uri)
    conv = conv_store.create_conversation(title="nightly")
    deps = _deps(FakeScheduledTaskStore(), conversation_store=conv_store)

    assert await retention.delete_session_server_side(deps, conv.id) is True
    assert conv_store.get_conversation(conv.id) is None
    assert await retention.delete_session_server_side(deps, conv.id) is False


@pytest.mark.asyncio
async def test_delete_session_server_side_refuses_a_worktree_session(db_uri: str) -> None:
    from omnigent.stores.conversation_store.sqlalchemy_store import (
        SqlAlchemyConversationStore,
    )

    conv_store = SqlAlchemyConversationStore(db_uri)
    conv = conv_store.create_conversation(
        title="nightly", workspace="/repo/wt", git_branch="topic"
    )
    deps = _deps(FakeScheduledTaskStore(), conversation_store=conv_store)

    assert await retention.delete_session_server_side(deps, conv.id) is False
    assert conv_store.get_conversation(conv.id) is not None
