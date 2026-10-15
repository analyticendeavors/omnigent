"""Live approval updates must be verified against the target Codex thread."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from omnigent.harnesses.codex_native import permissions


class Client:
    def __init__(self, *, current=None, events=(), error=None):
        self.connect = AsyncMock()
        self.close = AsyncMock()
        self.request = AsyncMock(side_effect=error or [{"result": current or {}}, {"result": {}}])
        self.events = events

    async def iter_events(self):
        for event in self.events:
            yield event
        await asyncio.Future()


def changed(mode, thread_id="thread"):
    request = permissions.permission_settings(mode)
    return {
        "method": "thread/settings/updated",
        "params": {
            "threadId": thread_id,
            "threadSettings": {
                "approvalPolicy": request["approvalPolicy"],
                "approvalsReviewer": request["approvalsReviewer"],
                "activePermissionProfile": {"id": request["permissions"]},
            },
        },
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode", ["approve-for-me", "ask-for-approval", "full-access", "read-only"]
)
async def test_applies_and_confirms_each_preset(monkeypatch, mode):
    client = Client(events=[changed(mode, "another-thread"), changed(mode)])
    monkeypatch.setattr(permissions, "client_for_transport", lambda *a, **kw: client)
    assert await permissions.apply_permission_mode("/tmp/test.sock", "thread", mode)
    assert client.request.call_args_list[0].args == (
        "thread/resume",
        {"threadId": "thread", "excludeTurns": True},
    )
    assert client.request.call_args_list[1].args == (
        "thread/settings/update",
        {"threadId": "thread", **permissions.permission_settings(mode)},
    )
    client.close.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "events", [[], [changed("full-access")], [changed("approve-for-me", "other")]]
)
async def test_rpc_ack_or_wrong_settings_are_not_success(monkeypatch, events):
    client = Client(events=events)
    monkeypatch.setattr(permissions, "client_for_transport", lambda *a, **kw: client)
    assert not await permissions.apply_permission_mode(
        "sock", "thread", "approve-for-me", timeout_s=0.01
    )
    client.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_already_active_mode_is_idempotent(monkeypatch):
    client = Client(current=changed("approve-for-me")["params"]["threadSettings"])
    monkeypatch.setattr(permissions, "client_for_transport", lambda *a, **kw: client)
    assert await permissions.apply_permission_mode("sock", "thread", "approve-for-me")
    assert client.request.await_count == 1
    client.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_policy_error_propagates_and_closes(monkeypatch):
    client = Client(error=RuntimeError("disallowed by managed policy"))
    monkeypatch.setattr(permissions, "client_for_transport", lambda *a, **kw: client)
    with pytest.raises(RuntimeError, match="managed policy"):
        await permissions.apply_permission_mode("sock", "thread", "full-access")
    client.close.assert_awaited_once()


def test_switching_back_resets_auto_reviewer():
    assert permissions.permission_settings("ask-for-approval")["approvalsReviewer"] == "user"
    with pytest.raises(ValueError):
        permissions.permission_settings("unknown")


@pytest.mark.asyncio
async def test_never_policy_in_read_only_sandbox_is_not_full_access(monkeypatch):
    client = Client(
        current={
            "approvalPolicy": "never",
            "approvalsReviewer": "user",
            "sandbox": {"type": "readOnly"},
        },
        events=[changed("full-access")],
    )
    monkeypatch.setattr(permissions, "client_for_transport", lambda *a, **kw: client)
    assert await permissions.apply_permission_mode("sock", "thread", "full-access")
    assert client.request.await_count == 2
