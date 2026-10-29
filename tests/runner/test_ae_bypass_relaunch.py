"""Tests for switching a claude-native session into or out of bypass by restarting the pane."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from omnigent.harnesses.claude_native import bridge as claude_native_bridge
from omnigent.runner.ae_bypass_relaunch import (
    BYPASS,
    BYPASS_REFUSALS,
    handle_claude_relaunch_switch,
    needs_relaunch,
)
from omnigent.runner.ae_claude_account import NOT_CLAUDE_DETAIL

SESSION_ID = "conv_bypass"


class _Terminal:
    async def is_alive(self) -> bool:
        return True


class _Registry:
    def __init__(self, pane: _Terminal | None) -> None:
        self.pane = pane

    def get(self, conversation_id: str, terminal_name: str, session_key: str) -> _Terminal | None:
        assert (conversation_id, terminal_name, session_key) == (SESSION_ID, "claude", "main")
        return self.pane


class _Runner:
    """Records close, delete event and ensure; ensure starts a pane."""

    def __init__(self, registry: _Registry, *, starts: bool = True) -> None:
        self.registry = registry
        self.starts = starts
        self.calls: list[str] = []

    async def close(self, session_id: str, terminal_id: str) -> bool:
        self.calls.append("close")
        self.registry.pane = None
        return True

    async def ensure(self, session_id: str, harness: str | None) -> None:
        self.calls.append("ensure")
        if self.starts:
            self.registry.pane = _Terminal()

    def publish(self, session_id: str, event: Any) -> None:
        self.calls.append("deleted")


async def _switch(
    runner: _Runner,
    *,
    target: str,
    current: str | None,
    settled: str | None,
    harness: str | None = "claude-native",
    busy: bool = False,
) -> tuple[int, dict[str, Any]]:
    async def current_mode() -> str | None:
        return current

    async def settled_mode() -> str | None:
        runner.calls.append("settled")
        return settled

    response = await handle_claude_relaunch_switch(
        SESSION_ID,
        target_mode=target,
        harness=harness,
        current_mode=current_mode,
        settled_mode=settled_mode,
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


async def test_already_in_the_target_mode_restarts_nothing() -> None:
    runner = _Runner(_Registry(_Terminal()))
    status, body = await _switch(runner, target=BYPASS, current=BYPASS, settled=None)
    assert (status, body) == (200, {"permission_mode": BYPASS, "relaunched": False})
    assert runner.calls == []


async def test_auto_to_bypass_restarts_the_pane_and_reports_bypass() -> None:
    runner = _Runner(_Registry(_Terminal()))
    status, body = await _switch(runner, target=BYPASS, current="auto", settled=BYPASS)
    assert (status, body) == (200, {"permission_mode": BYPASS, "relaunched": True})
    assert runner.calls == ["close", "deleted", "ensure", "settled"]


async def test_bypass_to_plan_restarts_the_pane_and_reports_plan() -> None:
    runner = _Runner(_Registry(_Terminal()))
    status, body = await _switch(runner, target="plan", current=BYPASS, settled="plan")
    assert (status, body) == (200, {"permission_mode": "plan", "relaunched": True})
    assert runner.calls == ["close", "deleted", "ensure", "settled"]


async def test_a_policy_that_strips_bypass_reports_the_mode_reached() -> None:
    runner = _Runner(_Registry(_Terminal()))
    status, body = await _switch(runner, target=BYPASS, current="auto", settled="default")
    assert (status, body) == (200, {"permission_mode": "default", "relaunched": True})


async def test_no_footer_omits_the_mode() -> None:
    runner = _Runner(_Registry(_Terminal()))
    status, body = await _switch(runner, target=BYPASS, current="auto", settled=None)
    assert (status, body) == (200, {"relaunched": True})


async def test_a_running_turn_refuses_and_closes_nothing() -> None:
    runner = _Runner(_Registry(_Terminal()))
    status, body = await _switch(runner, target=BYPASS, current="auto", settled=None, busy=True)
    assert (status, body["error"], body["detail"]) == (
        409,
        "claude_bypass_busy",
        BYPASS_REFUSALS.busy_detail,
    )
    assert runner.calls == []


async def test_a_parked_approval_refuses(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(claude_native_bridge, "approval_wait_is_fresh", lambda _sid: True)
    runner = _Runner(_Registry(_Terminal()))
    status, body = await _switch(runner, target=BYPASS, current="auto", settled=None)
    assert (status, body["error"]) == (409, "claude_bypass_busy")
    assert runner.calls == []


async def test_a_session_that_is_not_claude_native_is_a_400() -> None:
    for harness in ("codex-native", None):
        runner = _Runner(_Registry(_Terminal()))
        status, body = await _switch(
            runner, target=BYPASS, current="auto", settled=None, harness=harness
        )
        assert (status, body["detail"]) == (400, NOT_CLAUDE_DETAIL)
        assert runner.calls == []


async def test_a_terminal_that_does_not_start_is_a_409() -> None:
    runner = _Runner(_Registry(_Terminal()), starts=False)
    status, body = await _switch(runner, target=BYPASS, current="auto", settled=None)
    assert (status, body["error"], body["detail"]) == (
        409,
        "claude_bypass_not_started",
        BYPASS_REFUSALS.not_started_detail,
    )
    assert "settled" not in runner.calls


async def test_a_turn_arriving_mid_relaunch_waits_for_the_new_pane() -> None:
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
    switch = asyncio.create_task(_switch(runner, target=BYPASS, current="auto", settled=BYPASS))
    await in_ensure.wait()
    assert is_switching(SESSION_ID)
    seen_pane: list[_Terminal | None] = []

    async def turn() -> None:
        await wait_while_switching(SESSION_ID)
        seen_pane.append(runner.registry.pane)

    turn_task = asyncio.create_task(turn())
    await asyncio.sleep(0)
    assert not turn_task.done()
    release.set()
    assert (await switch)[0] == 200
    await turn_task
    assert seen_pane[0] is runner.registry.pane and seen_pane[0] is not None
    assert not is_switching(SESSION_ID)


@pytest.mark.parametrize(
    ("target", "current", "expected"),
    [
        (BYPASS, "auto", True),
        (BYPASS, None, True),
        (BYPASS, BYPASS, True),
        ("plan", BYPASS, True),
        ("default", BYPASS, True),
        ("plan", "auto", False),
        ("plan", None, False),
        ("auto", "default", False),
    ],
)
def test_needs_relaunch_truth_table(target: str, current: str | None, expected: bool) -> None:
    assert needs_relaunch(target, current) is expected
