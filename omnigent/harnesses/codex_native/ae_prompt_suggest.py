"""
Predict the user's next prompt after each finished Codex turn.

The Codex half of the prompt suggestions the Claude forwarder already makes
(``claude_native/ae_prompt_suggest.py``). The forwarder notes each turn's
``userMessage`` and ``agentMessage`` text as their ``item/completed`` events
pass (Codex sends every item of a turn before its ``turn/completed``, on the
same ordered stream), and on the live ``turn/completed`` that posts the
session's ``idle`` edge it hands the turn's last prompt and last reply to the
shared side call (:mod:`omnigent.harnesses.ae_prompt_suggest_core`): Claude
Haiku on the host's active Claude account (what a Claude terminal launched
without a choice would get), whatever model the Codex session runs. The
answer reaches the composer as the same ``external_session_suggestion`` event,
so the web needs nothing new.

Skipped: sub-agent threads and sessions, interrupted or failed turns, a turn
whose reply asks the user questions, a Plan turn whose implementation prompt
is about to ask the user, and hosts whose Claude runs on a gateway, Bedrock or
Vertex. A new turn, a ``/clear`` rotation and the forwarder's exit cancel a
call in flight (a new turn's ``running`` edge clears the composer). Off unless
``AE_PROMPT_SUGGESTIONS=1``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Final, Protocol

import httpx

from omnigent.harnesses.ae_prompt_suggest_core import (
    MAX_CONTEXT_CHARS,
    MAX_PROMPT_CHARS,
    MAX_TURN_AGE_S,
    SuggestionState,
    TurnContext,
    account_login_env,
    cancel_prompt_suggestion,
    clear_prompt_suggestion,
    is_child_session,
    suggest_and_post,
    suggestions_enabled,
    uses_default_provider,
)

__all__ = [
    "CodexSuggestionState",
    "cancel_prompt_suggestion",
    "clear_prompt_suggestion",
    "note_turn_item",
    "reset_prompt_suggestion",
    "schedule_codex_prompt_suggestion",
]

_logger = logging.getLogger(__name__)

_TURN_COMPLETED: Final = "turn/completed"


@dataclass
class _TurnText:
    """The latest typed prompt and reply seen for one turn."""

    turn_id: str
    user_prompt: str = ""
    assistant_text: str = ""
    asks_user: bool = False


@dataclass
class CodexSuggestionState(SuggestionState):
    """
    :class:`SuggestionState` plus the text of each session's current turn.

    :param turns: Per Omnigent session id, the latest turn's text, e.g.
        ``{"conv_a": _TurnText("turn_1", "fix it", "Fixed.")}``. One entry per
        session; a newer turn replaces it.
    """

    turns: dict[str, _TurnText] = field(default_factory=dict)


class _ForwarderState(Protocol):
    """The parts of the Codex forwarder's state this module reads."""

    ae_prompt_suggest: CodexSuggestionState
    parent_session_id: str | None

    def plan_prompt_context(self, turn_id: str) -> tuple[str, str] | None: ...


def _turn_id(params: Mapping[str, object]) -> str | None:
    """The turn id of an ``item/completed`` or ``turn/completed`` payload."""
    turn = params.get("turn")
    if isinstance(turn, Mapping) and isinstance(turn.get("id"), str) and turn["id"]:
        return str(turn["id"])
    turn_id = params.get("turnId")
    return turn_id if isinstance(turn_id, str) and turn_id else None


def _record(text: _TurnText, item: Mapping[str, object]) -> None:
    """Fold one completed item into its turn's text."""
    # The forwarder's own readers, so a prompt reads here as it is mirrored.
    from omnigent.harnesses.codex_native.forwarder import (
        _is_codex_skill_wrapper,
        _user_message_text,
    )

    item_type = item.get("type")
    if item_type == "userMessage":
        prompt = _user_message_text(dict(item)).strip()
        if prompt and not _is_codex_skill_wrapper(prompt):
            text.user_prompt = prompt[:MAX_PROMPT_CHARS]
    elif item_type == "agentMessage":
        reply = item.get("text")
        questions = item.get("questions")
        text.asks_user = isinstance(questions, list) and bool(questions)
        if isinstance(reply, str) and reply.strip():
            # Only the tail reaches the side call, so only the tail is kept.
            text.assistant_text = reply.strip()[-MAX_CONTEXT_CHARS:]


def note_turn_item(
    forwarder_state: _ForwarderState | None,
    session_id: str,
    params: Mapping[str, object],
    item: Mapping[str, object],
) -> None:
    """
    Remember a parent session's completed ``userMessage`` or ``agentMessage``.

    Called by the forwarder for every completed item it sees (live, replayed
    or recovered); a child session's items and anything else are ignored.

    :param forwarder_state: The forwarder's state, ``None`` in callers
        without one.
    :param session_id: The Omnigent session the item routes to.
    :param params: The ``item/completed`` params, carrying ``turnId``.
    :param item: The Codex item.
    """
    if forwarder_state is None or item.get("type") not in {"userMessage", "agentMessage"}:
        return
    parent = forwarder_state.parent_session_id
    if parent is not None and session_id != parent:
        return  # a sub-agent thread's child session never gets a suggestion
    state = forwarder_state.ae_prompt_suggest
    turn_id = _turn_id(params)
    if turn_id is None:
        return
    text = state.turns.get(session_id)
    if text is None or text.turn_id != turn_id:
        text = state.turns[session_id] = _TurnText(turn_id)
    _record(text, item)


def reset_prompt_suggestion(state: CodexSuggestionState) -> None:
    """A ``/clear`` rotation: cancel the call in flight and forget the noted turns."""
    cancel_prompt_suggestion(state)
    state.turns.clear()


def _turn_context(
    state: CodexSuggestionState, session_id: str, turn_id: str, turn: Mapping[str, object]
) -> TurnContext | None:
    """
    The finished turn's prompt and reply, or ``None`` when there is no reply
    or the reply asks the user something.

    The noted items come first; a ``turn.items`` list the notification carries
    (Codex fills it per its ``itemsView``) fills in what was missed.
    """
    noted = state.turns.get(session_id)
    text = noted if noted is not None and noted.turn_id == turn_id else _TurnText(turn_id)
    if not text.assistant_text or not text.user_prompt:
        items = turn.get("items")
        if isinstance(items, list):
            backfill = _TurnText(turn_id)
            for item in items:
                if isinstance(item, Mapping):
                    _record(backfill, item)
            text = _TurnText(
                turn_id,
                user_prompt=text.user_prompt or backfill.user_prompt,
                assistant_text=text.assistant_text or backfill.assistant_text,
                asks_user=text.asks_user if text.assistant_text else backfill.asks_user,
            )
    if not text.assistant_text or text.asks_user:
        return None
    return TurnContext(user_prompt=text.user_prompt, assistant_text=text.assistant_text)


async def _suggest(
    client: httpx.AsyncClient,
    *,
    session_id: str,
    context: TurnContext,
    state: CodexSuggestionState,
) -> None:
    """The background task: skip rules, side call, post. Never raises but on cancel."""
    try:
        if await is_child_session(client, session_id, state) is not False:
            return
        if state.provider_ok is None:
            state.provider_ok = await asyncio.to_thread(uses_default_provider, None)
        if not state.provider_ok:
            _logger.debug("prompt suggestion skipped: host Claude is not on the default provider")
            return
        # The host's active account, as a Claude terminal launched now would get it.
        login_env = await asyncio.to_thread(account_login_env, None)
        if login_env is None:
            return
        await suggest_and_post(
            client, session_id=session_id, context=context, state=state, login_env=login_env
        )
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - a suggestion is best effort and must not hurt forwarding
        _logger.debug(
            "prompt suggestion failed; session=%s",
            session_id,
            exc_info=True,
            extra={"session_id": session_id},
        )


def schedule_codex_prompt_suggestion(
    client: httpx.AsyncClient,
    *,
    session_id: str,
    method: str,
    params: Mapping[str, object],
    status: str,
    turn_id: str | None,
    forwarder_state: _ForwarderState,
    env: Mapping[str, str] | None = None,
) -> None:
    """
    Start the side call for a Codex turn that just ended, in the background.

    Called on the forwarder's hot path once a parent thread's terminal turn
    event has posted its status edge, so it only checks the switch and the
    turn and creates a task; any older call still running is cancelled first.

    :param client: Omnigent HTTP client the forwarder posts with.
    :param session_id: Omnigent session/conversation id.
    :param method: Codex method, e.g. ``"turn/completed"``.
    :param params: The terminal event's params.
    :param status: The Omnigent status edge just posted, e.g. ``"idle"``.
    :param turn_id: That edge's Codex turn id, e.g. ``"turn_123"``.
    :param forwarder_state: The forwarder's state: its suggestion state
        (mutated in place), and whether a Plan implementation prompt is about
        to wait on the user.
    :param env: Environment to read the switch from (the process's own by default).
    """
    if not suggestions_enabled(env):
        return
    state = forwarder_state.ae_prompt_suggest
    cancel_prompt_suggestion(state)
    turn = params.get("turn")
    turn = turn if isinstance(turn, Mapping) else {}
    if method != _TURN_COMPLETED or status != "idle" or turn_id is None:
        return
    if turn.get("status") not in (None, "completed"):
        return  # interrupted: the user stopped it and is typing already
    completed_at = turn.get("completedAt")
    if isinstance(completed_at, (int, float)) and time.time() - completed_at > MAX_TURN_AGE_S:
        return
    if forwarder_state.plan_prompt_context(turn_id) is not None:
        return
    context = _turn_context(state, session_id, turn_id, turn)
    if context is None:
        return
    state.task = asyncio.create_task(
        _suggest(client, session_id=session_id, context=context, state=state),
        name=f"ae-prompt-suggest-{session_id}",
    )
