"""
Publish a terminal agent's live spinner line to the session stream.

The claude-native forwarder posts ``external_session_progress`` with the
spinner Claude Code draws while a turn generates (``✻ Crunching… (4m 42s ·
↓ 24.5k tokens)``). This validates the payload and broadcasts it as a
transient ``session.progress`` event; nothing is persisted.
"""

from __future__ import annotations

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.routes._sessions.common import (
    _EXTERNAL_SESSION_PROGRESS_TYPE,
    session_stream,
)
from omnigent.server.schemas import SessionEventInput, SessionProgressEvent

EXTERNAL_SESSION_PROGRESS_TYPE: str = _EXTERNAL_SESSION_PROGRESS_TYPE

# Upper bounds on each field; the forwarder enforces the same ones.
_FIELD_LIMITS: dict[str, int] = {"label": 40, "elapsed": 20, "tokens": 30}


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
        raise OmnigentError(
            f"{EXTERNAL_SESSION_PROGRESS_TYPE} data.{key} must be a non-empty string "
            f"of at most {limit} characters",
            code=ErrorCode.INVALID_INPUT,
        )
    return value.strip()


def publish_external_session_progress(session_id: str, body: SessionEventInput) -> None:
    """
    Broadcast a terminal-observed spinner line, or its clear.

    ``data.label`` ``None`` clears the line; otherwise ``label`` and
    ``elapsed`` are required and ``tokens`` is optional.

    :param session_id: Session/conversation identifier, e.g. ``"conv_abc123"``.
    :param body: ``POST /events`` body whose type is
        :data:`EXTERNAL_SESSION_PROGRESS_TYPE`.
    :raises OmnigentError: When a field has the wrong type or length.
    """
    if body.data.get("label") is None:
        event = SessionProgressEvent(type="session.progress", conversation_id=session_id)
    else:
        event = SessionProgressEvent(
            type="session.progress",
            conversation_id=session_id,
            label=_bounded_text(body, "label", required=True),
            elapsed=_bounded_text(body, "elapsed", required=True),
            tokens=_bounded_text(body, "tokens", required=False),
        )
    session_stream.publish(session_id, event.model_dump())
