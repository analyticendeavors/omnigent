"""The model a child session actually ran on, for the Agents pane's Model column."""

from __future__ import annotations

from typing import Any

from omnigent.entities.conversation import Conversation


def _model_with_most_tokens(session_usage: dict[str, Any]) -> str | None:
    """Return the model id that used the most tokens in a session's own usage."""
    by_model = session_usage.get("by_model")
    if not isinstance(by_model, dict):
        return None
    best: str | None = None
    best_tokens = -1.0
    for model, buckets in by_model.items():
        if not isinstance(model, str) or not model:
            continue
        tokens = buckets.get("total_tokens", 0) if isinstance(buckets, dict) else 0
        tokens = tokens if isinstance(tokens, (int, float)) else 0
        if tokens > best_tokens:
            best, best_tokens = model, tokens
    return best


def child_display_model(conv: Conversation) -> str | None:
    """
    Pick the model to show for a child session.

    The harness's own report wins (``reported_model``), then the model the
    child's own usage was recorded against (Codex collaborators report it
    there), then the model the user or the router requested.

    :param conv: The child conversation row.
    :returns: A model id such as ``"claude-sonnet-5-5"``, or ``None`` when
        nothing names one.
    """
    return (
        conv.reported_model
        or _model_with_most_tokens(conv.session_usage or {})
        or conv.model_override
    )
