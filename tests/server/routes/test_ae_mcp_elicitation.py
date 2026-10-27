"""An MCP server's Elicitation hook parks as a permission-type card (omnigent-ae, 2026-10-27)."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from omnigent.errors import OmnigentError
from omnigent.server.routes.sessions.routes_ae_mcp_elicitation import (
    mcp_elicitation_answer,
    mcp_elicitation_params,
)

SCHEMA = {
    "type": "object",
    "properties": {
        "Confirm the operation": {
            "type": "string",
            "enum": ["Yes", "No"],
            "enumNames": ["Continue the operation", "Decline the operation"],
        }
    },
    "required": ["Confirm the operation"],
}
PAYLOAD = {
    "hook_event_name": "Elicitation",
    "mcp_server_name": "powerbi-modeling-sp",
    "message": "Delete table Sales?",
    "mode": "form",
    "requested_schema": SCHEMA,
}


def test_the_card_is_a_permission_prompt_with_the_servers_schema_and_no_question_payload() -> None:
    params = mcp_elicitation_params(PAYLOAD).model_dump(exclude_none=False)
    assert params["mode"] == "form"
    assert params["phase"] == "pre_tool_use"
    assert params["policy_name"] == "claude_native_permission"
    assert params["requestedSchema"] == SCHEMA
    assert params["message"] == "powerbi-modeling-sp asks: Delete table Sales?"
    assert params["tool_name"] == "mcp:powerbi-modeling-sp"
    for key in ("ask_user_question", "allow_auto_mode", "remember_scope", "exit_plan_mode"):
        assert not params.get(key), key


@pytest.mark.parametrize(
    "bad", [{"mcp_server_name": ""}, {"mcp_server_name": 3}, {"requested_schema": "x"}]
)
def test_a_malformed_body_is_refused(bad: dict[str, object]) -> None:
    with pytest.raises(OmnigentError):
        mcp_elicitation_params({**PAYLOAD, **bad})


def test_the_answer_is_claudes_hook_output_and_an_unanswered_wait_is_an_empty_200() -> None:
    accept = mcp_elicitation_answer(
        SimpleNamespace(action="accept", content={"Confirm the operation": "Yes"})
    )
    assert json.loads(accept.body) == {
        "hookSpecificOutput": {
            "hookEventName": "Elicitation",
            "action": "accept",
            "content": {"Confirm the operation": "Yes"},
        }
    }
    decline = mcp_elicitation_answer(SimpleNamespace(action="decline", content={"x": 1}))
    assert json.loads(decline.body)["hookSpecificOutput"] == {
        "hookEventName": "Elicitation",
        "action": "decline",
    }
    empty = mcp_elicitation_answer(None)
    assert empty.status_code == 200 and empty.body == b""


def test_the_route_needs_edit_access_not_read() -> None:
    """A read-only collaborator must not park a fake form in the owner's chat."""
    import inspect

    from omnigent.server.auth import LEVEL_EDIT
    from omnigent.server.routes.sessions import routes_ae_mcp_elicitation as module

    source = inspect.getsource(module.register_ae_mcp_elicitation_routes)
    assert "LEVEL_EDIT" in source and "LEVEL_READ" not in source
    assert module.LEVEL_EDIT == LEVEL_EDIT


@pytest.mark.asyncio
async def test_a_read_level_caller_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi import APIRouter
    from fastapi.testclient import TestClient  # noqa: F401  (route table only)

    from omnigent.server.auth import LEVEL_EDIT, LEVEL_READ
    from omnigent.server.routes.sessions import routes_ae_mcp_elicitation as module

    seen: list[int] = []

    async def fake_require(user, session_id, level, perms, store):
        seen.append(level)
        if level > LEVEL_READ:
            raise OmnigentError("forbidden", code="forbidden")  # type: ignore[arg-type]

    monkeypatch.setattr(module, "require_access", fake_require)
    monkeypatch.setattr(module, "get_user_id", lambda request, provider: "reader")
    router = APIRouter()
    module.register_ae_mcp_elicitation_routes(
        router,
        conversation_store=None,
        auth_provider=None,
        permission_store=None,  # type: ignore[arg-type]
    )
    handler = router.routes[0].endpoint  # type: ignore[attr-defined]

    class _Req:
        async def json(self) -> dict[str, object]:
            return PAYLOAD

    with pytest.raises(OmnigentError):
        await handler(_Req(), "conv_x")
    assert seen == [LEVEL_EDIT]
