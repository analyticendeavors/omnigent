"""The elicitation-observers registry and its call site in ``_resolve_elicitation``.

``omnigent.server.elicitation_observers`` lets out-of-tree code react to a
verdict the server accepts. Both routes that deliver one are covered through the
real app (the ``approval`` event and the ``.../resolve`` URL). The contract
under test: an observer sees the verdict with the prompt that was pending, a
verdict for an id that was not pending reaches it with ``None``, and an observer
that raises is logged and never fails the request.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from omnigent.runtime import pending_elicitations
from omnigent.server.elicitation_observers import (
    drain_elicitation_observers,
    register_elicitation_observer,
    reset_elicitation_observers,
    unregister_elicitation_observer,
)
from tests.server.helpers import create_test_agent

pytestmark = [pytest.mark.timeout(30), pytest.mark.asyncio]


@pytest.fixture(autouse=True)
def _clean_registry() -> Iterator[None]:
    reset_elicitation_observers()
    yield
    reset_elicitation_observers()


class _Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any], dict[str, Any] | None]] = []

    def __call__(
        self, session_id: str, elicitation_id: str, data: dict[str, Any], pending: Any
    ) -> None:
        self.calls.append((session_id, elicitation_id, dict(data), pending))


async def _session(client: httpx.AsyncClient) -> str:
    agent = await create_test_agent(client)
    resp = await client.post("/v1/sessions", json={"agent_id": agent["id"]})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _park(session_id: str, elicitation_id: str) -> None:
    pending_elicitations.record_publish(
        session_id,
        {
            "type": "response.elicitation_request",
            "elicitation_id": elicitation_id,
            "params": {"message": "Are you sure?"},
        },
    )


async def test_events_approval_path_notifies_with_the_pending_prompt(
    client: httpx.AsyncClient,
) -> None:
    recorder = _Recorder()
    register_elicitation_observer(recorder)
    sid = await _session(client)
    _park(sid, "elicit_events")

    resp = await client.post(
        f"/v1/sessions/{sid}/events",
        json={"type": "approval", "data": {"elicitation_id": "elicit_events", "action": "accept"}},
    )
    assert resp.status_code == 202, resp.text
    await drain_elicitation_observers()

    assert len(recorder.calls) == 1
    got_sid, got_eid, data, pending = recorder.calls[0]
    assert (got_sid, got_eid, data["action"]) == (sid, "elicit_events", "accept")
    assert pending is not None and pending["params"] == {"message": "Are you sure?"}


async def test_resolve_url_path_notifies_and_not_pending_reads_none(
    client: httpx.AsyncClient,
) -> None:
    recorder = _Recorder()
    register_elicitation_observer(recorder)
    sid = await _session(client)
    _park(sid, "elicit_url")

    first = await client.post(
        f"/v1/sessions/{sid}/elicitations/elicit_url/resolve", json={"action": "decline"}
    )
    assert first.status_code == 202, first.text
    await drain_elicitation_observers()
    again = await client.post(
        f"/v1/sessions/{sid}/elicitations/elicit_url/resolve", json={"action": "decline"}
    )
    assert again.status_code == 202, again.text
    await drain_elicitation_observers()

    assert [call[3] is not None for call in recorder.calls] == [True, False]


async def test_pending_on_another_session_is_not_handed_over(
    client: httpx.AsyncClient,
) -> None:
    recorder = _Recorder()
    register_elicitation_observer(recorder)
    sid = await _session(client)
    other = await _session(client)
    _park(other, "elicit_other")

    resp = await client.post(
        f"/v1/sessions/{sid}/elicitations/elicit_other/resolve", json={"action": "accept"}
    )
    assert resp.status_code == 202, resp.text
    await drain_elicitation_observers()

    assert [call[3] for call in recorder.calls] == [None]


async def test_a_raising_observer_is_logged_and_never_breaks_the_resolve(
    client: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    def boom(*_args: Any) -> None:
        raise RuntimeError("observer exploded")

    recorder = _Recorder()
    register_elicitation_observer(boom)
    register_elicitation_observer(recorder)
    sid = await _session(client)
    _park(sid, "elicit_boom")

    with caplog.at_level(logging.ERROR):
        resp = await client.post(
            f"/v1/sessions/{sid}/elicitations/elicit_boom/resolve", json={"action": "accept"}
        )
        await drain_elicitation_observers()

    assert resp.status_code == 202, resp.text
    assert len(recorder.calls) == 1
    assert "observer exploded" in caplog.text


async def test_unregister_stops_notifications(client: httpx.AsyncClient) -> None:
    recorder = _Recorder()
    register_elicitation_observer(recorder)
    register_elicitation_observer(recorder)
    unregister_elicitation_observer(recorder)
    sid = await _session(client)
    await client.post(
        f"/v1/sessions/{sid}/elicitations/elicit_x/resolve", json={"action": "accept"}
    )
    await drain_elicitation_observers()
    assert recorder.calls == []
