"""Archiving a session deletes its claude-native bridge dir at once, not after 7 days."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

from omnigent.harnesses.claude_native import bridge
from omnigent.inner.native_attachments import attachment_cache_dir
from omnigent.runner import create_runner_app
from omnigent.server.routes import sessions as _sessions_facade
from tests.runner.helpers import NullServerClient
from tests.server.helpers import create_test_session
from tests.server.integration.test_sessions_archive import _drain_detached_stops

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _no_archive_stop_grace() -> object:
    with patch.object(_sessions_facade, "_ARCHIVE_STOP_UNDO_GRACE_S", 0.0):
        yield


async def test_archive_through_the_server_deletes_the_runners_bridge_dir(
    client: httpx.AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "claude-native"
    root.mkdir(mode=0o700)
    monkeypatch.setattr(bridge, "_BRIDGE_ROOT", root)
    monkeypatch.setattr(bridge, "_APPROVAL_WAIT_ROOT", root / "approval-waits")

    session = await create_test_session(client, name="archive-bridge-cleanup")
    session_id = session["id"]
    bridge_dir = bridge.prepare_bridge_dir(session_id, workspace=tmp_path)
    cache_dir = attachment_cache_dir(bridge_dir)
    cache_dir.mkdir(parents=True)
    assert (bridge_dir / "bridge.json").exists()

    runner_app = create_runner_app(server_client=NullServerClient())  # type: ignore[arg-type]
    transport = httpx.ASGITransport(app=runner_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://runner") as runner_client:

        async def _runner_for(*_args: object, **_kwargs: object) -> httpx.AsyncClient:
            return runner_client

        with patch.object(_sessions_facade, "_get_runner_client_for_resource_access", _runner_for):
            resp = await client.patch(f"/v1/sessions/{session_id}", json={"archived": True})
            await _drain_detached_stops()

    assert resp.status_code == 200
    assert not bridge_dir.exists()
    assert not cache_dir.exists()


async def test_archive_still_completes_when_the_runner_cleanup_fails(
    client: httpx.AsyncClient,
) -> None:
    session = await create_test_session(client, name="archive-cleanup-fails")
    session_id = session["id"]

    async def _boom(*_args: object, **_kwargs: object) -> httpx.AsyncClient:
        raise ConnectionError("runner offline")

    with patch.object(_sessions_facade, "_get_runner_client_for_resource_access", _boom):
        resp = await client.patch(f"/v1/sessions/{session_id}", json={"archived": True})
        await _drain_detached_stops()

    assert resp.status_code == 200
    assert resp.json()["archived"] is True
