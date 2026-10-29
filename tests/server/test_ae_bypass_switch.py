"""Tests for the server half of the Claude permission switch (launch-arg pinning)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from omnigent.errors import OmnigentError
from omnigent.server.routes._sessions.helpers import _RunnerForwardResult
from omnigent.server.routes.sessions import ae_bypass_switch
from omnigent.server.routes.sessions.ae_bypass_switch import (
    args_request_bypass,
    args_to_keep_when_unsure,
    relaunch_unconfirmed,
    switch_claude_permission_mode,
)

BYPASS_ARGS = ["--permission-mode", "bypassPermissions"]


class _Store:
    """Records every launch-args write."""

    def __init__(self) -> None:
        self.writes: list[list[str]] = []

    def update_conversation(self, session_id: str, *, terminal_launch_args: list[str]) -> None:
        self.writes.append(list(terminal_launch_args))


@pytest.mark.parametrize(
    ("args", "expected"),
    [
        (None, False),
        ([], False),
        (["--permission-mode", "plan"], False),
        (BYPASS_ARGS, True),
        (["--permission-mode=bypassPermissions"], True),
        (["--dangerously-skip-permissions"], True),
        (["--permission-mode", "bypassPermissions", "--permission-mode", "plan"], False),
    ],
)
def test_args_request_bypass(args: list[str] | None, expected: bool) -> None:
    assert args_request_bypass(args) is expected


@pytest.mark.parametrize(
    ("previous", "pinned", "kept"),
    [
        (["--permission-mode", "auto"], BYPASS_ARGS, ["--permission-mode", "auto"]),
        (None, BYPASS_ARGS, []),
        (BYPASS_ARGS, ["--permission-mode", "plan"], ["--permission-mode", "plan"]),
        (
            ["--permission-mode", "auto"],
            ["--permission-mode", "plan"],
            ["--permission-mode", "plan"],
        ),
        (BYPASS_ARGS, BYPASS_ARGS, BYPASS_ARGS),
    ],
)
def test_args_to_keep_when_unsure(
    previous: list[str] | None, pinned: list[str], kept: list[str]
) -> None:
    assert args_to_keep_when_unsure(previous, pinned) == kept


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        (200, '{"relaunched": true}', True),
        (200, '{"relaunched": true, "permission_mode": ""}', True),
        (200, '{"relaunched": true, "permission_mode": "plan"}', False),
        (200, '{"permission_mode": "plan"}', False),
        (200, "not json", False),
        (409, '{"relaunched": true}', False),
    ],
)
def test_relaunch_unconfirmed(status: int, body: str, expected: bool) -> None:
    assert relaunch_unconfirmed(_RunnerForwardResult(status_code=status, body=body)) is expected
    assert relaunch_unconfirmed(None) is False


async def test_a_cancelled_forward_leaves_the_safe_args_and_propagates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cancelling mid-forward must not strand an unconfirmed bypass pin."""

    async def _cancelled(*_args: Any, **_kwargs: Any) -> Any:
        raise asyncio.CancelledError

    monkeypatch.setattr(ae_bypass_switch, "_forward", _cancelled)
    store = _Store()
    with pytest.raises(asyncio.CancelledError):
        await switch_claude_permission_mode(
            "conv_x",
            store,
            None,
            ["--permission-mode", "auto"],
            "bypassPermissions",  # type: ignore[arg-type]
        )
    await asyncio.sleep(0)  # let the shielded write finish
    assert store.writes == [BYPASS_ARGS, ["--permission-mode", "auto"]]


async def test_a_cancelled_forward_when_leaving_bypass_keeps_the_new_pin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _cancelled(*_args: Any, **_kwargs: Any) -> Any:
        raise asyncio.CancelledError

    monkeypatch.setattr(ae_bypass_switch, "_forward", _cancelled)
    store = _Store()
    with pytest.raises(asyncio.CancelledError):
        await switch_claude_permission_mode("conv_x", store, None, BYPASS_ARGS, "plan")  # type: ignore[arg-type]
    await asyncio.sleep(0)
    assert store.writes[-1] == ["--permission-mode", "plan"]


async def test_a_runner_never_reached_restores_a_session_that_had_no_args(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _unreached(*_args: Any, **_kwargs: Any) -> Any:
        return None, False

    monkeypatch.setattr(ae_bypass_switch, "_forward", _unreached)
    store = _Store()
    with pytest.raises(OmnigentError):
        await switch_claude_permission_mode("conv_x", store, None, None, "bypassPermissions")  # type: ignore[arg-type]
    assert store.writes == [BYPASS_ARGS, []]
