"""
Publish the predicted next prompts to the session stream.

After each finished turn a native forwarder may post
``external_session_suggestion`` with up to three ranked one-line guesses at the
user's next message (see ``harnesses/ae_prompt_suggest_core.py``). This
validates the payload and broadcasts it as a transient ``session.suggestion``
event for the composer's ghost text; nothing is persisted. The type string and
bounds come from :mod:`omnigent.util.ae_session_suggestion`, which the
forwarder shares.
"""

from __future__ import annotations

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.routes._sessions.common import session_stream
from omnigent.server.schemas import SessionEventInput, SessionSuggestionEvent
from omnigent.util.ae_session_suggestion import (
    EXTERNAL_SESSION_SUGGESTION_TYPE,
    MAX_SUGGESTION_CHARS,
    MAX_SUGGESTIONS,
    SESSION_SUGGESTION_SSE_TYPE,
)

__all__ = ["EXTERNAL_SESSION_SUGGESTION_TYPE", "publish_external_session_suggestion"]


def _is_one_line(value: object) -> bool:
    return (
        isinstance(value, str)
        and bool(value.strip())
        and len(value) <= MAX_SUGGESTION_CHARS
        and "\n" not in value
        and "\r" not in value
    )


def _ranked_suggestions(data: dict[str, object]) -> list[str] | None:
    """
    The ranked list from ``data.suggestions``, or one from ``data.suggestion``.

    :raises OmnigentError: When a guess is not a non-empty single line within
        :data:`MAX_SUGGESTION_CHARS`, or the list is empty or longer than
        :data:`MAX_SUGGESTIONS`.
    """
    values = data.get("suggestions")
    if values is None:
        single = data.get("suggestion")
        values = None if single is None else [single]
    if values is None:
        return None
    if (
        not isinstance(values, list)
        or not 1 <= len(values) <= MAX_SUGGESTIONS
        or not all(_is_one_line(v) for v in values)
    ):
        raise OmnigentError(
            f"{EXTERNAL_SESSION_SUGGESTION_TYPE} data.suggestions must list 1 to "
            f"{MAX_SUGGESTIONS} non-empty lines of at most {MAX_SUGGESTION_CHARS} "
            "characters each (or data.suggestion one such line), or be null to clear them",
            code=ErrorCode.INVALID_INPUT,
        )
    return [v.strip() for v in values]


def publish_external_session_suggestion(session_id: str, body: SessionEventInput) -> None:
    """
    Broadcast the ranked predicted next prompts, or their clear.

    :param session_id: Session/conversation identifier, e.g. ``"conv_abc123"``.
    :param body: ``POST /events`` body whose type is
        :data:`EXTERNAL_SESSION_SUGGESTION_TYPE`; ``data.suggestions`` lists
        the guesses best first (``data.suggestion`` alone is read as a list of
        one), or both are ``None`` to clear.
    :raises OmnigentError: When the payload breaks the bounds above.
    """
    suggestions = _ranked_suggestions(body.data)
    event = SessionSuggestionEvent(
        type=SESSION_SUGGESTION_SSE_TYPE,
        conversation_id=session_id,
        suggestion=suggestions[0] if suggestions else None,
        suggestions=suggestions,
    )
    session_stream.publish(session_id, event.model_dump())
