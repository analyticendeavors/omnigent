"""The turn-edge registry and its three call sites.

``omnigent.server.ae_turn_edges`` hands every session status edge, every
interrupt, and the claude-native Stop hook's completed idle to observers. The
contract under test: ``_publish_status`` notifies with the status it was given,
the ``external_session_status`` route adds a ``turn_completed`` idle after the
plain one, ``_publish_interrupted`` notifies ``interrupted``, and an observer
that raises never breaks the publish.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator

import httpx
import pytest

from omnigent.server import ae_turn_edges
from omnigent.server.ae_turn_edges import (
    TurnEdge,
    notify_turn_edge,
    register_turn_edge_observer,
    reset_turn_edge_observers,
    unregister_turn_edge_observer,
)
from omnigent.server.routes._sessions.helpers import _publish_interrupted, _publish_status
from omnigent.server.routes.sessions import routes_events
from tests.server.helpers import create_test_agent

pytestmark = pytest.mark.timeout(30)


@pytest.fixture(autouse=True)
def _clean_registry() -> Iterator[None]:
    reset_turn_edge_observers()
    yield
    reset_turn_edge_observers()


def test_publish_status_notifies_with_the_status_it_was_given() -> None:
    seen: list[TurnEdge] = []
    register_turn_edge_observer(seen.append)

    _publish_status("conv_edges_a", "running", response_id="resp_1")

    assert seen == [TurnEdge("conv_edges_a", "running", "resp_1", False)]


def test_publish_interrupted_notifies_interrupted() -> None:
    seen: list[TurnEdge] = []
    register_turn_edge_observer(seen.append)

    _publish_interrupted("conv_edges_b", response_id="resp_2")

    assert seen == [TurnEdge("conv_edges_b", "interrupted", "resp_2", False)]


def test_registration_is_idempotent_and_reversible() -> None:
    seen: list[TurnEdge] = []
    register_turn_edge_observer(seen.append)
    register_turn_edge_observer(seen.append)
    notify_turn_edge("conv_edges_c", "idle", turn_completed=True)
    assert seen == [TurnEdge("conv_edges_c", "idle", None, True)]

    unregister_turn_edge_observer(seen.append)
    unregister_turn_edge_observer(seen.append)
    notify_turn_edge("conv_edges_c", "idle")
    assert len(seen) == 1


def test_a_failing_observer_never_breaks_the_publish(caplog: pytest.LogCaptureFixture) -> None:
    def broken(edge: TurnEdge) -> None:
        raise RuntimeError("observer exploded")

    seen: list[TurnEdge] = []
    register_turn_edge_observer(broken)
    register_turn_edge_observer(seen.append)

    with caplog.at_level(logging.ERROR, logger=ae_turn_edges.__name__):
        _publish_status("conv_edges_d", "running")

    assert [edge.status for edge in seen] == ["running"]
    assert any("broken failed for session=conv_edges_d" in r.getMessage() for r in caplog.records)


@pytest.fixture
def _no_runner(monkeypatch: pytest.MonkeyPatch) -> None:
    """The route forwards the edge to the session's runner; these sessions have none."""

    async def forward(*args: object, **kwargs: object) -> dict[str, object]:
        return {}

    monkeypatch.setattr(routes_events, "_forward_session_change_to_runner", forward)


@pytest.mark.usefixtures("_no_runner")
async def test_a_completed_idle_arrives_after_the_plain_idle(client: httpx.AsyncClient) -> None:
    agent = await create_test_agent(client, name="edges-route")
    created = await client.post("/v1/sessions", json={"agent_id": agent["id"]})
    assert created.status_code == 201, created.text
    session_id = created.json()["id"]
    seen: list[TurnEdge] = []
    register_turn_edge_observer(seen.append)

    resp = await client.post(
        f"/v1/sessions/{session_id}/events",
        json={
            "type": "external_session_status",
            "data": {"status": "idle", "response_id": "resp_stop", "turn_completed": True},
        },
    )
    assert resp.status_code in (200, 202, 204), resp.text

    mine = [edge for edge in seen if edge.session_id == session_id]
    assert [(e.status, e.turn_completed) for e in mine] == [("idle", False), ("idle", True)]
    assert mine[1].response_id == "resp_stop"


@pytest.mark.usefixtures("_no_runner")
async def test_an_idle_without_the_flag_is_not_a_completed_turn(client: httpx.AsyncClient) -> None:
    agent = await create_test_agent(client, name="edges-route-bare")
    created = await client.post("/v1/sessions", json={"agent_id": agent["id"]})
    session_id = created.json()["id"]
    seen: list[TurnEdge] = []
    register_turn_edge_observer(seen.append)

    resp = await client.post(
        f"/v1/sessions/{session_id}/events",
        json={"type": "external_session_status", "data": {"status": "idle"}},
    )
    assert resp.status_code in (200, 202, 204), resp.text

    assert [edge.turn_completed for edge in seen if edge.session_id == session_id] == [False]


@pytest.mark.usefixtures("_no_runner")
async def test_a_prompt_edge_notifies_observers_and_publishes_no_status(
    client: httpx.AsyncClient,
) -> None:
    agent = await create_test_agent(client, name="edges-route-prompt")
    created = await client.post("/v1/sessions", json={"agent_id": agent["id"]})
    session_id = created.json()["id"]
    seen: list[TurnEdge] = []
    register_turn_edge_observer(seen.append)

    resp = await client.post(
        f"/v1/sessions/{session_id}/events",
        json={
            "type": "external_session_status",
            "data": {"status": "running", "ae_prompt_edge": True},
        },
    )
    assert resp.status_code in (200, 202, 204), resp.text

    assert [(e.status, e.turn_completed) for e in seen if e.session_id == session_id] == [
        ("prompt", False)
    ]
