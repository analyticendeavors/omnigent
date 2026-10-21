"""Tests for the next-prompt side call after a finished Codex turn."""

from __future__ import annotations

import asyncio
import json
import os
import stat
import time
from pathlib import Path
from typing import Any

import httpx
import pytest

import omnigent.harnesses.ae_prompt_suggest_core as core
import omnigent.harnesses.codex_native.ae_prompt_suggest as codex_suggest
from omnigent.harnesses.codex_native import forwarder as fwd
from omnigent.harnesses.codex_native.bridge import CodexNativeBridgeState, write_bridge_state

ON = {core.ENABLE_ENV_VAR: "1"}
_SUGGESTION_POST = "external_session_suggestion"


def _fake_claude(tmp_path: Path, body: str) -> Path:
    """A ``claude`` on PATH that records its argv, env and stdin, then runs ``body``."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    log = tmp_path / "calls.jsonl"
    script = bin_dir / "claude"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys, time\n"
        "stdin = sys.stdin.read()\n"
        f"with open({str(log)!r}, 'a') as f:\n"
        "    f.write(json.dumps({'argv': sys.argv[1:], 'pid': os.getpid(),\n"
        "        'env': dict(os.environ), 'stdin': stdin}) + '\\n')\n"
        f"{body}\n",
        encoding="utf-8",
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return log


def _calls(log: Path) -> list[dict[str, Any]]:
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]


@pytest.fixture
def on_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The fake ``claude`` first on PATH, a default login, the switch on, temp dirs here."""
    monkeypatch.setenv("PATH", f"{tmp_path / 'bin'}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.delenv(core.CLAUDE_PATH_ENV_VAR, raising=False)
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "host-default-token")
    monkeypatch.setenv(core.ENABLE_ENV_VAR, "1")
    monkeypatch.setattr(core.tempfile, "tempdir", str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    monkeypatch.setattr(codex_suggest, "uses_default_provider", lambda bridge_dir, env=None: True)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    _host_accounts(tmp_path, monkeypatch, active="")
    return tmp_path


_ACCOUNT_TOKEN = "sk-ant-oat-active-account-token-for-tests"


def _host_accounts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, active: str) -> None:
    """This host's Claude accounts: one named "AE Backup", ``active`` selected."""
    from omnigent.onboarding import claude_accounts

    store = tmp_path / "claude-accounts.json"
    store.write_text(json.dumps({"accounts": ["AE Backup"], "active": active}))
    monkeypatch.setattr(claude_accounts, "_path", lambda: store)
    monkeypatch.setattr(
        claude_accounts.secrets,
        "load_secret",
        lambda name: _ACCOUNT_TOKEN if name == "claude-oauth-AE Backup" else None,
    )


class _Server:
    """A MockTransport stand-in for the OmniGent server."""

    def __init__(self, *, parent_session_id: str | None = None) -> None:
        self.posts: list[dict[str, Any]] = []
        self.parent_session_id = parent_session_id

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(
                200, json={"id": "conv_x", "parent_session_id": self.parent_session_id}
            )
        self.posts.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(200, json={})

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler), base_url="http://ap")

    def suggestions(self) -> list[str | None]:
        return [p["data"]["suggestion"] for p in self.posts if p["type"] == _SUGGESTION_POST]


def _seed_bridge(bridge_dir: Path) -> None:
    write_bridge_state(
        bridge_dir,
        CodexNativeBridgeState(
            session_id="conv_x",
            socket_path=str(bridge_dir / "app-server.sock"),
            thread_id="thread_1",
            codex_home=str(bridge_dir / "codex-home"),
        ),
    )


def _turn_events(
    turn_id: str,
    *,
    prompt: str = "fix the failing test",
    reply: dict[str, Any] | None = None,
    status: str = "completed",
    completed_at: float | None = None,
) -> list[dict[str, Any]]:
    """One whole Codex turn as the app-server streams it."""
    agent = reply or {"type": "agentMessage", "id": f"{turn_id}-a", "text": "Fixed. 12 pass."}
    return [
        {"method": "turn/started", "params": {"threadId": "thread_1", "turn": {"id": turn_id}}},
        {
            "method": "item/completed",
            "params": {
                "threadId": "thread_1",
                "turnId": turn_id,
                "item": {
                    "type": "userMessage",
                    "id": f"{turn_id}-u",
                    "content": [{"type": "text", "text": prompt}],
                },
            },
        },
        {
            "method": "item/completed",
            "params": {"threadId": "thread_1", "turnId": turn_id, "item": agent},
        },
        {
            "method": "turn/completed",
            "params": {
                "threadId": "thread_1",
                "turn": {
                    "id": turn_id,
                    "status": status,
                    "items": [],
                    "completedAt": int(completed_at if completed_at is not None else time.time()),
                },
            },
        },
    ]


async def _feed(
    client: httpx.AsyncClient,
    bridge_dir: Path,
    state: fwd._CodexForwarderState,
    events: list[dict[str, Any]],
) -> None:
    usage = fwd._SessionUsageCoalescer(client, "conv_x")
    tracker = fwd._CodexElicitationTaskTracker()
    for event in events:
        await fwd._handle_event(
            client,
            session_id="conv_x",
            bridge_dir=bridge_dir,
            event=event,
            usage_coalescer=usage,
            elicitation_tracker=tracker,
            expected_thread_id="thread_1",
            forwarder_state=state,
        )


async def _run_turn(
    server: _Server, bridge_dir: Path, events: list[dict[str, Any]]
) -> fwd._CodexForwarderState:
    _seed_bridge(bridge_dir)
    state = fwd._CodexForwarderState(parent_session_id="conv_x")
    async with server.client() as client:
        await _feed(client, bridge_dir, state, events)
        task = state.ae_prompt_suggest.task
        if task is not None:
            await task
    return state


@pytest.mark.asyncio
async def test_a_codex_turn_end_makes_one_call_and_posts_the_event(
    on_path: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = _fake_claude(on_path, "print('Open a draft PR')")
    monkeypatch.setenv("OMNIGENT_TOKEN", "runner-secret")
    server = _Server()
    await _run_turn(server, tmp_path / "bridge", _turn_events("turn_1"))
    (call,) = _calls(log)
    assert call["argv"][:3] == ["-p", "--model", "haiku"]
    assert "fix the failing test" in call["stdin"] and "Fixed. 12 pass." in call["stdin"]
    assert call["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == "host-default-token"
    assert "OMNIGENT_TOKEN" not in call["env"]
    assert server.suggestions() == ["Open a draft PR"]
    # The event lands after the turn's idle edge, as on the Claude side.
    statuses = [p["data"].get("status") for p in server.posts]
    assert statuses.index("idle") < len(statuses) - 1


@pytest.mark.asyncio
async def test_the_reply_comes_from_turn_items_when_the_live_item_was_missed(
    on_path: Path, tmp_path: Path
) -> None:
    log = _fake_claude(on_path, "print('Ship it')")
    events = _turn_events("turn_1")
    del events[2]  # the live agentMessage never arrived
    events[-1]["params"]["turn"]["items"] = [
        {"type": "agentMessage", "id": "a", "text": "Done; all green."}
    ]
    server = _Server()
    await _run_turn(server, tmp_path / "bridge", events)
    (call,) = _calls(log)
    assert "Done; all green." in call["stdin"]
    assert server.suggestions() == ["Ship it"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    ["sub-agent session", "interrupted", "asks the user", "stale", "no reply", "switched off"],
)
async def test_skip_rules_make_no_call(
    on_path: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, case: str
) -> None:
    log = _fake_claude(on_path, "print('x')")
    server = _Server(parent_session_id="conv_parent" if case == "sub-agent session" else None)
    events = _turn_events(
        "turn_1",
        status="interrupted" if case == "interrupted" else "completed",
        completed_at=time.time() - 3600 if case == "stale" else None,
        reply=(
            {"type": "agentMessage", "id": "a", "text": "Which?", "questions": [{"title": "A?"}]}
            if case == "asks the user"
            else {"type": "agentMessage", "id": "a", "text": ""}
            if case == "no reply"
            else None
        ),
    )
    if case == "switched off":
        monkeypatch.delenv(core.ENABLE_ENV_VAR)
    await _run_turn(server, tmp_path / "bridge", events)
    assert _calls(log) == []
    assert server.suggestions() == []


@pytest.mark.asyncio
async def test_a_plan_turn_waiting_on_the_implement_prompt_makes_no_call(
    on_path: Path, tmp_path: Path
) -> None:
    log = _fake_claude(on_path, "print('x')")
    state = fwd._CodexForwarderState(parent_session_id="conv_x")
    state.completed_plan_text_by_turn["turn_1"] = "1. Do it"
    state.plan_thread_by_turn["turn_1"] = "thread_1"
    params = _turn_events("turn_1")[-1]["params"]
    params["turn"]["items"] = [{"type": "agentMessage", "id": "a", "text": "Plan ready."}]
    server = _Server()
    async with server.client() as client:
        codex_suggest.schedule_codex_prompt_suggestion(
            client,
            session_id="conv_x",
            method="turn/completed",
            params=params,
            status="idle",
            turn_id="turn_1",
            forwarder_state=state,
        )
    assert state.ae_prompt_suggest.task is None
    assert _calls(log) == []


@pytest.mark.asyncio
async def test_a_child_thread_turn_end_makes_no_call(
    on_path: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A Codex sub-agent thread's turn routes to its child session and is never suggested."""
    monkeypatch.chdir(tmp_path)  # child turn events get bridge_dir=Path(), the cwd
    log = _fake_claude(on_path, "print('x')")
    bridge_dir = tmp_path / "bridge"
    _seed_bridge(bridge_dir)
    state = fwd._CodexForwarderState(parent_session_id="conv_x")
    state.note_child_thread("thread_child", "conv_child")
    events = [
        {**e, "params": {**e["params"], "threadId": "thread_child"}}
        for e in _turn_events("turn_c")
    ]
    server = _Server()
    async with server.client() as client:
        await _feed(client, bridge_dir, state, events)
    assert state.ae_prompt_suggest.task is None
    assert _calls(log) == []


@pytest.mark.asyncio
async def test_a_new_prompt_cancels_the_call_in_flight(on_path: Path, tmp_path: Path) -> None:
    log = _fake_claude(on_path, "time.sleep(30)\nprint('late')")
    bridge_dir = tmp_path / "bridge"
    _seed_bridge(bridge_dir)
    state = fwd._CodexForwarderState(parent_session_id="conv_x")
    server = _Server()
    async with server.client() as client:
        await _feed(client, bridge_dir, state, _turn_events("turn_1"))
        task = state.ae_prompt_suggest.task
        assert task is not None
        for _ in range(200):
            if _calls(log):
                break
            await asyncio.sleep(0.02)
        (call,) = _calls(log)
        await _feed(client, bridge_dir, state, _turn_events("turn_2")[:1])  # turn/started
        with pytest.raises(asyncio.CancelledError):
            await task
    assert server.suggestions() == []
    for _ in range(100):
        try:
            os.kill(call["pid"], 0)
        except ProcessLookupError:
            break
        await asyncio.sleep(0.02)
    else:
        pytest.fail("the side call outlived the new prompt")


@pytest.mark.asyncio
async def test_a_new_prompt_leaves_the_clear_to_the_running_edge(
    on_path: Path, tmp_path: Path
) -> None:
    """The web drops a shown suggestion on the running edge; no extra null POST."""
    _fake_claude(on_path, "print('Open a draft PR')")
    bridge_dir = tmp_path / "bridge"
    server = _Server()
    state = await _run_turn(server, bridge_dir, _turn_events("turn_1"))
    assert server.suggestions() == ["Open a draft PR"]
    async with server.client() as client:
        await _feed(client, bridge_dir, state, _turn_events("turn_2")[:1])
    assert server.suggestions() == ["Open a draft PR"]
    assert server.posts[-1]["data"]["status"] == "running"


@pytest.mark.asyncio
async def test_the_call_runs_on_the_hosts_active_account(
    on_path: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """What a Claude terminal launched without a choice gets, not always ~/.claude."""
    _host_accounts(tmp_path, monkeypatch, active="AE Backup")
    log = _fake_claude(on_path, "print('Open a draft PR')")
    server = _Server()
    await _run_turn(server, tmp_path / "bridge", _turn_events("turn_1"))
    (call,) = _calls(log)
    assert call["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == _ACCOUNT_TOKEN
    assert server.suggestions() == ["Open a draft PR"]


@pytest.mark.asyncio
async def test_a_raw_api_key_on_the_host_skips(
    on_path: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(codex_suggest, "uses_default_provider", core.uses_default_provider)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api-raw")
    log = _fake_claude(on_path, "print('x')")
    server = _Server()
    await _run_turn(server, tmp_path / "bridge", _turn_events("turn_1"))
    assert _calls(log) == []
    assert server.suggestions() == []


def _state() -> fwd._CodexForwarderState:
    return fwd._CodexForwarderState(parent_session_id="conv_x")


def _user_item(text: str) -> dict[str, Any]:
    return {"type": "userMessage", "content": [{"type": "text", "text": text}]}


def test_a_skill_block_with_typed_text_keeps_the_text_and_a_bare_one_is_dropped() -> None:
    state = _state()
    params = {"turnId": "turn_1"}
    codex_suggest.note_turn_item(state, "conv_x", params, _user_item("<skill>\nx\n</skill>"))
    assert state.ae_prompt_suggest.turns["conv_x"].user_prompt == ""
    typed = "<skill>\nx\n</skill>\n\nnow fix the test"
    codex_suggest.note_turn_item(state, "conv_x", params, _user_item(typed))
    assert state.ae_prompt_suggest.turns["conv_x"].user_prompt.endswith("now fix the test")


def test_child_items_are_not_noted_and_a_rotation_forgets_the_turns() -> None:
    state = _state()
    params = {"turnId": "turn_1"}
    codex_suggest.note_turn_item(state, "conv_child", params, _user_item("child prompt"))
    assert state.ae_prompt_suggest.turns == {}
    codex_suggest.note_turn_item(state, "conv_x", params, _user_item("parent prompt"))
    assert list(state.ae_prompt_suggest.turns) == ["conv_x"]
    codex_suggest.reset_prompt_suggestion(state.ae_prompt_suggest)
    assert state.ae_prompt_suggest.turns == {}


def test_only_the_replys_tail_is_kept() -> None:
    state = _state()
    reply = "head " + "x" * (core.MAX_CONTEXT_CHARS * 3) + " the end"
    codex_suggest.note_turn_item(
        state, "conv_x", {"turnId": "turn_1"}, {"type": "agentMessage", "text": reply}
    )
    kept = state.ae_prompt_suggest.turns["conv_x"].assistant_text
    assert len(kept) == core.MAX_CONTEXT_CHARS and kept.endswith(" the end")


class _FakeCodexClient:
    """An app-server client that streams ``events`` and then stays open."""

    def __init__(self, events: list[dict[str, Any]]) -> None:
        self.events = events
        self.closed = False

    async def connect(self) -> None:
        return None

    async def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        return {"result": {"thread": {"id": "thread_1"}}}

    async def iter_events(self) -> Any:
        for event in self.events:
            yield event
        await asyncio.sleep(3600)

    async def close(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_the_forwarder_exit_cancels_the_side_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cancelling the Codex forwarder (session teardown) leaves no call behind."""
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def hanging_suggest(*args: Any, **kwargs: Any) -> None:
        started.set()
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    monkeypatch.setattr(codex_suggest, "_suggest", hanging_suggest)
    monkeypatch.setenv(core.ENABLE_ENV_VAR, "1")
    bridge_dir = tmp_path / "bridge"
    _seed_bridge(bridge_dir)
    server = _Server()
    task = asyncio.create_task(
        fwd.supervise_forwarder(
            base_url="http://ap",
            headers={},
            session_id="conv_x",
            bridge_dir=bridge_dir,
            app_server_url=str(bridge_dir / "app-server.sock"),
            thread_id="thread_1",
            client=_FakeCodexClient(_turn_events("turn_1")),  # type: ignore[arg-type]
            ap_transport=httpx.MockTransport(server.handler),
        )
    )
    try:
        await asyncio.wait_for(started.wait(), 10)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    await asyncio.wait_for(cancelled.wait(), 2)
