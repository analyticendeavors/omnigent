"""
Publish a terminal agent's live spinner line to the session stream.

The claude-native forwarder posts ``external_session_progress`` with the
spinner Claude Code draws while a turn generates (``✻ Crunching… (4m 42s ·
↓ 24.5k tokens)``). This validates the payload and broadcasts it as a
transient ``session.progress`` event; nothing is persisted. The type string
and bounds come from :mod:`omnigent.util.ae_session_progress`, which the
forwarder shares.
"""

from __future__ import annotations

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.routes._sessions.common import session_stream
from omnigent.server.schemas import SessionEventInput, SessionProgressEvent
from omnigent.util.ae_session_progress import (
    EXTERNAL_SESSION_PROGRESS_TYPE,
    MAX_ELAPSED_CHARS,
    MAX_ELAPSED_S,
    MAX_LABEL_CHARS,
    MAX_TOKENS_CHARS,
    SESSION_PROGRESS_SSE_TYPE,
)

__all__ = ["EXTERNAL_SESSION_PROGRESS_TYPE", "publish_external_session_progress"]

_FIELD_LIMITS: dict[str, int] = {
    "label": MAX_LABEL_CHARS,
    "elapsed": MAX_ELAPSED_CHARS,
    "tokens": MAX_TOKENS_CHARS,
}


def _invalid(message: str) -> OmnigentError:
    """Build the route's 400 for a malformed progress payload."""
    return OmnigentError(
        f"{EXTERNAL_SESSION_PROGRESS_TYPE} {message}", code=ErrorCode.INVALID_INPUT
    )


def _bounded_text(body: SessionEventInput, key: str, *, required: bool) -> str | None:
    """
    Read one optional or required bounded string field from ``body.data``.

    :param body: ``POST /events`` body.
    :param key: Field name, e.g. ``"elapsed"``.
    :param required: Whether ``None`` (or absence) is rejected.
    :returns: The stripped value, or ``None`` when absent and allowed.
    :raises OmnigentError: When the value is not a non-empty string within its limit.
    """
    value = body.data.get(key)
    if value is None and not required:
        return None
    limit = _FIELD_LIMITS[key]
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise _invalid(f"data.{key} must be a non-empty string of at most {limit} characters")
    return value.strip()


def _elapsed_seconds(body: SessionEventInput) -> int | None:
    """
    Read the optional ``data.elapsed_s`` field.

    :param body: ``POST /events`` body.
    :returns: Whole seconds, or ``None`` when absent.
    :raises OmnigentError: When it is not an integer between 0 and a week.
    """
    value = body.data.get("elapsed_s")
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_ELAPSED_S:
        raise _invalid(f"data.elapsed_s must be an integer from 0 to {MAX_ELAPSED_S}")
    return value


def publish_external_session_progress(session_id: str, body: SessionEventInput) -> None:
    """
    Broadcast a terminal-observed spinner line, or its clear.

    ``data.label`` ``None`` clears the line; otherwise ``label`` and
    ``elapsed`` are required and ``elapsed_s`` and ``tokens`` are optional.

    :param session_id: Session/conversation identifier, e.g. ``"conv_abc123"``.
    :param body: ``POST /events`` body whose type is
        :data:`EXTERNAL_SESSION_PROGRESS_TYPE`.
    :raises OmnigentError: When a field has the wrong type or bounds.
    """
    if body.data.get("label") is None:
        event = SessionProgressEvent(type=SESSION_PROGRESS_SSE_TYPE, conversation_id=session_id)
    else:
        event = SessionProgressEvent(
            type=SESSION_PROGRESS_SSE_TYPE,
            conversation_id=session_id,
            label=_bounded_text(body, "label", required=True),
            elapsed=_bounded_text(body, "elapsed", required=True),
            elapsed_s=_elapsed_seconds(body),
            tokens=_bounded_text(body, "tokens", required=False),
        )
    session_stream.publish(session_id, event.model_dump())
