"""Authorized, on-demand Claude context snapshots through the session runner."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Coroutine

from fastapi import APIRouter, Request

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.runner.routing import RunnerRouter
from omnigent.server.auth import LEVEL_EDIT, AuthProvider
from omnigent.server.routes._auth_helpers import get_user_id, require_access
from omnigent.server.routes._sessions.helpers import (
    _forward_session_change_to_runner,
    _get_runner_client,
)
from omnigent.server.routes.sessions.routes_ae_fast_mode import _runner_answer
from omnigent.server.routes.sessions.routes_core import (
    _is_native_terminal_session,
    _wake_runner_for_model_change,
)
from omnigent.stores import ConversationStore
from omnigent.stores.permission_store import PermissionStore

# How long one Try again waits for a sleeping runner to wake before answering `pending`.
WAKE_BUDGET_S = 45
# The whole request (wake plus read) stays under this many seconds.
REQUEST_BUDGET_S = 75
# A wake still running after this long is given up, so a hung launch never pins the panel.
WAKE_LIMIT_S = 120

# Wakes in flight, by session, so a retry joins one instead of starting another.
_wakes: dict[str, asyncio.Task[object]] = {}


def _wake_done(session_id: str, task: asyncio.Task[object]) -> None:
    """Forget a finished wake and read its outcome so a late failure is never unretrieved."""
    if _wakes.get(session_id) is task:
        del _wakes[session_id]
    if not task.cancelled():
        task.exception()


async def _bounded_wake(wake: Coroutine[object, object, object]) -> object:
    """Run one wake under WAKE_LIMIT_S; a hung wake ends as an offline answer, not forever."""
    try:
        return await asyncio.wait_for(wake, WAKE_LIMIT_S)
    except TimeoutError:
        raise OmnigentError(
            "Waking the session's runner took too long. Try again.",
            code=ErrorCode.RUNNER_UNAVAILABLE,
        ) from None


def register_context_usage_routes(
    router: APIRouter,
    *,
    conversation_store: ConversationStore,
    runner_router: RunnerRouter | None,
    auth_provider: AuthProvider | None,
    permission_store: PermissionStore | None,
) -> None:
    @router.get("/sessions/{session_id}/context-usage")
    async def context_usage(
        request: Request, session_id: str, fresh: bool = False, wake: bool = False
    ) -> dict[str, object]:
        await require_access(
            get_user_id(request, auth_provider),
            session_id,
            LEVEL_EDIT,
            permission_store,
            conversation_store,
        )
        task = _wakes.get(session_id)
        if task is not None and task.done():
            task = None
        if task is None and wake and await _get_runner_client(session_id, runner_router) is None:
            # Only the user's own refresh starts a wake.
            conv = await asyncio.to_thread(conversation_store.get_conversation, session_id)
            if conv is not None and conv.host_id is not None and _is_native_terminal_session(conv):
                task = _wakes.get(session_id)
                if task is None or task.done():
                    task = asyncio.ensure_future(
                        _bounded_wake(
                            _wake_runner_for_model_change(
                                request,
                                conv,
                                conversation_store,
                                runner_router,
                                action="read context",
                            )
                        )
                    )
                    _wakes[session_id] = task
                    task.add_done_callback(lambda t, sid=session_id: _wake_done(sid, t))
        timeout_s: float = 35
        if task is not None:
            # A wake that outlives the budget keeps running and later requests join it.
            began = time.monotonic()
            try:
                await asyncio.wait_for(asyncio.shield(task), WAKE_BUDGET_S)
            except TimeoutError:
                return {
                    "available": False,
                    "pending": True,
                    "reason": "Waking the session's runner\u2026",
                }
            except OmnigentError as exc:
                if exc.code == ErrorCode.RUNNER_UNAVAILABLE:
                    return {"available": False, "offline": True, "reason": exc.message}
                if exc.code in (ErrorCode.HARNESS_NOT_CONFIGURED, ErrorCode.WORKSPACE_MISSING):
                    # Retryable: the user may fix the host, so Try again stays.
                    return {"available": False, "reason": exc.message}
                raise
            timeout_s = max(5.0, REQUEST_BUDGET_S - (time.monotonic() - began))
        result = await _forward_session_change_to_runner(
            session_id,
            runner_router,
            # `fresh` asks the runner to skip its snapshot cache (turn end, refresh).
            {"type": "context_usage", "fresh": True} if fresh else {"type": "context_usage"},
            timeout_s=timeout_s,
        )
        if result is None:
            # `offline` tells the web this is a lost connection, shown at once, not a
            # runner still starting (`pending`), which the web retries quietly.
            return {
                "available": False,
                "offline": True,
                "reason": "The session's runner is asleep or did not answer. Try again wakes it.",
            }
        return _runner_answer(result, action="read context breakdown")
