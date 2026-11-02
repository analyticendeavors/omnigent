"""Tests for :mod:`omnigent.server.scheduled.task_account`.

The ``claude_account`` pin (its own table, unset by default, ``""`` a real pin),
the host check on create and update, and stamping the account label on a fired
session without changing anything for an unpinned task.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from omnigent.errors import OmnigentError
from omnigent.onboarding.claude_accounts import CLAUDE_ACCOUNT_LABEL_KEY
from omnigent.server.scheduled import task_account
from omnigent.server.scheduled.fire import build_on_fire
from tests.server.scheduled.test_fire import (
    FakeScheduledTaskStore,
    _deps,
    _drain,
    _task,
)


async def _launch(conv: Any, task: Any) -> None:
    return None


# ── The setting ──────────────────────────────────────────────────────────


def test_account_round_trips_and_forgets_in_sqlite(db_uri: str) -> None:
    from omnigent.stores.scheduled_task_store.sqlalchemy_store import (
        SqlAlchemyScheduledTaskStore,
    )

    store = SqlAlchemyScheduledTaskStore(db_uri)
    assert task_account.accounts_for(store, ["a", "b"]) == {"a": None, "b": None}
    task_account.set_account(store, "a", "shared:AE Default")
    task_account.set_account(store, "b", "")
    task_account.set_account(store, "c", "x")
    task_account.set_account(store, "c", None)
    # "" is a real pin (the default login), distinct from no pin.
    assert task_account.accounts_for(store, ["a", "b", "c"]) == {
        "a": "shared:AE Default",
        "b": "",
        "c": None,
    }
    task_account.forget_account(store, "a")
    assert task_account.accounts_for(store, ["a"]) == {"a": None}


def test_with_account_fills_the_entity() -> None:
    store = FakeScheduledTaskStore(rows={})
    task_account.set_account(store, "task_1", "")
    [task] = task_account.with_account(store, [_task()])
    assert task.claude_account == ""


# ── The check ────────────────────────────────────────────────────────────


def _request(host_conn: Any, creds: list[dict[str, str]]) -> Any:
    registry = SimpleNamespace(get=lambda host_id: host_conn if host_id == "h1" else None)
    app = SimpleNamespace(state=SimpleNamespace(host_registry=registry))
    return SimpleNamespace(app=app), creds


@pytest.mark.asyncio
async def test_validate_rejects_an_account_the_connected_host_lacks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request, creds = _request(object(), [{"family": "claude-oauth", "env_var": "Work"}])

    async def _detect(**_: Any) -> dict[str, Any]:
        return {"credentials": creds}

    monkeypatch.setattr("omnigent.server.routes.hosts._proxy_detect_credentials", _detect)
    await task_account.validate_account(request, "Work", "h1")
    with pytest.raises(OmnigentError, match="unavailable on the task's host"):
        await task_account.validate_account(request, "Nope", "h1")


@pytest.mark.asyncio
async def test_validate_skips_when_the_host_is_offline_or_unpinned() -> None:
    request, _ = _request(None, [])
    await task_account.validate_account(request, "Anything", "h1")
    await task_account.validate_account(request, "Anything", None)
    await task_account.validate_account(request, "", "h1")


# ── The fire ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("account", ["shared:AE Default", ""])
async def test_fire_stamps_the_pinned_account(account: str) -> None:
    store = FakeScheduledTaskStore(rows={"task_1": _task()})
    task_account.set_account(store, "task_1", account)
    deps = _deps(store)

    await build_on_fire(deps, launch_dispatch=_launch)(0, "task_1")
    await _drain()

    assert deps.conversation_store.label_writes["conv_1"][CLAUDE_ACCOUNT_LABEL_KEY] == account
    assert store.runs[-1]["status"] == "running"


@pytest.mark.asyncio
async def test_fire_without_a_pin_writes_no_account_label() -> None:
    store = FakeScheduledTaskStore(rows={"task_1": _task()})
    deps = _deps(store)

    await build_on_fire(deps, launch_dispatch=_launch)(0, "task_1")
    await _drain()

    written = deps.conversation_store.label_writes.get("conv_1", {})
    assert CLAUDE_ACCOUNT_LABEL_KEY not in written
