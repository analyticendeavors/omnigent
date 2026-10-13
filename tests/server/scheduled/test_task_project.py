"""Tests for :mod:`omnigent.server.scheduled.task_project`.

The ``project_id`` setting (its own table, unset by default), the default
project named by the environment, and filing a fired session into the task's
project without ever failing the fire.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from omnigent.server.scheduled import task_project
from omnigent.server.scheduled.fire import build_on_fire
from tests.server.scheduled.test_fire import (
    FakeConversationStore,
    FakeScheduledTaskStore,
    _deps,
    _drain,
    _task,
)


@dataclass
class _Project:
    id: str
    name: str


class _FakeProjectStore:
    def __init__(self, projects: dict[str | None, list[_Project]]) -> None:
        self.projects = projects

    def list(self, *, user_id: str | None) -> list[_Project]:
        return list(self.projects.get(user_id, []))

    def get(self, project_id: str, *, user_id: str | None) -> _Project | None:
        return next((p for p in self.list(user_id=user_id) if p.id == project_id), None)


class _FilingConversationStore(FakeConversationStore):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.filed: dict[str, str | None] = {}

    def set_conversation_project(self, conversation_id: str, project_id: str | None) -> bool:
        self.filed[conversation_id] = project_id
        return True


async def _launch(conv: Any, task: Any) -> None:
    return None


# ── The setting ──────────────────────────────────────────────────────────


def test_project_round_trips_and_forgets_in_sqlite(db_uri: str) -> None:
    from omnigent.stores.scheduled_task_store.sqlalchemy_store import (
        SqlAlchemyScheduledTaskStore,
    )

    store = SqlAlchemyScheduledTaskStore(db_uri)
    assert task_project.project_ids_for(store, ["a", "b"]) == {"a": None, "b": None}
    task_project.set_project(store, "a", "p" * 32)
    task_project.set_project(store, "b", "q" * 32)
    task_project.set_project(store, "b", None)
    assert task_project.project_ids_for(store, ["a", "b"]) == {"a": "p" * 32, "b": None}
    task_project.forget_project(store, "a")
    assert task_project.project_ids_for(store, ["a"]) == {"a": None}


def test_with_project_fills_the_entity() -> None:
    store = FakeScheduledTaskStore()
    task_project.set_project(store, "task_1", "proj_1")
    [task] = task_project.with_project(store, [_task()])
    assert task.project_id == "proj_1"


# ── The default ──────────────────────────────────────────────────────────


def test_default_project_resolves_by_name_per_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    projects = _FakeProjectStore(
        {
            "alice@example.com": [_Project("p1", "Work"), _Project("p2", "Automation Notes")],
            "bob@example.com": [_Project("p3", "Work")],
        }
    )
    monkeypatch.setenv(task_project.DEFAULT_PROJECT_ENV, "automation notes")
    assert task_project.default_project_id(projects, "alice@example.com") == "p2"
    assert task_project.default_project_id(projects, "bob@example.com") is None
    assert task_project.default_project_id(None, "alice@example.com") is None
    monkeypatch.delenv(task_project.DEFAULT_PROJECT_ENV)
    assert task_project.default_project_id(projects, "alice@example.com") is None


# ── The fire ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fire_files_the_new_session_into_the_task_project() -> None:
    store = FakeScheduledTaskStore(rows={"task_1": _task()})
    task_project.set_project(store, "task_1", "p1")
    conversations = _FilingConversationStore()
    deps = _deps(store, conversation_store=conversations)
    deps.project_store = _FakeProjectStore({None: [_Project("p1", "Automation Notes")]})

    await build_on_fire(deps, launch_dispatch=_launch)(0, "task_1")
    await _drain()

    assert conversations.filed == {"conv_1": "p1"}
    assert store.runs[-1]["status"] == "running"


@pytest.mark.asyncio
async def test_fire_leaves_the_run_unfiled_when_the_project_is_gone() -> None:
    store = FakeScheduledTaskStore(rows={"task_1": _task()})
    task_project.set_project(store, "task_1", "deleted")
    conversations = _FilingConversationStore()
    deps = _deps(store, conversation_store=conversations)
    deps.project_store = _FakeProjectStore({None: [_Project("p1", "Automation Notes")]})

    await build_on_fire(deps, launch_dispatch=_launch)(0, "task_1")
    await _drain()

    assert conversations.filed == {}
    assert store.runs[-1]["status"] == "running"


@pytest.mark.asyncio
async def test_fire_without_a_project_never_files() -> None:
    store = FakeScheduledTaskStore(rows={"task_1": _task()})
    conversations = _FilingConversationStore()
    deps = _deps(store, conversation_store=conversations)
    deps.project_store = _FakeProjectStore({None: [_Project("p1", "Automation Notes")]})

    await build_on_fire(deps, launch_dispatch=_launch)(0, "task_1")
    await _drain()

    assert conversations.filed == {}


@pytest.mark.asyncio
async def test_a_failing_project_store_does_not_fail_the_fire() -> None:
    class _Broken(_FakeProjectStore):
        def get(self, project_id: str, *, user_id: str | None) -> _Project | None:
            raise RuntimeError("db down")

    store = FakeScheduledTaskStore(rows={"task_1": _task()})
    task_project.set_project(store, "task_1", "p1")
    conversations = _FilingConversationStore()
    deps = _deps(store, conversation_store=conversations)
    deps.project_store = _Broken({})

    await build_on_fire(deps, launch_dispatch=_launch)(0, "task_1")
    await _drain()

    assert conversations.filed == {}
    assert store.runs[-1]["status"] == "running"
