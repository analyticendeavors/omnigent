"""Park a Claude Code MCP-server elicitation as a pending elicitation (omnigent-ae, 2026-10-27).

Claude Code's ``Elicitation`` hook fires when an MCP server asks the user a question (for
example powerbi-modeling-sp with ``--require-confirmation``). Nothing registered it, so the
question only ever reached the TUI. The wrapper now forwards it here and the answer goes
back as the hook's ``hookSpecificOutput``. The prompt is a permission-type card (policy
``claude_native_permission``, the server's schema as a form) and never carries
``ask_user_question``, so the lead's ``answer_child_question`` relay tool refuses it: only
The owner answers an MCP prompt.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Depends, Request, Response, status

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import LEVEL_EDIT, AuthProvider
from omnigent.server.routes._auth_helpers import get_user_id, require_access
from omnigent.server.routes._content_type import require_json_content_type
from omnigent.server.routes._sessions.helpers import _client_supplied_hook_elicitation_id
from omnigent.server.routes._sessions.orchestration import (
    _publish_and_wait_for_harness_elicitation,
)
from omnigent.server.schemas import ElicitationRequestParams
from omnigent.stores import ConversationStore
from omnigent.stores.permission_store import PermissionStore

if TYPE_CHECKING:
    from omnigent.spec.types import ElicitationResult


def mcp_elicitation_params(payload: dict[str, Any]) -> ElicitationRequestParams:
    """The card for one ``Elicitation`` hook payload.

    :raises OmnigentError: 400 when ``mcp_server_name`` or ``requested_schema`` is malformed.
    """
    server = payload.get("mcp_server_name")
    if not isinstance(server, str) or not server.strip():
        raise OmnigentError(
            "Elicitation hook body must include a non-empty 'mcp_server_name' string.",
            code=ErrorCode.INVALID_INPUT,
        )
    schema = payload.get("requested_schema")
    if schema is not None and not isinstance(schema, dict):
        raise OmnigentError(
            "Elicitation hook body 'requested_schema' must be an object when present.",
            code=ErrorCode.INVALID_INPUT,
        )
    raw_message = payload.get("message")
    message = raw_message.strip() if isinstance(raw_message, str) else ""
    # A permission-type prompt: no ask_user_question, exit_plan_mode, allow_auto_mode or
    # remember_scope. The relay tool keys off the first to refuse it.
    return ElicitationRequestParams(
        mode="form",
        message=f"{server.strip()} asks: {message}" if message else f"{server.strip()} asks",
        requestedSchema=schema or None,
        url=None,
        phase="pre_tool_use",
        policy_name="claude_native_permission",
        content_preview=message[:1024],
        tool_name=f"mcp:{server.strip()}",
    )


def mcp_elicitation_answer(result: ElicitationResult | None) -> Response:
    """The hook's reply: Claude's ``hookSpecificOutput``, or an empty 200 (TUI fallback)."""
    if result is None:
        return Response(status_code=status.HTTP_200_OK)
    output: dict[str, Any] = {"hookEventName": "Elicitation", "action": result.action}
    if result.action == "accept" and isinstance(result.content, dict):
        output["content"] = result.content
    return Response(
        content=json.dumps({"hookSpecificOutput": output}), media_type="application/json"
    )


def register_ae_mcp_elicitation_routes(
    router: APIRouter,
    *,
    conversation_store: ConversationStore,
    auth_provider: AuthProvider | None,
    permission_store: PermissionStore | None,
) -> None:
    @router.post(
        "/sessions/{session_id}/hooks/ae-mcp-elicitation",
        include_in_schema=False,
        response_model=None,
        dependencies=[Depends(require_json_content_type)],
    )
    async def ae_mcp_elicitation_hook(request: Request, session_id: str) -> Response:
        from omnigent.server.routes import sessions as _sf

        await require_access(
            get_user_id(request, auth_provider),
            session_id,
            LEVEL_EDIT,
            permission_store,
            conversation_store,
        )
        try:
            payload = await request.json()
        except json.JSONDecodeError as exc:
            raise OmnigentError(
                f"Invalid JSON in Elicitation hook body: {exc}", code=ErrorCode.INVALID_INPUT
            ) from exc
        if not isinstance(payload, dict):
            raise OmnigentError(
                "Elicitation hook body must be a JSON object.", code=ErrorCode.INVALID_INPUT
            )
        params = mcp_elicitation_params(payload)
        result = await _publish_and_wait_for_harness_elicitation(
            request,
            session_id=session_id,
            params=params,
            timeout_s=_sf._CLAUDE_NATIVE_PERMISSION_HOOK_TIMEOUT_S,
            conversation_store=conversation_store,
            elicitation_id=_client_supplied_hook_elicitation_id(payload, session_id),
            tool_name=None,
        )
        return mcp_elicitation_answer(result)
