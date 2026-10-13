"""Tests for :mod:`omnigent.server.host_connect_observers`.

The observer seam (background, never failing the connect) and the request-free
resume, which relaunches the runner with ``resume_interrupted_turn`` set.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from omnigent.server import child_session_recovery
from omnigent.server import host_connect_observers as seam
from omnigent.server.routes._sessions import orchestration
from omnigent.server.routes.sessions import routes_events


@pytest.fixture(autouse=True)
def _no_observers() -> Any:
    saved = seam.registered_host_connect_observers()
    for fn in saved:
        seam.unregister_host_connect_observer(fn)
    yield
    for fn in seam.registered_host_connect_observers():
        seam.unregister_host_connect_observer(fn)
    for fn in saved:
        seam.register_host_connect_observer(fn)


async def _drain() -> None:
    for _ in range(10):
        if not seam._pending:
            return
        await asyncio.gather(*list(seam._pending), return_exceptions=True)


# ── The seam ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_observers_run_in_the_background_and_a_failure_does_not_stop_the_next() -> None:
    seen: list[tuple[str, str | None, Any]] = []

    async def _broken(event: seam.HostConnectEvent) -> None:
        raise RuntimeError("boom")

    async def _after(event: seam.HostConnectEvent) -> None:
        seen.append((event.host_id, event.owner, event.conversation_store))

    seam.register_host_connect_observer(_broken)
    seam.register_host_connect_observer(_after)
    seam.register_host_connect_observer(_after)  # idempotent
    store = object()
    seam.notify_host_connected(object(), store, "h1", "alice@example.com")
    assert seen == []  # scheduled, not awaited inline
    await _drain()
    assert seen == [("h1", "alice@example.com", store)]


@pytest.mark.asyncio
async def test_notify_without_observers_schedules_nothing() -> None:
    seam.notify_host_connected(object(), object(), "h1", None)
    assert not seam._pending


# ── The resume ───────────────────────────────────────────────────────────


class _Store:
    def __init__(self, conv: Any) -> None:
        self.conv = conv

    def get_conversation(self, session_id: str) -> Any:
        return self.conv


def _patch_recovery(monkeypatch: pytest.MonkeyPatch, *, connected: bool) -> list[dict[str, Any]]:
    inits: list[dict[str, Any]] = []
    client = object()

    async def _get_runner_client(session_id: str, router: Any) -> Any:
        return client if connected else None

    async def _not_elsewhere(*args: Any, **kwargs: Any) -> None:
        return None

    async def _connect(*, conv: Any, **kwargs: Any) -> tuple[Any, Any]:
        return client, SimpleNamespace(**{**vars(conv), "runner_id": "runner_new"})

    async def _init(*args: Any, **kwargs: Any) -> bool:
        inits.append(kwargs)
        return False

    async def _relay(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(routes_events, "_get_runner_client", _get_runner_client)
    monkeypatch.setattr(routes_events, "_raise_if_runner_on_another_replica", _not_elsewhere)
    monkeypatch.setattr(routes_events, "ensure_runner_connected", _connect)
    monkeypatch.setattr(routes_events, "_ensure_runner_session_initialized", _init)
    monkeypatch.setattr(routes_events, "_is_native_terminal_session", lambda conv: False)
    monkeypatch.setattr(routes_events, "_ensure_runner_relay_ready", _relay)
    return inits


@pytest.mark.asyncio
async def test_resume_relaunches_and_continues_the_interrupted_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inits = _patch_recovery(monkeypatch, connected=False)
    store = _Store(SimpleNamespace(id="s1", runner_id="runner_old"))

    result = await seam.resume_interrupted_session(object(), store, "s1")

    assert result == {"queued": False, "recovered": True, "recovery": "runner_relaunched"}
    assert inits[-1]["resume_interrupted_turn"] is True
    assert inits[-1]["suppress_recovery_turn"] is False


@pytest.mark.asyncio
async def test_resume_on_a_connected_runner_starts_no_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inits = _patch_recovery(monkeypatch, connected=True)
    store = _Store(SimpleNamespace(id="s1", runner_id="runner_old"))

    result = await seam.resume_interrupted_session(object(), store, "s1")

    assert result["recovered"] is False
    assert inits[-1]["resume_interrupted_turn"] is False


@pytest.mark.asyncio
async def test_session_init_forwards_resume_interrupted_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, Any] = {}

    async def _noop(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(orchestration, "_ensure_runner_relay_ready", _noop)
    monkeypatch.setattr(child_session_recovery, "restore_active_children", _noop)

    class _Initializer:
        async def initialize(self, conv: Any, client: Any, **kwargs: Any) -> httpx.Response:
            seen.update(kwargs)
            return httpx.Response(
                201, json={}, request=httpx.Request("POST", "http://runner/v1/sessions")
            )

    conv = SimpleNamespace(
        id="s1", runner_id="r1", agent_id="a1", labels={}, inference_snapshot=None
    )
    await orchestration._ensure_runner_session_initialized(
        "s1",
        conv,  # type: ignore[arg-type]
        object(),  # type: ignore[arg-type]
        object(),  # type: ignore[arg-type]
        initializer=_Initializer(),  # type: ignore[arg-type]
        resume_interrupted_turn=True,
    )
    assert seen["resume_interrupted_turn"] is True
