"""The context probe is only dispatched after session authorization."""

import json
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from omnigent.server.routes._sessions.helpers import _RunnerForwardResult
from omnigent.server.routes.sessions import routes_ae_context_usage as routes
from tests.server.routes.test_ae_fast_mode_routes import OWNER, VIEWER, _app, _seed_session


@pytest.mark.parametrize(
    "user,expected", [(OWNER, 200), (VIEWER, 200), ("stranger@example.com", 404)]
)
def test_access(db_uri, monkeypatch, user, expected):
    session = _seed_session(db_uri)
    forward = AsyncMock(
        return_value=_RunnerForwardResult(
            status_code=200, body=json.dumps({"available": True}).encode()
        )
    )
    monkeypatch.setattr(routes, "_forward_session_change_to_runner", forward)
    with TestClient(_app(db_uri)) as client:
        response = client.get(
            f"/v1/sessions/{session}/context-usage", headers={"X-Forwarded-Email": user}
        )
    assert response.status_code == expected
    assert forward.await_count == (1 if expected == 200 else 0)
