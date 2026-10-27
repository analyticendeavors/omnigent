"""Tests for switching a claude-native session's login in place (the runner side)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from omnigent.harnesses.claude_native import bridge as claude_native_bridge
from omnigent.runner.ae_claude_account import (
    BUSY_DETAIL,
    NOT_CLAUDE_DETAIL,
    NOT_STARTED_DETAIL,
    handle_claude_account_change,
)

SESSION_ID = "conv_switch"


class _Terminal:
    def __init__(self, alive: bool = True) -> None:
        self.alive = alive

    async def is_alive(self) -> bool:
        return self.alive


class _Registry:
    def __init__(self, pane: _Terminal | None) -> None:
        self.pane = pane

    def get(self, conversation_id: str, terminal_name: str, session_key: str) -> _Terminal | None:
        assert (conversation_id, terminal_name, session_key) == (SESSION_ID, "claude", "main")
        return self.pane


class _Runner:
    """Records the order of close, delete event and ensure; ensure starts a pane."""

    def __init__(self, registry: _Registry, *, starts: bool = True) -> None:
        self.registry = registry
        self.starts = starts
        self.calls: list[str] = []
        self.events: list[dict[str, Any]] = []

    async def close(self, session_id: str, terminal_id: str) -> bool:
        self.calls.append(f"close:{session_id}:{terminal_id}")
        self.registry.pane = None
        return True

    async def ensure(self, session_id: str, harness: str | None) -> None:
        self.calls.append(f"ensure:{session_id}:{harness}")
        if self.starts:
            self.registry.pane = _Terminal()

    def publish(self, session_id: str, event: Any) -> None:
        self.calls.append("deleted")
        self.events.append(dict(event))


async def _switch(
    runner: _Runner, *, harness: str | None = "claude-native", busy: bool = False
) -> tuple[int, dict[str, Any]]:
    response = await handle_claude_account_change(
        SESSION_ID,
        harness=harness,
        turn_in_flight=lambda: busy,
        terminal_registry=runner.registry,  # type: ignore[arg-type]
        close_terminal=runner.close,
        ensure_terminal=runner.ensure,
        publish_event=runner.publish,
    )
    return response.status_code, json.loads(bytes(response.body))


@pytest.fixture(autouse=True)
def _no_approval(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(claude_native_bridge, "approval_wait_is_fresh", lambda _sid: False)


async def test_an_idle_pane_is_closed_then_started_again() -> None:
    runner = _Runner(_Registry(_Terminal()))
    status, body = await _switch(runner)
    assert (status, body) == (200, {"relaunched": True})
    assert [c.split(":")[0] for c in runner.calls] == ["close", "deleted", "ensure"]
    assert runner.calls[0].startswith(f"close:{SESSION_ID}:")
    assert runner.events[0]["type"] == "session.resource.deleted"


async def test_no_pane_goes_straight_to_ensure() -> None:
    runner = _Runner(_Registry(None))
    status, _body = await _switch(runner)
    assert status == 200
    assert [c.split(":")[0] for c in runner.calls] == ["ensure"]


async def test_a_running_turn_refuses_and_closes_nothing() -> None:
    runner = _Runner(_Registry(_Terminal()))
    status, body = await _switch(runner, busy=True)
    assert (status, body["detail"]) == (409, BUSY_DETAIL)
    assert runner.calls == []


async def test_a_parked_approval_refuses(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(claude_native_bridge, "approval_wait_is_fresh", lambda _sid: True)
    runner = _Runner(_Registry(_Terminal()))
    status, body = await _switch(runner)
    assert (status, body["detail"]) == (409, BUSY_DETAIL)
    assert runner.calls == []


async def test_a_session_that_is_not_claude_native_is_a_400() -> None:
    for harness in ("codex-native", None):
        runner = _Runner(_Registry(_Terminal()))
        status, body = await _switch(runner, harness=harness)
        assert (status, body["detail"]) == (400, NOT_CLAUDE_DETAIL)
        assert runner.calls == []


async def test_a_terminal_that_does_not_start_is_a_409() -> None:
    runner = _Runner(_Registry(_Terminal()), starts=False)
    status, body = await _switch(runner)
    assert (status, body["detail"]) == (409, NOT_STARTED_DETAIL)


async def test_a_turn_arriving_mid_switch_waits_for_the_new_pane() -> None:
    import asyncio

    from omnigent.runner.ae_claude_account import is_switching, wait_while_switching

    runner = _Runner(_Registry(_Terminal()))
    in_ensure = asyncio.Event()
    release = asyncio.Event()
    plain_ensure = runner.ensure

    async def slow_ensure(session_id: str, harness: str | None) -> None:
        in_ensure.set()
        await release.wait()
        await plain_ensure(session_id, harness)

    runner.ensure = slow_ensure  # type: ignore[method-assign]
    switch = asyncio.create_task(_switch(runner))
    await in_ensure.wait()
    assert is_switching(SESSION_ID)
    seen_pane: list[_Terminal | None] = []

    async def turn() -> None:
        await wait_while_switching(SESSION_ID)
        seen_pane.append(runner.registry.pane)

    turn_task = asyncio.create_task(turn())
    await asyncio.sleep(0)
    assert not turn_task.done()  # held while the pane is being replaced
    release.set()
    assert (await switch)[0] == 200
    await turn_task
    assert seen_pane == [runner.registry.pane] and seen_pane[0] is not None
    assert not is_switching(SESSION_ID)


async def test_a_turn_waits_no_longer_than_its_bound() -> None:
    import asyncio

    from omnigent.runner import ae_claude_account as module

    module._switching[SESSION_ID] = asyncio.Event()
    try:
        await asyncio.wait_for(module.wait_while_switching(SESSION_ID, 0.01), 1.0)
    finally:
        module._switching.pop(SESSION_ID, None)


async def test_a_pane_that_stays_registered_is_not_reported_as_switched() -> None:
    runner = _Runner(_Registry(_Terminal()))
    pane = runner.registry.pane

    async def stuck_close(session_id: str, terminal_id: str) -> bool:
        runner.calls.append("close")
        return True  # claims success, but the same instance is still registered

    runner.close = stuck_close  # type: ignore[method-assign]
    status, body = await _switch(runner)
    assert status == 409 and body["error"] == "claude_account_not_closed"
    assert runner.registry.pane is pane
    assert not any(c.startswith("ensure") for c in runner.calls)


async def test_a_turn_admitted_after_the_mark_is_seen_by_the_busy_check() -> None:
    runner = _Runner(_Registry(_Terminal()))
    state = {"busy": False}

    def turn_in_flight() -> bool:
        # Read after the switching mark; a turn that landed meanwhile is counted.
        from omnigent.runner.ae_claude_account import is_switching

        assert is_switching(SESSION_ID)
        return state["busy"]

    state["busy"] = True
    response = await handle_claude_account_change(
        SESSION_ID,
        harness="claude-native",
        turn_in_flight=turn_in_flight,
        terminal_registry=runner.registry,  # type: ignore[arg-type]
        close_terminal=runner.close,
        ensure_terminal=runner.ensure,
        publish_event=runner.publish,
    )
    assert response.status_code == 409 and runner.calls == []
