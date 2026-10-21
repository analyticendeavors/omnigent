"""Tests for the next-prompt side call after a finished Claude turn."""

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
import omnigent.harnesses.claude_native.ae_prompt_suggest as suggest
import omnigent.harnesses.claude_native.forwarder as forwarder
from omnigent.harnesses.claude_native.bridge import record_hook_event
from tests.harnesses.claude_native.forwarder._support import _start_recording_server

ON = {suggest.ENABLE_ENV_VAR: "1"}
# The on_path fixture stubs the account lookup; the account tests put this back.
_REAL_SESSION_LOGIN_ENV = suggest.session_login_env


def _user(text: str) -> dict[str, Any]:
    return {"type": "user", "message": {"role": "user", "content": text}}


def _assistant(*blocks: dict[str, Any]) -> dict[str, Any]:
    return {"type": "assistant", "message": {"role": "assistant", "content": list(blocks)}}


def _text(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def _tool_use(tool_id: str, name: str = "Bash") -> dict[str, Any]:
    return {"type": "tool_use", "id": tool_id, "name": name, "input": {}}


def _tool_result(tool_id: str) -> dict[str, Any]:
    return {
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": "ok"}],
        },
    }


def _transcript(tmp_path: Path, *entries: dict[str, Any]) -> Path:
    path = tmp_path / "session.jsonl"
    path.write_text("".join(json.dumps(e) + "\n" for e in entries), encoding="utf-8")
    return path


def _finished_turn(tmp_path: Path) -> Path:
    return _transcript(
        tmp_path,
        _user("fix the failing test"),
        _assistant(_text("Looking."), _tool_use("t1")),
        _tool_result("t1"),
        _assistant(_text("Fixed: the fixture now resets the clock. All 12 tests pass.")),
    )


def _fake_claude(tmp_path: Path, body: str) -> Path:
    """A ``claude`` on PATH that records its argv, cwd, env and stdin, then runs ``body``."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    log = tmp_path / "calls.jsonl"
    script = bin_dir / "claude"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys, time\n"
        "stdin = sys.stdin.read()\n"
        f"with open({str(log)!r}, 'a') as f:\n"
        "    cfg = os.environ.get('CLAUDE_CONFIG_DIR', '')\n"
        "    files = sorted(os.listdir(cfg)) if cfg and os.path.isdir(cfg) else []\n"
        "    f.write(json.dumps({'argv': sys.argv[1:], 'cwd': os.getcwd(), 'pid': os.getpid(),\n"
        "        'env': dict(os.environ), 'stdin': stdin, 'config_files': files}) + '\\n')\n"
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
    """Put the fake ``claude`` first on PATH, give it a login, and keep its temp dirs here."""
    monkeypatch.setenv("PATH", f"{tmp_path / 'bin'}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.delenv(suggest.CLAUDE_PATH_ENV_VAR, raising=False)
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "test-token")
    monkeypatch.setattr(core.tempfile, "tempdir", str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    monkeypatch.setattr(suggest, "uses_default_provider", lambda bridge_dir, env=None: True)
    monkeypatch.setattr(suggest, "session_login_env", lambda bridge_dir, state=None: {})
    return tmp_path


def _leftover_dirs(root: Path) -> list[Path]:
    return list((root / "tmp").glob(f"{suggest._WORKDIR_PREFIX}*"))


class _Server:
    """A MockTransport stand-in for the OmniGent server."""

    def __init__(self, *, parent_session_id: str | None = None) -> None:
        self.posts: list[dict[str, Any]] = []
        self.gets: list[str] = []
        self.parent_session_id = parent_session_id

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            self.gets.append(request.url.path)
            return httpx.Response(
                200, json={"id": "conv_a", "parent_session_id": self.parent_session_id}
            )
        self.posts.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(202, json={"queued": False})

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler), base_url="http://ap")


# ── Transcript reading ─────────────────────────────────────────────


def test_reads_last_prompt_and_last_reply(tmp_path: Path) -> None:
    context = suggest.read_turn_context(_finished_turn(tmp_path))
    assert context == suggest.TurnContext(
        user_prompt="fix the failing test",
        assistant_text="Fixed: the fixture now resets the clock. All 12 tests pass.",
    )


def test_skips_a_turn_that_waits_on_the_user(tmp_path: Path) -> None:
    """An AskUserQuestion (or any tool call) without a result means the user owes an answer."""
    path = _transcript(
        tmp_path,
        _user("deploy it"),
        _assistant(_text("Which host?"), _tool_use("q1", "AskUserQuestion")),
    )
    assert suggest.read_turn_context(path) is None


def test_ignores_meta_sidechain_and_tagged_entries(tmp_path: Path) -> None:
    path = _transcript(
        tmp_path,
        _user("real prompt"),
        {**_user("<command-name>/model</command-name>")},
        {**_user("system note"), "isMeta": True},
        {**_assistant(_text("subagent chatter")), "isSidechain": True},
        _assistant(_text("Real reply.")),
    )
    assert suggest.read_turn_context(path) == suggest.TurnContext("real prompt", "Real reply.")


def test_no_reply_after_the_prompt_reads_nothing(tmp_path: Path) -> None:
    path = _transcript(tmp_path, _assistant(_text("old reply")), _user("new prompt"))
    assert suggest.read_turn_context(path) is None
    assert suggest.read_turn_context(tmp_path / "missing.jsonl") is None


def test_side_call_prompt_stays_within_the_budget() -> None:
    context = suggest.TurnContext("~" * 5000, "^" * 4000 + "END")
    prompt = suggest.build_side_call_prompt(context)
    assert prompt.count("~") == suggest.MAX_PROMPT_CHARS
    assert prompt.count("~") + prompt.count("^") + len("END") == suggest.MAX_CONTEXT_CHARS
    assert "END" in prompt  # the reply's tail is what the user just read


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Run the tests again\n", "Run the tests again"),
        ('"Open a draft PR"', "Open a draft PR"),
        ("\n\nNONE\n", None),
        ("none.", None),
        ("", None),
        ("first line\nsecond line", "first line"),
    ],
)
def test_clean_suggestion(raw: str, expected: str | None) -> None:
    assert suggest.clean_suggestion(raw) == expected


def test_clean_suggestion_cuts_long_lines_at_a_word() -> None:
    cleaned = suggest.clean_suggestion("word " * 60)
    assert cleaned is not None
    assert len(cleaned) <= suggest.MAX_SUGGESTION_CHARS
    assert cleaned.endswith("word")


# ── Isolation of the side call ─────────────────────────────────────


def test_argv_isolates_the_side_call() -> None:
    """No hooks, settings, MCP servers, tools or transcript (flags checked in claude --help)."""
    argv = suggest.side_call_argv("claude")
    assert argv[:4] == ["claude", "-p", "--model", "haiku"]
    for flag in (
        "--safe-mode",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
    ):
        assert flag in argv
    assert argv[argv.index("--setting-sources") + 1] == ""
    assert json.loads(argv[argv.index("--settings") + 1]) == {"disableAllHooks": True}
    assert argv[argv.index("--tools") + 1] == ""
    assert "--resume" not in argv and "--continue" not in argv


def test_env_drops_omnigent_and_claude_session_wiring() -> None:
    env = suggest.side_call_env(
        config_dir=Path("/tmp/private"),
        base={
            "PATH": "/bin",
            "HOME": "/home/u",
            "CLAUDE_CONFIG_DIR": "/home/u/.claude",
            "CLAUDE_CODE_OAUTH_TOKEN": "kept",
            "OMNIGENT_TOKEN": "secret",
            "OMNIGENT_RELAY_URL": "http://relay",
            "RUNNER_SERVER_URL": "http://ap",
            "CLAUDECODE": "1",
            "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "true",
        },
    )
    # The user's own config dir is replaced by the call's private one.
    assert env == {
        "PATH": "/bin",
        "HOME": "/home/u",
        "CLAUDE_CONFIG_DIR": "/tmp/private",
        "CLAUDE_CODE_OAUTH_TOKEN": "kept",
    }


@pytest.mark.asyncio
async def test_side_call_runs_the_fake_claude_isolated(
    on_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = _fake_claude(on_path, "print('Run the tests again')")
    monkeypatch.setenv("OMNIGENT_TOKEN", "secret")
    result = await suggest.run_side_call("the prompt")
    assert result == "Run the tests again"
    (call,) = _calls(log)
    assert call["argv"][:3] == ["-p", "--model", "haiku"]
    assert "--no-session-persistence" in call["argv"]
    assert call["stdin"] == "the prompt"
    cwd = Path(call["cwd"])
    assert cwd.name == "cwd" and cwd.parent.name.startswith(suggest._WORKDIR_PREFIX)
    assert Path(call["env"]["CLAUDE_CONFIG_DIR"]) == cwd.parent / "config"
    assert "OMNIGENT_TOKEN" not in call["env"]
    assert _leftover_dirs(on_path) == []  # the per-call dir is removed afterwards


@pytest.mark.asyncio
async def test_side_call_none_and_failure_read_as_no_suggestion(on_path: Path) -> None:
    _fake_claude(on_path, "print('NONE')")
    assert await suggest.run_side_call("p") is None
    _fake_claude(on_path, "print('boom'); sys.exit(3)")
    assert await suggest.run_side_call("p") is None


@pytest.mark.asyncio
async def test_side_call_times_out_and_is_killed(on_path: Path) -> None:
    log = _fake_claude(on_path, "time.sleep(30); print('late')")
    started = time.monotonic()
    assert await suggest.run_side_call("p", timeout_s=1.0) is None
    assert time.monotonic() - started < 10
    (call,) = _calls(log)
    with pytest.raises(ProcessLookupError):
        os.kill(call["pid"], 0)


@pytest.mark.asyncio
async def test_timeout_kills_the_whole_process_group(on_path: Path) -> None:
    """A grandchild the CLI started (a node worker, say) dies with it."""
    pid_file = on_path / "grandchild.pid"
    _fake_claude(
        on_path,
        "import subprocess\n"
        "child = subprocess.Popen(['sleep', '60'])\n"
        f"open({str(pid_file)!r}, 'w').write(str(child.pid))\n"
        "time.sleep(30)",
    )
    assert await suggest.run_side_call("p", timeout_s=1.5) is None
    grandchild = int(pid_file.read_text())
    for _ in range(50):
        try:
            os.kill(grandchild, 0)
        except ProcessLookupError:
            break
        # A killed but unreaped child shows as a zombie; that is dead too.
        if Path(f"/proc/{grandchild}/stat").read_text().split()[2] == "Z":
            break
        await asyncio.sleep(0.1)
    else:
        pytest.fail("the grandchild outlived the side call")


@pytest.mark.asyncio
async def test_the_call_writes_claude_json_only_in_its_private_dir(
    on_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Claude Code rewrites .claude.json in its config dir on every run (measured 2026-10-20)."""
    home = on_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude.json").write_text("{}")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    log = _fake_claude(
        on_path,
        "cfg = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')\n"
        "target = os.path.join(cfg, '.claude.json') if os.environ.get('CLAUDE_CONFIG_DIR') "
        "else os.path.expanduser('~/.claude.json')\n"
        "open(target, 'w').write('{\"numStartups\": 2}')\n"
        "print('ok')",
    )
    assert await suggest.run_side_call("p") == "ok"
    assert (home / ".claude.json").read_text() == "{}"
    assert _calls(log)[0]["env"]["CLAUDE_CONFIG_DIR"] != str(home / ".claude")


def _credentials(home: Path, expires_in_s: float) -> None:
    (home / ".claude").mkdir(parents=True, exist_ok=True)
    (home / ".claude" / ".credentials.json").write_text(
        json.dumps(
            {
                "claudeAiOauth": {
                    "accessToken": "a",
                    "refreshToken": "r",
                    "expiresAt": int((time.time() + expires_in_s) * 1000),
                },
                "mcpOAuth": {"server": {"accessToken": "other"}},
            }
        )
    )


def test_copy_login_copies_only_a_fresh_claude_login(tmp_path: Path) -> None:
    home = tmp_path / "home"
    env = {"CLAUDE_CONFIG_DIR": str(home / ".claude")}
    private = tmp_path / "private"
    private.mkdir()
    _credentials(home, 3600)
    assert suggest.copy_login(private, env)
    copied = json.loads((private / ".credentials.json").read_text())
    assert list(copied) == ["claudeAiOauth"]  # no MCP tokens
    assert oct((private / ".credentials.json").stat().st_mode & 0o777) == "0o600"


def test_copy_login_refuses_a_login_about_to_expire_or_missing(tmp_path: Path) -> None:
    home = tmp_path / "home"
    env = {"CLAUDE_CONFIG_DIR": str(home / ".claude")}
    private = tmp_path / "private"
    private.mkdir()
    assert not suggest.copy_login(private, env)  # no credentials at all
    _credentials(home, 60)  # a refresh would rotate the user's token
    assert not suggest.copy_login(private, env)
    assert not (private / ".credentials.json").exists()
    assert suggest.copy_login(private, {**env, "CLAUDE_CODE_OAUTH_TOKEN": "t"})
    assert not (private / ".credentials.json").exists()


@pytest.mark.asyncio
async def test_no_login_means_no_call(on_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    log = _fake_claude(on_path, "print('x')")
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(on_path / "nowhere"))
    assert await suggest.run_side_call("p") is None
    assert _calls(log) == []
    assert _leftover_dirs(on_path) == []


# ── Provider ───────────────────────────────────────────────────────


@pytest.fixture
def host_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """The host resolves no launch config and no managed gateway."""
    import omnigent.harnesses.claude_native.main as native_main

    monkeypatch.setattr(native_main, "resolve_native_claude_config", lambda **kw: None)
    monkeypatch.setattr(native_main, "managed_claude_gateway_signal", lambda: (None, False))


@pytest.mark.usefixtures("host_default")
def test_default_provider_runs(tmp_path: Path) -> None:
    (tmp_path / "claude-settings.json").write_text(json.dumps({"model": "opus", "hooks": {}}))
    assert suggest.uses_default_provider(tmp_path, {"PATH": "/bin"})
    assert suggest.uses_default_provider(None, {})


@pytest.mark.usefixtures("host_default")
@pytest.mark.parametrize(
    ("env", "settings"),
    [
        ({"ANTHROPIC_BASE_URL": "https://gateway.example"}, {}),
        ({"ANTHROPIC_API_KEY": "sk-ant-api-raw"}, {}),
        ({"CLAUDE_CODE_USE_BEDROCK": "1"}, {}),
        ({"CLAUDE_CODE_USE_VERTEX": "1"}, {}),
        ({}, {"apiKeyHelper": "print-token"}),
        ({}, {"env": {"ANTHROPIC_BASE_URL": "https://gateway.example"}}),
    ],
)
def test_other_providers_skip(
    tmp_path: Path, env: dict[str, str], settings: dict[str, Any]
) -> None:
    (tmp_path / "claude-settings.json").write_text(json.dumps(settings))
    assert not suggest.uses_default_provider(tmp_path, env)


def test_a_host_launch_config_or_managed_gateway_skips(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import omnigent.harnesses.claude_native.main as native_main

    monkeypatch.setattr(native_main, "resolve_native_claude_config", lambda **kw: object())
    monkeypatch.setattr(native_main, "managed_claude_gateway_signal", lambda: (None, False))
    assert not suggest.uses_default_provider(tmp_path, {})
    monkeypatch.setattr(native_main, "resolve_native_claude_config", lambda **kw: None)
    monkeypatch.setattr(
        native_main, "managed_claude_gateway_signal", lambda: ("https://gw.example", True)
    )
    assert not suggest.uses_default_provider(tmp_path, {})


# ── Scheduling ─────────────────────────────────────────────────────


async def _schedule(
    server: _Server, transcript: Path, state: suggest.SuggestionState, **kw: Any
) -> None:
    async with server.client() as client:
        suggest.schedule_prompt_suggestion(
            client,
            session_id="conv_a",
            transcript_path=transcript,
            recorded_at=kw.pop("recorded_at", time.time()),
            state=state,
            env=kw.pop("env", ON),
            last_assistant_message=kw.pop("last_assistant_message", None),
        )
        if state.task is not None:
            await state.task


@pytest.mark.asyncio
async def test_finished_turn_posts_one_transient_suggestion(on_path: Path, tmp_path: Path) -> None:
    log = _fake_claude(on_path, "print('Open a draft PR')")
    server = _Server()
    await _schedule(server, _finished_turn(tmp_path), suggest.SuggestionState())
    assert server.posts == [
        {"type": "external_session_suggestion", "data": {"suggestion": "Open a draft PR"}}
    ]
    assert len(_calls(log)) == 1
    assert "fix the failing test" in _calls(log)[0]["stdin"]


@pytest.mark.asyncio
async def test_switched_off_by_default(on_path: Path, tmp_path: Path) -> None:
    log = _fake_claude(on_path, "print('x')")
    server = _Server()
    state = suggest.SuggestionState()
    await _schedule(server, _finished_turn(tmp_path), state, env={})
    assert state.task is None
    assert server.posts == [] and server.gets == []
    assert _calls(log) == []
    assert not suggest.suggestions_enabled({suggest.ENABLE_ENV_VAR: "0"})


@pytest.mark.asyncio
async def test_sub_agent_sessions_get_no_suggestion(on_path: Path, tmp_path: Path) -> None:
    log = _fake_claude(on_path, "print('x')")
    server = _Server(parent_session_id="conv_parent")
    state = suggest.SuggestionState()
    await _schedule(server, _finished_turn(tmp_path), state)
    await _schedule(server, _finished_turn(tmp_path), state)
    assert server.posts == []
    assert server.gets == ["/v1/sessions/conv_a"]  # looked up once, then cached
    assert _calls(log) == []


@pytest.mark.asyncio
async def test_waiting_turns_and_stale_hooks_make_no_call(on_path: Path, tmp_path: Path) -> None:
    log = _fake_claude(on_path, "print('x')")
    server = _Server()
    waiting = _transcript(
        tmp_path,
        _user("deploy"),
        _assistant(_text("Which host?"), _tool_use("q1", "AskUserQuestion")),
    )
    await _schedule(server, waiting, suggest.SuggestionState())
    stale = suggest.SuggestionState()
    await _schedule(server, _finished_turn(tmp_path), stale, recorded_at=time.time() - 600)
    assert stale.task is None
    assert server.posts == []
    assert _calls(log) == []


@pytest.mark.asyncio
async def test_a_newer_turn_cancels_the_older_call(on_path: Path, tmp_path: Path) -> None:
    """The first call is killed mid-flight; only the newer turn's answer is posted."""
    log = _fake_claude(
        on_path,
        "if 'first' in stdin:\n    time.sleep(30)\nprint('second answer')",
    )
    server = _Server()
    state = suggest.SuggestionState()
    first = _transcript(tmp_path, _user("first prompt"), _assistant(_text("reply one")))
    async with server.client() as client:
        suggest.schedule_prompt_suggestion(
            client,
            session_id="conv_a",
            transcript_path=first,
            recorded_at=None,
            state=state,
            env=ON,
        )
        older = state.task
        assert older is not None
        for _ in range(100):
            if _calls(log):
                break
            await asyncio.sleep(0.05)
        second = tmp_path / "second.jsonl"
        second.write_text(
            json.dumps(_user("second prompt")) + "\n" + json.dumps(_assistant(_text("two"))) + "\n"
        )
        suggest.schedule_prompt_suggestion(
            client,
            session_id="conv_a",
            transcript_path=second,
            recorded_at=None,
            state=state,
            env=ON,
        )
        newer = state.task
        assert newer is not None and newer is not older
        await newer
        with pytest.raises(asyncio.CancelledError):
            await older
    assert server.posts == [
        {"type": "external_session_suggestion", "data": {"suggestion": "second answer"}}
    ]
    first_call = _calls(log)[0]
    with pytest.raises(ProcessLookupError):
        os.kill(first_call["pid"], 0)


@pytest.mark.asyncio
async def test_cancel_with_nothing_in_flight_is_a_no_op() -> None:
    state = suggest.SuggestionState()
    suggest.cancel_prompt_suggestion(state)
    assert state.task is None


# ── Forwarder hook-up ──────────────────────────────────────────────


async def _forward_hooks(bridge_dir: Path, dedupe: forwarder._ForwardDedupeState) -> None:
    async with _Server().client() as client:
        hook_state = await forwarder._ensure_hook_state(
            bridge_dir, start_at_end=False, session_id="conv_abc"
        )
        await forwarder._forward_available_status_events(
            client=client,
            session_id="conv_abc",
            bridge_dir=bridge_dir,
            state=hook_state,
            retry_tracker=forwarder._PostRetryTracker(),
            dedupe=dedupe,
            task_subjects={},
            task_statuses={},
            task_order=[],
        )


@pytest.mark.asyncio
async def test_forwarder_schedules_on_the_parent_stop_and_clears_on_prompt_submit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[str, Any]] = []
    monkeypatch.setattr(
        forwarder,
        "schedule_prompt_suggestion",
        lambda client, **kw: calls.append(
            ("schedule", (kw["transcript_path"], kw["last_assistant_message"], kw["bridge_dir"]))
        ),
    )

    async def fake_clear(client: httpx.AsyncClient, *, state: Any) -> None:
        calls.append(("clear", None))

    monkeypatch.setattr(forwarder, "clear_prompt_suggestion", fake_clear)
    bridge_dir = tmp_path / "bridge"
    transcript = tmp_path / "t.jsonl"
    for event in ("UserPromptSubmit", "Stop"):
        record_hook_event(
            bridge_dir,
            {
                "hook_event_name": event,
                "session_id": "claude-session",
                "transcript_path": str(transcript),
                "last_assistant_message": "All green.",
            },
        )
    # A Claude Code subagent's Stop rides the same hooks file and must not count.
    record_hook_event(
        bridge_dir,
        {"hook_event_name": "Stop", "session_id": "claude-session", "agent_id": "a123"},
    )
    await _forward_hooks(bridge_dir, forwarder._ForwardDedupeState())
    assert calls == [("clear", None), ("schedule", (transcript, "All green.", bridge_dir))]


@pytest.mark.asyncio
async def test_forwarder_never_blocks_on_the_side_call(
    on_path: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With a side call that hangs, the hook pass still returns at once."""
    _fake_claude(on_path, "time.sleep(30)")
    monkeypatch.setenv(suggest.ENABLE_ENV_VAR, "1")
    bridge_dir = tmp_path / "bridge"
    record_hook_event(
        bridge_dir,
        {
            "hook_event_name": "Stop",
            "session_id": "claude-session",
            "transcript_path": str(_finished_turn(tmp_path)),
        },
    )
    dedupe = forwarder._ForwardDedupeState()
    started = time.monotonic()
    await _forward_hooks(bridge_dir, dedupe)
    assert time.monotonic() - started < 2
    task = dedupe.prompt_suggest.task
    assert task is not None and not task.done()
    suggest.cancel_prompt_suggestion(dedupe.prompt_suggest)
    with pytest.raises(asyncio.CancelledError):
        await task


# ── Review fixes: hook reply, clears, forwarder exit ───────────────


def test_hook_reply_wins_over_a_half_written_transcript(tmp_path: Path) -> None:
    """The Stop payload's reply is used even when the tail still ends mid tool call."""
    path = _transcript(
        tmp_path,
        _user("deploy it"),
        _assistant(_text("Deploying."), _tool_use("t9")),
    )
    assert suggest.read_turn_context(path) is None
    assert suggest.read_turn_context(path, "Deployed to staging.") == suggest.TurnContext(
        "deploy it", "Deployed to staging."
    )
    assert suggest.read_turn_context(None, "Done.") == suggest.TurnContext("", "Done.")
    assert suggest.read_turn_context(path, "   ") is None


@pytest.mark.asyncio
async def test_the_hook_reply_reaches_the_side_call(on_path: Path, tmp_path: Path) -> None:
    log = _fake_claude(on_path, "print('Ship it')")
    server = _Server()
    half = _transcript(tmp_path, _user("deploy it"), _assistant(_tool_use("t9")))
    await _schedule(
        server, half, suggest.SuggestionState(), last_assistant_message="Deployed to staging."
    )
    assert server.posts == [
        {"type": "external_session_suggestion", "data": {"suggestion": "Ship it"}}
    ]
    assert "Deployed to staging." in _calls(log)[0]["stdin"]


@pytest.mark.asyncio
async def test_a_non_default_provider_makes_no_call(
    on_path: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = _fake_claude(on_path, "print('x')")
    monkeypatch.setattr(suggest, "uses_default_provider", lambda bridge_dir, env=None: False)
    server = _Server()
    await _schedule(server, _finished_turn(tmp_path), suggest.SuggestionState())
    assert server.posts == []
    assert _calls(log) == []


@pytest.mark.asyncio
async def test_a_typed_prompt_clears_a_shown_suggestion(on_path: Path, tmp_path: Path) -> None:
    _fake_claude(on_path, "print('Open a draft PR')")
    server = _Server()
    state = suggest.SuggestionState()
    await _schedule(server, _finished_turn(tmp_path), state)
    assert state.shown == "conv_a"
    async with server.client() as client:
        await suggest.clear_prompt_suggestion(client, state=state)
        await suggest.clear_prompt_suggestion(client, state=state)  # nothing shown: no post
    assert server.posts[1:] == [
        {"type": "external_session_suggestion", "data": {"suggestion": None}}
    ]


@pytest.mark.asyncio
async def test_a_cancel_mid_post_still_gets_its_clear(
    on_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A new prompt landing while the suggestion's POST is in flight still clears it."""
    _fake_claude(on_path, "print('Open a draft PR')")
    posting = asyncio.Event()
    real_post = core.post_suggestion

    async def slow_post(client: httpx.AsyncClient, *, session_id: str, suggestion: Any) -> None:
        if suggestion is not None:
            posting.set()
            await asyncio.sleep(60)
        await real_post(client, session_id=session_id, suggestion=suggestion)

    monkeypatch.setattr(core, "post_suggestion", slow_post)
    server = _Server()
    state = suggest.SuggestionState()
    async with server.client() as client:
        task = asyncio.create_task(
            core.suggest_and_post(
                client,
                session_id="conv_a",
                context=suggest.TurnContext("fix it", "Fixed."),
                state=state,
            )
        )
        state.task = task
        await asyncio.wait_for(posting.wait(), 10)
        await suggest.clear_prompt_suggestion(client, state=state)
        with pytest.raises(asyncio.CancelledError):
            await task
    assert server.posts == [{"type": "external_session_suggestion", "data": {"suggestion": None}}]


@pytest.mark.asyncio
async def test_no_post_after_the_client_closed(on_path: Path, tmp_path: Path) -> None:
    _fake_claude(on_path, "time.sleep(1); print('late')")
    server = _Server()
    state = suggest.SuggestionState()
    async with server.client() as client:
        suggest.schedule_prompt_suggestion(
            client,
            session_id="conv_a",
            transcript_path=_finished_turn(tmp_path),
            recorded_at=None,
            state=state,
            env=ON,
        )
    task = state.task
    assert task is not None
    await task
    assert server.posts == []


@pytest.mark.asyncio
async def test_the_forwarder_exit_cancels_the_side_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cancelling the forwarder (teardown, supervisor restart) leaves no call behind."""
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def hanging_suggest(*args: Any, **kwargs: Any) -> None:
        started.set()
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    monkeypatch.setattr(suggest, "_suggest", hanging_suggest)
    monkeypatch.setenv(suggest.ENABLE_ENV_VAR, "1")
    bridge_dir = tmp_path / "bridge"
    transcript = _finished_turn(tmp_path)
    for event in ("SessionStart", "Stop"):
        record_hook_event(
            bridge_dir,
            {
                "hook_event_name": event,
                "session_id": "claude-session",
                "transcript_path": str(transcript),
                "last_assistant_message": "Fixed.",
            },
        )
    server, _thread, base_url = _start_recording_server()
    task = asyncio.create_task(
        forwarder.forward_claude_transcript_to_session(
            base_url=base_url,
            headers={},
            session_id="conv_parent",
            bridge_dir=bridge_dir,
            agent_name="claude-native-ui",
            start_at_end=False,
            poll_interval_s=0.01,
        )
    )
    try:
        await asyncio.wait_for(started.wait(), 10)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        server.shutdown()
        server.server_close()
    await asyncio.wait_for(cancelled.wait(), 2)


# ── Named Claude accounts ──────────────────────────────────────────

_ACCOUNT_TOKEN = "sk-ant-oat-account-token-for-tests"


@pytest.fixture
def host_accounts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A host with one named account, "AE Backup", whose token sits in this host's secrets."""
    from omnigent.onboarding import claude_accounts

    store = tmp_path / "claude-accounts.json"
    store.write_text(json.dumps({"accounts": ["AE Backup"], "active": ""}))
    monkeypatch.setattr(claude_accounts, "_path", lambda: store)
    monkeypatch.setattr(
        claude_accounts.secrets,
        "load_secret",
        lambda name: _ACCOUNT_TOKEN if name == "claude-oauth-AE Backup" else None,
    )
    monkeypatch.setattr(suggest, "session_login_env", _REAL_SESSION_LOGIN_ENV)


def test_session_account_reads_the_status_line_sidecar(tmp_path: Path) -> None:
    """The statusLine shim writes "" for the default login and the name otherwise."""
    assert suggest.session_account(None) is None
    assert suggest.session_account(tmp_path) is None  # no render yet: unknown
    (tmp_path / "claude_account").write_text("")
    assert suggest.session_account(tmp_path) == ""
    (tmp_path / "claude_account").write_text("AE Backup\n")
    assert suggest.session_account(tmp_path) == "AE Backup"


def test_the_account_login_resolves_as_the_launch_does(
    host_accounts: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same environment the terminal launch gets from account_env_for_launch."""
    from omnigent.onboarding.claude_accounts import account_env_for_launch

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert core.account_login_env("") == {}
    assert core.account_login_env(None) == {}  # the host's active account is the default
    login = core.account_login_env("AE Backup")
    assert login == account_env_for_launch({}, account_name="AE Backup")
    assert login is not None and login["CLAUDE_CODE_OAUTH_TOKEN"] == _ACCOUNT_TOKEN
    assert login["ANTHROPIC_API_KEY"] == "" and login["ANTHROPIC_AUTH_TOKEN"] == ""
    assert core.account_login_env("Gone") is None  # not on this host
    # The launch's provider-conflict check holds: a raw API key and a named account.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api-raw")
    assert core.account_login_env("AE Backup") is None
    # None follows the host's active account.
    (tmp_path / "claude-accounts.json").write_text(
        json.dumps({"accounts": ["AE Backup"], "active": "AE Backup"})
    )
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    active = core.account_login_env(None)
    assert active is not None and active["CLAUDE_CODE_OAUTH_TOKEN"] == _ACCOUNT_TOKEN


async def _schedule_in(server: _Server, tmp_path: Path, bridge_dir: Path) -> None:
    state = suggest.SuggestionState()
    async with server.client() as client:
        suggest.schedule_prompt_suggestion(
            client,
            session_id="conv_a",
            transcript_path=_finished_turn(tmp_path),
            recorded_at=None,
            state=state,
            bridge_dir=bridge_dir,
            env=ON,
        )
        assert state.task is not None
        await state.task


@pytest.mark.asyncio
async def test_a_named_account_session_calls_on_that_account_via_env_only(
    on_path: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    host_accounts: None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    # The host's default login is a fresh credentials file; it must not be copied.
    home = tmp_path / "home"
    _credentials(home, 3600)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN")
    log = _fake_claude(on_path, "print('Open a draft PR')")
    bridge_dir = tmp_path / "bridge"
    bridge_dir.mkdir()
    (bridge_dir / "claude_account").write_text("AE Backup")
    server = _Server()
    caplog.set_level("DEBUG")
    await _schedule_in(server, tmp_path, bridge_dir)
    (call,) = _calls(log)
    assert call["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == _ACCOUNT_TOKEN
    assert call["env"]["ANTHROPIC_API_KEY"] == ""  # blanked, as the launch does
    assert call["config_files"] == []  # no login file copied into the private dir
    assert "OMNIGENT_CLAUDE_ACCOUNT" not in call["env"]
    assert server.posts == [
        {"type": "external_session_suggestion", "data": {"suggestion": "Open a draft PR"}}
    ]
    assert _ACCOUNT_TOKEN not in caplog.text
    assert _leftover_dirs(on_path) == []


@pytest.mark.asyncio
async def test_the_default_account_session_keeps_the_default_login(
    on_path: Path, tmp_path: Path, host_accounts: None
) -> None:
    log = _fake_claude(on_path, "print('Open a draft PR')")
    bridge_dir = tmp_path / "bridge"
    bridge_dir.mkdir()
    (bridge_dir / "claude_account").write_text("")
    server = _Server()
    await _schedule_in(server, tmp_path, bridge_dir)
    (call,) = _calls(log)
    assert call["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == "test-token"  # the host default
    assert len(server.posts) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("account", ["Gone", None])
async def test_an_unresolvable_or_unknown_account_skips(
    on_path: Path,
    tmp_path: Path,
    host_accounts: None,
    account: str | None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    log = _fake_claude(on_path, "print('x')")
    bridge_dir = tmp_path / "bridge"
    bridge_dir.mkdir()
    if account is not None:
        (bridge_dir / "claude_account").write_text(account)
    server = _Server()
    caplog.set_level("DEBUG")
    await _schedule_in(server, tmp_path, bridge_dir)
    assert _calls(log) == []
    assert server.posts == []
    assert "prompt suggestion skipped" in caplog.text
