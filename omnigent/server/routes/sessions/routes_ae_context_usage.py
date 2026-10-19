"""Authorized, on-demand Claude context snapshots through the session runner."""

from __future__ import annotations

from fastapi import APIRouter, Request

from omnigent.runner.routing import RunnerRouter
from omnigent.server.auth import LEVEL_EDIT, AuthProvider
from omnigent.server.routes._auth_helpers import get_user_id, require_access
from omnigent.server.routes._sessions.helpers import _forward_session_change_to_runner
from omnigent.server.routes.sessions.routes_ae_fast_mode import _runner_answer
from omnigent.stores import ConversationStore
from omnigent.stores.permission_store import PermissionStore


def register_context_usage_routes(
    router: APIRouter,
    *,
    conversation_store: ConversationStore,
    runner_router: RunnerRouter | None,
    auth_provider: AuthProvider | None,
    permission_store: PermissionStore | None,
) -> None:
    @router.get("/sessions/{session_id}/context-usage")
    async def context_usage(request: Request, session_id: str) -> dict[str, object]:
        await require_access(
            get_user_id(request, auth_provider),
            session_id,
            LEVEL_EDIT,
            permission_store,
            conversation_store,
        )
        result = await _forward_session_change_to_runner(
            session_id,
            runner_router,
            {"type": "context_usage"},
            timeout_s=35,
        )
        if result is None:
            # `offline` tells the web this is a lost connection, shown at once, not a
            # runner still starting (`pending`), which the web retries quietly.
            return {
                "available": False,
                "offline": True,
                "reason": "Context request timed out or the runner is offline. Try again shortly.",
            }
        return _runner_answer(result, action="read context breakdown")
