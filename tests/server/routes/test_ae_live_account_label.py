"""``ae.claude_account`` is written by the bound runner only, never by a chat's editor."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from omnigent.harnesses.claude_native.ae_launch_account import ACCOUNT_LIVE_LABEL
from omnigent.runner.identity import (
    OMNIGENT_INTERNAL_WS_ORIGIN,
    RUNNER_TUNNEL_TOKEN_HEADER,
    token_bound_runner_id,
)
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore
from tests.server.routes.test_sessions_cost_labels import (
    _RUNNER_TOKEN,
    ALICE,
    BOB,
    _multi_user_app,
    _seed_session,
)

_Stores = tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore]


@pytest.fixture
def stores(db_uri: str) -> _Stores:
    """Real file-backed stores for the routes under test."""
    return (
        SqlAlchemyConversationStore(db_uri),
        SqlAlchemyAgentStore(db_uri),
        SqlAlchemyPermissionStore(db_uri),
    )


def test_editor_cannot_patch_live_account(stores: _Stores) -> None:
    """An editor on a shared chat cannot point it at the owner's backup login."""
    app = _multi_user_app(stores)
    conv_id = _seed_session(stores, editor=BOB)

    resp = TestClient(app).patch(
        f"/v1/sessions/{conv_id}",
        json={"labels": {ACCOUNT_LIVE_LABEL: "Backup"}},
        headers={"X-Forwarded-Email": BOB},
    )

    assert resp.status_code == 403
    conv = stores[0].get_conversation(conv_id)
    assert conv is not None
    assert ACCOUNT_LIVE_LABEL not in conv.labels


def test_create_rejects_live_account_seed(stores: _Stores) -> None:
    """A new chat cannot be created already naming a login."""
    _seed_session(stores)
    app = _multi_user_app(stores)

    resp = TestClient(app).post(
        "/v1/sessions",
        json={
            "agent_id": "087b7cb7ac30abf4debfaa578d052ec6",
            "labels": {ACCOUNT_LIVE_LABEL: "Backup"},
        },
        headers={"X-Forwarded-Email": ALICE, "Origin": OMNIGENT_INTERNAL_WS_ORIGIN},
    )

    assert resp.status_code == 400


def test_bound_runner_can_patch_live_account(stores: _Stores) -> None:
    """The runner's launch-time write still lands."""
    app = _multi_user_app(stores)
    conv_id = _seed_session(stores, runner_id=token_bound_runner_id(_RUNNER_TOKEN))

    resp = TestClient(app).patch(
        f"/v1/sessions/{conv_id}",
        json={"labels": {ACCOUNT_LIVE_LABEL: "Backup"}},
        headers={"X-Forwarded-Email": ALICE, RUNNER_TUNNEL_TOKEN_HEADER: _RUNNER_TOKEN},
    )

    assert resp.status_code == 200
    conv = stores[0].get_conversation(conv_id)
    assert conv is not None
    assert conv.labels[ACCOUNT_LIVE_LABEL] == "Backup"
