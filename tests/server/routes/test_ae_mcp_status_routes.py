"""The rail's Codex connector status: names and statuses only, after authorization."""

import pytest
from fastapi.testclient import TestClient

from omnigent.server.routes._sessions.helpers import _publish_mcp_startup
from omnigent.server.routes.sessions import routes_ae_mcp_status as routes
from omnigent.server.schemas import McpServerStartup
from tests.server.routes.test_ae_fast_mode_routes import OWNER, VIEWER, _app, _seed_session


def test_rows_map_codex_states_and_drop_error_text():
    rows = routes.mcp_status_rows(
        {
            "playwright": McpServerStartup(status="ready"),
            "Fabric": McpServerStartup(status="failed", error="HTTP 403 token=abc"),
            "slow": McpServerStartup(status="starting"),
            "stopped": McpServerStartup(status="cancelled"),
            "   ": McpServerStartup(status="ready"),
            "y" * 300: McpServerStartup(status="ready"),
        }
    )
    assert rows == [
        {"name": "Fabric", "status": "failed"},
        {"name": "playwright", "status": "connected"},
        {"name": "slow", "status": "pending"},
        {"name": "stopped", "status": "cancelled"},
        {"name": "y" * 120, "status": "connected"},
    ]
    assert "token" not in repr(rows)


@pytest.mark.parametrize(
    "user,expected", [(OWNER, 200), (VIEWER, 403), ("stranger@example.com", 404)]
)
def test_access(db_uri, user, expected):
    session = _seed_session(db_uri)
    with TestClient(_app(db_uri)) as client:
        response = client.get(
            f"/v1/sessions/{session}/ae-mcp-status", headers={"X-Forwarded-Email": user}
        )
    assert response.status_code == expected


def test_keeps_the_settled_map_upstream_evicts(db_uri):
    session = _seed_session(db_uri)
    with TestClient(_app(db_uri)) as client:
        empty = client.get(
            f"/v1/sessions/{session}/ae-mcp-status", headers={"X-Forwarded-Email": OWNER}
        ).json()
        assert empty == {"available": False, "servers": [], "observedAt": None}
        _publish_mcp_startup(session, {"ae": McpServerStartup(status="starting")})
        _publish_mcp_startup(
            session,
            {
                "ae": McpServerStartup(status="ready"),
                "raymcp": McpServerStartup(status="failed", error="secret header"),
            },
        )
        body = client.get(
            f"/v1/sessions/{session}/ae-mcp-status", headers={"X-Forwarded-Email": OWNER}
        ).json()
    assert body["available"] is True
    assert body["servers"] == [
        {"name": "ae", "status": "connected"},
        {"name": "raymcp", "status": "failed"},
    ]
    assert isinstance(body["observedAt"], str)
    assert "secret" not in repr(body)
