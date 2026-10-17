"""Report the model each Claude Code subagent runs on to its mirrored child session."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

import httpx

from omnigent.models.model_metadata import concrete_reported_model

_logger = logging.getLogger(__name__)

# Child session id to the model last reported for it, so each model is posted once.
_reported: dict[str, str] = {}
# A model seen but not yet delivered, kept apart from the transcript cursor, which
# moves past the entry that named it; with the attempts made so far.
_pending: dict[str, tuple[str, int]] = {}
# A child whose posts keep failing (deleted server-side, say) stops being retried.
MAX_ATTEMPTS = 5

PostModel = Callable[..., Awaitable[None]]


async def report_subagent_model(
    client: httpx.AsyncClient,
    post_model_change: PostModel,
    *,
    child_session_id: str,
    latest_model: str | None,
) -> None:
    """
    Post a subagent's ``message.model`` to its child session once per change.

    A failed post is logged and retried on later transcript reads, even when no
    new entry names the model again, up to :data:`MAX_ATTEMPTS`. It never blocks
    forwarding the subagent's items.

    :param client: Omnigent HTTP client.
    :param post_model_change: The forwarder's ``external_model_change`` poster.
    :param child_session_id: The mirrored child session, e.g. ``"conv_child456"``.
    :param latest_model: ``message.model`` from the newest assistant entry read
        this tick, e.g. ``"claude-sonnet-5-5"``; ``None`` when none was read.
    """
    seen = concrete_reported_model(latest_model) if latest_model else None
    pending = _pending.get(child_session_id)
    if seen is not None and (pending is None or pending[0] != seen):
        pending = (seen, 0)
    if pending is None:
        return
    model, attempts = pending
    if _reported.get(child_session_id) == model:
        _pending.pop(child_session_id, None)
        return
    if attempts >= MAX_ATTEMPTS:
        return
    try:
        await post_model_change(client, session_id=child_session_id, model=model)
    except httpx.HTTPError as exc:
        _pending[child_session_id] = (model, attempts + 1)
        _logger.warning(
            "Could not report claude-native sub-agent model; "
            "child=%s model=%s attempt=%s error=%s",
            child_session_id,
            model,
            attempts + 1,
            exc,
        )
        return
    _pending.pop(child_session_id, None)
    _reported[child_session_id] = model
