"""The last MCP server status a native harness reported, names and statuses only.

The codex-native forwarder posts each MCP startup map (``external_mcp_startup``);
upstream keeps it only while a server is still starting, so the session rail
reads the last full map from here. Error text never leaves the server.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import cachetools
from fastapi import APIRouter, Request

from omnigent.db.workspace_cache import WorkspaceScopedCache
from omnigent.server.auth import LEVEL_EDIT, AuthProvider
from omnigent.server.routes._auth_helpers import get_user_id, require_access
from omnigent.stores import ConversationStore
from omnigent.stores.permission_store import PermissionStore

if TYPE_CHECKING:
    from omnigent.server.schemas import McpServerStartup

# Codex startup states in the rail's vocabulary (the Claude probe's words).
_STATUS = {
    "starting": "pending",
    "ready": "connected",
    "failed": "failed",
    "cancelled": "cancelled",
}

_last_status: WorkspaceScopedCache[str, dict[str, object]] = WorkspaceScopedCache(
    lambda: cachetools.LRUCache(maxsize=2048)
)


def mcp_status_rows(servers: Mapping[str, McpServerStartup]) -> list[dict[str, str]]:
    """Name and status per server, sorted by name; never the error detail."""
    rows = []
    for name, record in servers.items():
        clean = name.strip()[:120] if isinstance(name, str) else ""
        if clean:
            rows.append({"name": clean, "status": _STATUS.get(record.status, "unknown")})
    return sorted(rows, key=lambda row: row["name"].lower())


def record_mcp_status(session_id: str, servers: Mapping[str, McpServerStartup]) -> None:
    """Keep the latest map; called wherever upstream publishes ``session.mcp_startup``."""
    _last_status[session_id] = {
        "servers": mcp_status_rows(servers),
        "observedAt": datetime.now(UTC).isoformat(),
    }


def register_ae_mcp_status_routes(
    router: APIRouter,
    *,
    conversation_store: ConversationStore,
    auth_provider: AuthProvider | None,
    permission_store: PermissionStore | None,
) -> None:
    @router.get("/sessions/{session_id}/ae-mcp-status")
    async def ae_mcp_status(request: Request, session_id: str) -> dict[str, object]:
        await require_access(
            get_user_id(request, auth_provider),
            session_id,
            LEVEL_EDIT,
            permission_store,
            conversation_store,
        )
        last = _last_status.get(session_id)
        if last is None:
            return {"available": False, "servers": [], "observedAt": None}
        return {"available": True, **last}
