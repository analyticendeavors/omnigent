"""A scheduled orchestrator check-in posts into its named session and opens no new one."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI, Request

from omnigent.server.scheduled.checkin_relay import (
    CHECKIN_TEXT,
    build_session_poster,
    parse_checkin,
)
from omnigent.server.scheduled.fire import build_on_fire
from tests.server.scheduled.test_fire import (
    FakeConversationStore,
    FakeScheduledTaskStore,
    _deps,
    _drain,
    _FakeConversation,
    _task,
)

SESSION = "aa29ab15f9da4d9b92ecd58f5e53f9fe"
# The exact text the schedule_checkin tool wrote before this change.
PLAIN = (
    "Scheduled orchestrator check-in. Hand it to the orchestrator session the person talks to: "
    f'call post_message once with session_id {SESSION} and the text "{CHECKIN_TEXT}" '
    "Then stop. Only if that call fails, run the check-in yourself as your "
    "instructions describe."
)
FOCUS = PLAIN.replace("check-in. Hand", "check-in. Focus: PASS 2026 deck redesign Hand")


class _Conversations(FakeConversationStore):
    def __init__(self, found: _FakeConversation | None) -> None:
        super().__init__()
        self.found = found

    def get_conversation(self, conversation_id: str) -> Any:
        return self.found


class _ArchivedConv(_FakeConversation):
    archived = True


def _poster(posts: list[tuple[Any, str, str]], fail: bool = False) -> Any:
    async def post(user_id: str | None, session_id: str, text: str) -> None:
        posts.append((user_id, session_id, text))
        if fail:
            raise RuntimeError("409")

    return post


async def _fire(
    prompt: str, conv: Any, posts: list[Any], *, fail: bool = False
) -> tuple[FakeScheduledTaskStore, _Conversations, list[Any]]:
    store = FakeScheduledTaskStore(rows={"task_1": _task(prompt=prompt, user_id="owner")})
    convs = _Conversations(conv)
    launched: list[Any] = []

    async def _launch(c: Any, t: Any) -> None:
        launched.append(c)

    deps = _deps(store, conversation_store=convs)
    deps.post_session_message = _poster(posts, fail)
    await build_on_fire(deps, launch_dispatch=_launch)(0, "task_1")
    await _drain()
    return store, convs, launched


def test_parse_reads_session_and_focus() -> None:
    assert parse_checkin(PLAIN) == (SESSION, CHECKIN_TEXT)
    assert parse_checkin(FOCUS) == (SESSION, f"{CHECKIN_TEXT} Focus: PASS 2026 deck redesign")
    assert parse_checkin("Scheduled orchestrator check-in. Run the check-in.") is None
    assert parse_checkin("do the thing") is None


@pytest.mark.asyncio
async def test_live_session_gets_direct_post_and_no_session_is_created() -> None:
    posts: list[Any] = []
    store, convs, launched = await _fire(PLAIN, _FakeConversation(SESSION, "ag_1"), posts)
    assert posts == [("owner", SESSION, CHECKIN_TEXT)]
    assert convs.created == [] and launched == []
    assert [r["status"] for r in store.runs] == ["succeeded"]
    assert store.runs[0].get("conversation_id") is None


@pytest.mark.asyncio
async def test_focus_note_rides_in_the_posted_text() -> None:
    posts: list[Any] = []
    await _fire(FOCUS, _FakeConversation(SESSION, "ag_1"), posts)
    assert posts[0][2] == f"{CHECKIN_TEXT} Focus: PASS 2026 deck redesign"


@pytest.mark.asyncio
@pytest.mark.parametrize("conv", [None, _ArchivedConv(SESSION, "ag_1")])
async def test_missing_or_archived_session_falls_back_to_a_fresh_session(conv: Any) -> None:
    posts: list[Any] = []
    _, convs, launched = await _fire(PLAIN, conv, posts)
    assert posts == []
    assert len(convs.created) == 1 and len(launched) == 1


@pytest.mark.asyncio
async def test_failed_post_falls_back_to_a_fresh_session() -> None:
    posts: list[Any] = []
    _, convs, launched = await _fire(PLAIN, _FakeConversation(SESSION, "ag_1"), posts, fail=True)
    assert len(posts) == 1
    assert len(convs.created) == 1 and len(launched) == 1


@pytest.mark.asyncio
async def test_prompt_without_session_id_fires_a_fresh_session() -> None:
    posts: list[Any] = []
    prompt = "Scheduled orchestrator check-in. Run the check-in, then stop."
    _, convs, _ = await _fire(prompt, _FakeConversation(SESSION, "ag_1"), posts)
    assert posts == [] and len(convs.created) == 1


@pytest.mark.asyncio
async def test_poster_sends_a_user_message_to_the_events_route_as_the_owner() -> None:
    seen: list[tuple[str, str | None, Any]] = []
    app = FastAPI()

    @app.post("/v1/sessions/{session_id}/events", status_code=202)
    async def events(session_id: str, request: Request) -> dict[str, bool]:
        seen.append((session_id, request.headers.get("authorization"), await request.json()))
        return {"ok": True}

    class _Auth:
        def mint_runner_token(self, user_id: str, ttl: int) -> str:
            return f"tok-{user_id}"

    await build_session_poster(app, _Auth())("owner", SESSION, CHECKIN_TEXT)
    session_id, auth, body = seen[0]
    assert (session_id, auth) == (SESSION, "Bearer tok-owner")
    assert body["type"] == "message"
    assert body["data"]["content"][0]["text"] == CHECKIN_TEXT
