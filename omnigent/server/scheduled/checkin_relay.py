"""Post a scheduled orchestrator check-in straight into the session it names.

The check-in prompt (written by the ``schedule_checkin`` tool) tells a fresh
session to relay one message to an orchestrator session. When that prompt names
a live session, the fire posts the message itself, as the owner's next user
turn, and creates no session. Any other case returns False and the caller runs
the ordinary fresh-session fire.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from omnigent.entities import ScheduledTask

_logger = logging.getLogger(__name__)

CHECKIN_TEXT = "Check-in: run your check-in now."
_MINT_TTL_S = 300
_POST_TIMEOUT_S = 30.0
_PROMPT = re.compile(
    r"^Scheduled orchestrator check-in\.(?: Focus: (?P<note>.*?))?"
    r" Hand it to the orchestrator session (?:the person|\w+) talks to: call post_message once"
    r" with session_id (?P<session_id>\S+) and the text ",
    re.DOTALL,
)

# ``(owner user id, session id, text)``; raises when the post is not accepted.
PostSessionMessage = Callable[[str | None, str, str], Awaitable[None]]


def parse_checkin(prompt: str) -> tuple[str, str] | None:
    """The target session id and the message to post, or None for any other prompt."""
    match = _PROMPT.match(prompt)
    if match is None:
        return None
    text = CHECKIN_TEXT
    if match["note"]:
        text = f"{text} Focus: {match['note']}"
    return match["session_id"], text


def build_session_poster(app: Any, auth_provider: Any | None) -> PostSessionMessage:
    """A poster that sends a user message through the server's own events route.

    Going through the route keeps every rule a typed message has: access check,
    policies, and queueing behind a turn that is still running.
    """

    async def post(user_id: str | None, session_id: str, text: str) -> None:
        headers: dict[str, str] = {}
        if auth_provider is not None and user_id:
            token = auth_provider.mint_runner_token(user_id, _MINT_TTL_S)
            if token:
                headers["Authorization"] = f"Bearer {token}"
        event = {
            "type": "message",
            "data": {"role": "user", "content": [{"type": "input_text", "text": text}]},
        }
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://checkin.internal",
            headers=headers,
            timeout=_POST_TIMEOUT_S,
        ) as client:
            response = await client.post(f"/v1/sessions/{session_id}/events", json=event)
        response.raise_for_status()

    return post


async def relay_checkin(deps: Any, task: ScheduledTask) -> bool:
    """Post the check-in into its named session; False means fire a fresh session.

    :returns: True only when the message was accepted. A prompt that names no
        session, a session that is missing or archived, no poster wired, and a
        failed post all return False.
    """
    poster: PostSessionMessage | None = getattr(deps, "post_session_message", None)
    parsed = parse_checkin(task.prompt)
    if poster is None or parsed is None:
        return False
    session_id, text = parsed
    try:
        conv = await asyncio.to_thread(deps.conversation_store.get_conversation, session_id)
        if conv is None or getattr(conv, "archived", False):
            _logger.info(
                "check-in %s: session %s is missing or archived; firing a fresh session",
                task.id,
                session_id,
            )
            return False
        await poster(task.user_id, session_id, text)
    except Exception:  # noqa: BLE001 - any failure falls back to a fresh session
        _logger.warning(
            "check-in %s: could not post to session %s; firing a fresh session",
            task.id,
            session_id,
            exc_info=True,
        )
        return False
    return True
