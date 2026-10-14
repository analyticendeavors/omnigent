"""Fast mode routes: how the web's switch reaches a claude-native runner.

Reid asked on 2026-10-14 for Claude Desktop's fast mode switch in the
composer's model menu, per session. Fast mode lives only in the running
Claude Code TUI (``fastModePerSessionOptIn`` keeps it out of settings), so
nothing is persisted here: both routes forward a control event to the bound
runner the way the model change does (``_forward_session_change_to_runner``),
and ``omnigent/runner/ae_fast_mode.py`` reads or flips the TUI.

``GET /v1/sessions/{id}/fast-mode``
    ``{"enabled": bool | null, "per_session": bool | null}``. ``enabled`` is
    ``null`` (unknown) when no runner answers or Claude Code has not reported
    fast mode yet; ``per_session`` says whether the runner's host keeps fast
    mode per session, which turning it on needs (``null`` when no runner
    answers). Read access.
``PUT /v1/sessions/{id}/fast-mode`` with ``{"enabled": bool}``
    ``200 {"enabled": bool}`` once the TUI confirmed it, or ``202 {"enabled":
    bool, "pending": true, "reason": str}`` when the command was typed but is
    not confirmed yet, or the runner's answer never arrived. Edit access, the
    level a model change needs, and a JSON body like every other control write.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, StrictBool

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.runner.routing import RunnerRouter
from omnigent.server.auth import LEVEL_EDIT, LEVEL_READ, AuthProvider
from omnigent.server.routes._auth_helpers import get_user_id, require_access
from omnigent.server.routes._content_type import require_json_content_type
from omnigent.server.routes._errors import session_not_found
from omnigent.server.routes._sessions.helpers import (
    _forward_session_change_to_runner,
    _RunnerForwardResult,
)
from omnigent.stores import ConversationStore
from omnigent.stores.permission_store import PermissionStore

# Past the runner's worst case: waiting out a change already running in the
# session, the pane heal, an injection with up to 20 s of submit verification,
# then the 10 s confirm poll.
FAST_MODE_FORWARD_TIMEOUT_S = 75.0

# A change whose answer never arrived may still have been typed, so the web
# keeps it pending and re-reads instead of reverting.
UNANSWERED_REASON = "Waiting for Claude Code to confirm"

_RUNNER_STATUS_CODES = {400: ErrorCode.INVALID_INPUT, 409: ErrorCode.CONFLICT}


class FastModeState(BaseModel):
    """The session's fast mode; ``None`` until Claude Code reports it."""

    enabled: bool | None
    per_session: bool | None = None


class FastModeChange(BaseModel):
    """A change's answer: the confirmed state, or the requested one still pending."""

    enabled: bool | None
    pending: bool | None = None
    reason: str | None = None


class FastModeChangeRequest(BaseModel):
    """Body of ``PUT /v1/sessions/{id}/fast-mode``."""

    model_config = ConfigDict(extra="forbid")

    enabled: StrictBool


def _runner_detail(result: _RunnerForwardResult) -> str:
    """Return the runner's own sentence for a failure, else its status code."""
    try:
        payload = json.loads(result.body)
    except (TypeError, ValueError):
        payload = None
    detail = payload.get("detail") if isinstance(payload, dict) else None
    if isinstance(detail, str) and detail.strip():
        return detail.strip()
    return f"the runner returned status {result.status_code}."


def _runner_answer(result: _RunnerForwardResult, *, action: str) -> dict[str, object]:
    """Return the runner's 2xx body as a dict, raising on a refusal."""
    if not 200 <= result.status_code < 300:
        raise OmnigentError(
            f"Could not {action}: {_runner_detail(result)}",
            code=_RUNNER_STATUS_CODES.get(result.status_code, ErrorCode.RUNNER_UNAVAILABLE),
        )
    try:
        payload = json.loads(result.body)
    except (TypeError, ValueError):
        payload = None
    return payload if isinstance(payload, dict) else {}


def _bool_or_none(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def register_ae_fast_mode_routes(
    router: APIRouter,
    *,
    conversation_store: ConversationStore,
    runner_router: RunnerRouter | None,
    auth_provider: AuthProvider | None,
    permission_store: PermissionStore | None,
) -> None:
    """
    Add the fast mode routes to the sessions router.

    :param router: The sessions router, mounted under ``/v1``.
    :param conversation_store: Store used for the access check and lookup.
    :param runner_router: Resolves the session's bound runner.
    :param auth_provider: Auth provider, or ``None`` when auth is off.
    :param permission_store: Permission store, or ``None`` when checks are off.
    """

    async def _authorized(request: Request, session_id: str, level: int) -> None:
        user_id = get_user_id(request, auth_provider)
        await require_access(user_id, session_id, level, permission_store, conversation_store)
        conv = await asyncio.to_thread(conversation_store.get_conversation, session_id)
        if conv is None or conv.agent_id is None:
            raise session_not_found()

    @router.get("/sessions/{session_id}/fast-mode")
    async def get_session_fast_mode(request: Request, session_id: str) -> FastModeState:
        """Read the session's fast mode from its Claude Code terminal."""
        await _authorized(request, session_id, LEVEL_READ)
        result = await _forward_session_change_to_runner(
            session_id, runner_router, {"type": "fast_mode_status"}
        )
        if result is None:
            return FastModeState(enabled=None)
        answer = _runner_answer(result, action="read fast mode")
        return FastModeState(
            enabled=_bool_or_none(answer.get("enabled")),
            per_session=_bool_or_none(answer.get("per_session")),
        )

    @router.put(
        "/sessions/{session_id}/fast-mode",
        dependencies=[Depends(require_json_content_type)],
        response_model_exclude_unset=True,
    )
    async def put_session_fast_mode(
        request: Request,
        response: Response,
        session_id: str,
        body: FastModeChangeRequest,
    ) -> FastModeChange:
        """Turn fast mode on or off in the session's Claude Code terminal."""
        await _authorized(request, session_id, LEVEL_EDIT)
        result = await _forward_session_change_to_runner(
            session_id,
            runner_router,
            {"type": "fast_mode_change", "enabled": body.enabled},
            timeout_s=FAST_MODE_FORWARD_TIMEOUT_S,
        )
        if result is None:
            # The helper answers None both when it found no runner and when the
            # request failed or timed out after it went out: the command may
            # have been typed.
            reason = UNANSWERED_REASON
        else:
            answer = _runner_answer(
                result, action=f"turn fast mode {'on' if body.enabled else 'off'}"
            )
            if result.status_code != 202:
                return FastModeChange(enabled=_bool_or_none(answer.get("enabled")))
            sent = answer.get("reason")
            reason = sent if isinstance(sent, str) and sent else UNANSWERED_REASON
        response.status_code = 202
        return FastModeChange(enabled=body.enabled, pending=True, reason=reason)
