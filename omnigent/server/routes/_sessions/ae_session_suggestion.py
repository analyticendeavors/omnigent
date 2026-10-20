"""
Publish a predicted next prompt to the session stream.

After each finished turn the claude-native forwarder may post
``external_session_suggestion`` with a one-line guess at the user's next
message (see ``harnesses/claude_native/ae_prompt_suggest.py``). This validates
the payload and broadcasts it as a transient ``session.suggestion`` event for
the composer's ghost text; nothing is persisted. The type string and bound come
from :mod:`omnigent.util.ae_session_suggestion`, which the forwarder shares.
"""

from __future__ import annotations

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.routes._sessions.common import session_stream
from omnigent.server.schemas import SessionEventInput, SessionSuggestionEvent
from omnigent.util.ae_session_suggestion import (
    EXTERNAL_SESSION_SUGGESTION_TYPE,
    MAX_SUGGESTION_CHARS,
    SESSION_SUGGESTION_SSE_TYPE,
)

__all__ = ["EXTERNAL_SESSION_SUGGESTION_TYPE", "publish_external_session_suggestion"]


def publish_external_session_suggestion(session_id: str, body: SessionEventInput) -> None:
    """
    Broadcast a predicted next prompt, or its clear.

    :param session_id: Session/conversation identifier, e.g. ``"conv_abc123"``.
    :param body: ``POST /events`` body whose type is
        :data:`EXTERNAL_SESSION_SUGGESTION_TYPE`; ``data.suggestion`` is one
        line of text, or ``None`` to clear.
    :raises OmnigentError: When the suggestion is not a non-empty single line
        within :data:`MAX_SUGGESTION_CHARS`.
    """
    value = body.data.get("suggestion")
    if value is not None:
        if (
            not isinstance(value, str)
            or not value.strip()
            or len(value) > MAX_SUGGESTION_CHARS
            or "\n" in value
            or "\r" in value
        ):
            raise OmnigentError(
                f"{EXTERNAL_SESSION_SUGGESTION_TYPE} data.suggestion must be one non-empty "
                f"line of at most {MAX_SUGGESTION_CHARS} characters, or null to clear it",
                code=ErrorCode.INVALID_INPUT,
            )
        value = value.strip()
    event = SessionSuggestionEvent(
        type=SESSION_SUGGESTION_SSE_TYPE, conversation_id=session_id, suggestion=value
    )
    session_stream.publish(session_id, event.model_dump())
