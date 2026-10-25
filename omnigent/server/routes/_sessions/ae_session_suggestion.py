"""
Publish the predicted next prompts to the session stream.

After each finished turn a native forwarder may post
``external_session_suggestion`` with up to three ranked one-line guesses at the
user's next message (see ``harnesses/ae_prompt_suggest_core.py``). This
validates the payload and broadcasts it as a transient ``session.suggestion``
event for the composer's ghost text. Nothing reaches the database: the latest
list is held in memory until a clear, the next ``running`` edge, or six
hours, and a new stream subscriber gets it replayed. The type string and
bounds come from :mod:`omnigent.util.ae_session_suggestion`, which the
forwarder shares.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from typing import Any

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.routes._sessions.common import _session_status_cache, session_stream
from omnigent.server.schemas import SessionEventInput, SessionSuggestionEvent
from omnigent.util.ae_session_suggestion import (
    EXTERNAL_SESSION_SUGGESTION_TYPE,
    MAX_SUGGESTION_CHARS,
    MAX_SUGGESTIONS,
    SESSION_SUGGESTION_SSE_TYPE,
)

__all__ = [
    "EXTERNAL_SESSION_SUGGESTION_TYPE",
    "forget",
    "publish_external_session_suggestion",
    "reset_for_tests",
    "snapshot_for",
]

_MAX_AGE_S = 6 * 3600
_MAX_SESSIONS = 1000

# Session id to (stored at, ``session.suggestion`` event). A lock guards it
# because ``_publish_status`` can run off the event loop.
_latest: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
# Session id to the monotonic time ``forget`` last ran. A guess whose status
# read began before that stamp may be for a turn that has already started, so
# ``_remember`` refuses it. Same cap and eviction as ``_latest``.
_forgotten_at: OrderedDict[str, float] = OrderedDict()
_lock = threading.Lock()


def forget(session_id: str) -> None:
    """Drop the held suggestion for ``session_id`` (a clear, or a turn starting)."""
    with _lock:
        _latest.pop(session_id, None)
        _forgotten_at[session_id] = time.monotonic()
        _forgotten_at.move_to_end(session_id)
        while len(_forgotten_at) > _MAX_SESSIONS:
            _forgotten_at.popitem(last=False)


def snapshot_for(session_id: str) -> list[dict[str, Any]]:
    """
    The held ``session.suggestion`` event for a new subscriber, as a list of 0 or 1.

    An entry older than six hours is dropped rather than replayed.
    """
    with _lock:
        entry = _latest.get(session_id)
        if entry is None:
            return []
        stored_at, event = entry
        if time.monotonic() - stored_at > _MAX_AGE_S:
            del _latest[session_id]
            return []
        return [dict(event)]


def reset_for_tests() -> None:
    """Clear every held suggestion."""
    with _lock:
        _latest.clear()
        _forgotten_at.clear()


def _remember(session_id: str, event: dict[str, Any], observed_at: float) -> None:
    """Hold ``event`` unless ``forget`` ran at or after ``observed_at``."""
    with _lock:
        if _forgotten_at.get(session_id, float("-inf")) >= observed_at:
            return
        _latest[session_id] = (time.monotonic(), dict(event))
        _latest.move_to_end(session_id)
        while len(_latest) > _MAX_SESSIONS:
            _latest.popitem(last=False)


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
    # Taken before the status read: a running edge after this point makes the
    # guess stale, and ``forget`` stamps it so ``_remember`` can tell.
    observed_at = time.monotonic()
    suggestions = _ranked_suggestions(body.data)
    event = SessionSuggestionEvent(
        type=SESSION_SUGGESTION_SSE_TYPE,
        conversation_id=session_id,
        suggestion=suggestions[0] if suggestions else None,
        suggestions=suggestions,
    )
    payload = event.model_dump()
    if suggestions is None:
        forget(session_id)
    elif _session_status_cache.get(session_id) != "running":
        # A guess posted mid-turn is stale on arrival (the web drops it too).
        _remember(session_id, payload, observed_at)
    session_stream.publish(session_id, payload)
