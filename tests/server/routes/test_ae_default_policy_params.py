"""``PATCH /v1/policies/{policy_id}`` with ``factory_params`` (AE patch).

The Global Policies page saves a policy's edited parameters here. Params are
checked against the handler's registry schema, and the factory is built once,
because the schema passes values a factory rejects (``max_cost_usd: -1``).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from omnigent.runtime.agent_cache import AgentCache
from omnigent.server.app import create_app
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.stores.comment_store.sqlalchemy_store import SqlAlchemyCommentStore
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.file_store.sqlalchemy_store import SqlAlchemyFileStore
from omnigent.stores.policy_store.sqlalchemy_store import SqlAlchemyPolicyStore

_BUDGET = "omnigent.policies.builtins.cost.cost_budget"
_CALLABLE = "omnigent.policies.builtins.safety.ask_on_os_tools"


@pytest.fixture()
def policy_app(runtime_init: None, db_uri: str, tmp_path: Path) -> FastAPI:
    artifact_store = LocalArtifactStore(str(tmp_path / "artifacts"))
    return create_app(
        agent_store=SqlAlchemyAgentStore(db_uri),
        file_store=SqlAlchemyFileStore(db_uri),
        conversation_store=SqlAlchemyConversationStore(db_uri),
        artifact_store=artifact_store,
        agent_cache=AgentCache(artifact_store=artifact_store, cache_dir=tmp_path / "cache"),
        comment_store=SqlAlchemyCommentStore(db_uri),
        policy_store=SqlAlchemyPolicyStore(db_uri),
    )


@pytest_asyncio.fixture()
async def client(policy_app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=policy_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def _create(client: httpx.AsyncClient, handler: str, params: dict | None) -> str:
    body: dict = {"name": "budget", "type": "python", "handler": handler}
    if params is not None:
        body["factory_params"] = params
    resp = await client.post("/v1/policies", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


async def _params(client: httpx.AsyncClient, policy_id: str) -> dict | None:
    resp = await client.get(f"/v1/policies/{policy_id}")
    assert resp.status_code == 200
    return resp.json().get("factory_params")


async def test_new_params_replace_the_old(client: httpx.AsyncClient) -> None:
    pid = await _create(client, _BUDGET, {"max_cost_usd": 5})
    resp = await client.patch(f"/v1/policies/{pid}", json={"factory_params": {"max_cost_usd": 10}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["factory_params"] == {"max_cost_usd": 10}
    assert await _params(client, pid) == {"max_cost_usd": 10}


@pytest.mark.parametrize(
    ("params", "message"),
    [
        ({"max_cost_usd": -1}, "rejected these params"),
        ({"max_cost_usd": "ten"}, "must be number"),
        ({"bogus": 1}, "Unknown params"),
        ({}, "rejected these params"),
    ],
    ids=["factory rejects", "wrong type", "unknown key", "cleared but required"],
)
async def test_params_that_do_not_fit_are_refused(
    client: httpx.AsyncClient, params: dict, message: str
) -> None:
    pid = await _create(client, _BUDGET, {"max_cost_usd": 5})
    resp = await client.patch(f"/v1/policies/{pid}", json={"factory_params": params})
    assert resp.status_code == 400, resp.text
    assert message in resp.text
    assert await _params(client, pid) == {"max_cost_usd": 5}


async def test_a_callable_takes_no_params(client: httpx.AsyncClient) -> None:
    pid = await _create(client, _CALLABLE, None)
    resp = await client.patch(f"/v1/policies/{pid}", json={"factory_params": {"x": 1}})
    assert resp.status_code == 400
    assert "does not accept factory_params" in resp.text


async def test_a_toggle_leaves_the_params(client: httpx.AsyncClient) -> None:
    pid = await _create(client, _BUDGET, {"max_cost_usd": 5})
    resp = await client.patch(f"/v1/policies/{pid}", json={"enabled": False})
    assert resp.status_code == 200
    assert resp.json()["enabled"] is False
    assert await _params(client, pid) == {"max_cost_usd": 5}


async def test_params_for_a_missing_policy_are_404(client: httpx.AsyncClient) -> None:
    resp = await client.patch(
        "/v1/policies/0d2c1f4b7a9e4e8c9b3a5d6f7e8a9b0c",
        json={"factory_params": {"max_cost_usd": 10}},
    )
    assert resp.status_code == 404


async def test_unknown_fields_are_still_422(client: httpx.AsyncClient) -> None:
    pid = await _create(client, _BUDGET, {"max_cost_usd": 5})
    resp = await client.patch(f"/v1/policies/{pid}", json={"type": "url"})
    assert resp.status_code == 422


async def test_create_refuses_params_the_factory_rejects(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/v1/policies",
        json={
            "name": "budget",
            "type": "python",
            "handler": _BUDGET,
            "factory_params": {"max_cost_usd": -1},
        },
    )
    assert resp.status_code == 400, resp.text
    assert "rejected these params" in resp.text
    assert (await client.get("/v1/policies")).json()["data"] == []


async def test_a_new_handler_is_checked_against_the_stored_params(
    client: httpx.AsyncClient,
) -> None:
    pid = await _create(client, _BUDGET, {"max_cost_usd": 5})
    resp = await client.patch(f"/v1/policies/{pid}", json={"handler": _CALLABLE})
    assert resp.status_code == 400, resp.text
    assert "does not accept factory_params" in resp.text
    assert (await client.get(f"/v1/policies/{pid}")).json()["handler"] == _BUDGET


async def test_a_new_handler_with_cleared_params_is_saved(client: httpx.AsyncClient) -> None:
    pid = await _create(client, _BUDGET, {"max_cost_usd": 5})
    resp = await client.patch(
        f"/v1/policies/{pid}", json={"handler": _CALLABLE, "factory_params": None}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["handler"] == _CALLABLE
    assert await _params(client, pid) is None
