"""Tests for the claude-native fast mode events and the snapshot they read.

The pane is never real here: ``inject_slash_command`` is stubbed, and the stub
plays Claude Code plus the forwarder by writing ``context.json`` the way the
statusLine wrapper does, so the reader under test is the real one. The host's
Claude user settings live in a temp ``CLAUDE_CONFIG_DIR``.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

import pytest

from omnigent.harnesses.claude_native import bridge as claude_native_bridge
from omnigent.harnesses.claude_native import status as claude_native_status
from omnigent.runner import ae_fast_mode, create_runner_app
from omnigent.runner.ae_fast_mode import (
    NO_TERMINAL_DETAIL,
    REASON_AFTER_REPLY,
    REASON_UNCONFIRMED,
    claude_fast_mode_per_session,
    handle_fast_mode_event,
    read_claude_fast_mode,
)
from omnigent.spec.types import AgentSpec, ExecutorSpec
from tests.runner.conftest import _FakeProcessManager, _runner_client, _ScriptedHarnessClient
from tests.runner.helpers import NullServerClient

SESSION_ID = "5f1e0c3a9b7d4e2fa6c8b0d1e3f5a7c9"
AGENT_ID = "880b5afda28ad55ff74cbeb9b5fc67fb"
OPT_IN = {"fastModePerSessionOptIn": True}


def _write_snapshot(bridge_dir: Path, **fields: object) -> None:
    """Write a ``context.json`` record through the wrapper's own normalizer."""
    raw = {"context_window": {"context_window_size": 200_000}, **fields}
    record = claude_native_status.normalize_status_payload(raw)
    assert record is not None
    bridge_dir.mkdir(parents=True, exist_ok=True)
    (bridge_dir / "context.json").write_text(json.dumps(record), encoding="utf-8")


class _Pane:
    """Stub for ``inject_slash_command`` that records commands and flips the snapshot."""

    def __init__(self, bridge_dir: Path, *, applies: bool = True) -> None:
        self.bridge_dir = bridge_dir
        self.applies = applies
        self.calls: list[dict[str, Any]] = []

    def __call__(self, bridge_dir: Path, *, command: str, **kwargs: Any) -> None:
        self.calls.append({"bridge_dir": bridge_dir, "command": command, **kwargs})
        if self.applies:
            _write_snapshot(bridge_dir, fast_mode=command == "/fast on")


class _Terminal:
    """Stands in for the registered Claude pane and its liveness probe."""

    def __init__(self, *, alive: bool = True) -> None:
        self.alive = alive

    async def is_alive(self) -> bool:
        return self.alive


class _Registry:
    """Stands in for the runner's terminal registry, holding at most one pane."""

    def __init__(self, pane: _Terminal | None) -> None:
        self.pane = pane
        self.lookups: list[tuple[str, str, str]] = []

    def get(self, conversation_id: str, terminal_name: str, session_key: str) -> _Terminal | None:
        self.lookups.append((conversation_id, terminal_name, session_key))
        return self.pane


@pytest.fixture
def bridge_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point every bridge id at a temp dir and keep the confirm loop fast."""
    root = tmp_path / "bridges"
    monkeypatch.setattr(claude_native_bridge, "bridge_dir_for_bridge_id", lambda bid: root / bid)
    monkeypatch.setattr(ae_fast_mode, "FAST_MODE_CONFIRM_TIMEOUT_S", 0.2)
    monkeypatch.setattr(ae_fast_mode, "FAST_MODE_CONFIRM_POLL_S", 0.01)
    return root / SESSION_ID


@pytest.fixture(autouse=True)
def claude_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A Claude config dir whose settings keep fast mode per session."""
    config = tmp_path / "claude-config"
    config.mkdir()
    (config / "settings.json").write_text(json.dumps(OPT_IN), encoding="utf-8")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(config))
    return config


async def _no_heal(conversation_id: str, bridge_dir: Path) -> None:
    del conversation_id, bridge_dir


async def _event(
    body: dict[str, Any],
    *,
    harness: str | None = "claude-native",
    registry: _Registry | None = None,
    prepare_pane: Any = _no_heal,
    in_flight: bool = False,
) -> Any:
    response = await handle_fast_mode_event(
        SESSION_ID,
        body,
        harness=harness,
        server_client=NullServerClient(),  # type: ignore[arg-type]
        terminal_registry=registry or _Registry(_Terminal()),  # type: ignore[arg-type]
        prepare_pane=prepare_pane,
        turn_in_flight=lambda conversation_id: in_flight,
    )
    return response.status_code, json.loads(bytes(response.body)) if response.body else None


# The snapshot: status.py keeps the key, the reader returns it.


@pytest.mark.parametrize("value", [True, False])
def test_normalize_keeps_fast_mode(value: bool) -> None:
    record = claude_native_status.normalize_status_payload(
        {"context_window": {"context_window_size": 200_000}, "fast_mode": value}
    )
    assert record is not None
    assert record["fast_mode"] is value


def test_normalize_drops_a_non_boolean_fast_mode() -> None:
    record = claude_native_status.normalize_status_payload(
        {"context_window": {"context_window_size": 200_000}, "fast_mode": "true"}
    )
    assert record is not None
    assert "fast_mode" not in record


def test_raw_capture_round_trips_to_the_reader(tmp_path: Path) -> None:
    """The shim's raw capture, normalized by the forwarder, reads back as on."""
    raw = {
        "context_window": {"context_window_size": 1_000_000},
        "model": {"id": "claude-opus-5-5"},
        "fast_mode": True,
    }
    (tmp_path / claude_native_status.CONTEXT_RAW_FILE).write_text(json.dumps(raw))
    claude_native_status.sync_raw_status_context(tmp_path, None)
    assert read_claude_fast_mode(tmp_path) is True


@pytest.mark.parametrize(
    "content",
    [None, "{not json", json.dumps(["list"]), json.dumps({"model": "x"}), '{"fast_mode": 1}'],
)
def test_reader_answers_unknown_without_a_boolean(tmp_path: Path, content: str | None) -> None:
    if content is not None:
        (tmp_path / "context.json").write_text(content)
    assert read_claude_fast_mode(tmp_path) is None


# The host's Claude user settings.


@pytest.mark.parametrize(
    "content",
    [
        None,
        "{not json",
        json.dumps(["list"]),
        json.dumps({}),
        json.dumps({"fastModePerSessionOptIn": False}),
        json.dumps({"fastModePerSessionOptIn": "true"}),
    ],
)
def test_per_session_needs_the_opt_in_set_to_true(
    claude_config: Path, content: str | None
) -> None:
    settings = claude_config / "settings.json"
    settings.unlink()
    if content is not None:
        settings.write_text(content)
    assert claude_fast_mode_per_session() is False


def test_per_session_reads_the_home_config_dir_without_claude_config_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(json.dumps(OPT_IN))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR")
    monkeypatch.setenv("HOME", str(home))
    assert claude_fast_mode_per_session() is True


# The handler, called directly.


async def test_status_reads_the_snapshot_and_the_settings(bridge_dir: Path) -> None:
    _write_snapshot(bridge_dir, fast_mode=True)
    assert await _event({"type": "fast_mode_status"}) == (
        200,
        {"enabled": True, "per_session": True},
    )


async def test_status_reports_a_host_without_the_opt_in(
    bridge_dir: Path, claude_config: Path
) -> None:
    _write_snapshot(bridge_dir, fast_mode=False)
    (claude_config / "settings.json").write_text("{}")
    assert await _event({"type": "fast_mode_status"}) == (
        200,
        {"enabled": False, "per_session": False},
    )


async def test_status_is_unknown_without_a_snapshot(bridge_dir: Path) -> None:
    assert await _event({"type": "fast_mode_status"}) == (
        200,
        {"enabled": None, "per_session": True},
    )


async def test_status_is_unknown_before_the_runner_loads_the_session(bridge_dir: Path) -> None:
    assert await _event({"type": "fast_mode_status"}, harness=None) == (
        200,
        {"enabled": None, "per_session": True},
    )


async def test_change_types_fast_on_and_confirms(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_snapshot(bridge_dir, fast_mode=False)
    pane = _Pane(bridge_dir)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)

    assert await _event({"type": "fast_mode_change", "enabled": True}) == (200, {"enabled": True})
    assert [call["command"] for call in pane.calls] == ["/fast on"]
    # An explicit argument opens no dialog, so nothing may answer one blind.
    assert "auto_confirm" not in pane.calls[0]


async def test_change_types_fast_off_and_confirms(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_snapshot(bridge_dir, fast_mode=True)
    pane = _Pane(bridge_dir)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)

    assert await _event({"type": "fast_mode_change", "enabled": False}) == (
        200,
        {"enabled": False},
    )
    assert [call["command"] for call in pane.calls] == ["/fast off"]


async def test_change_from_unknown_confirms_once_the_snapshot_reports(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bridge_dir.mkdir(parents=True)
    pane = _Pane(bridge_dir)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)

    assert await _event({"type": "fast_mode_change", "enabled": True}) == (200, {"enabled": True})
    assert len(pane.calls) == 1


@pytest.mark.parametrize("enabled", [True, False])
async def test_change_types_even_when_the_snapshot_already_matches(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch, enabled: bool
) -> None:
    _write_snapshot(bridge_dir, fast_mode=enabled)
    pane = _Pane(bridge_dir)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)

    assert await _event({"type": "fast_mode_change", "enabled": enabled}) == (
        200,
        {"enabled": enabled},
    )
    assert [call["command"] for call in pane.calls] == [f"/fast {'on' if enabled else 'off'}"]


@pytest.mark.parametrize("settings", [None, "{}", json.dumps({"fastModePerSessionOptIn": False})])
async def test_turning_on_without_the_opt_in_answers_409_before_anything(
    bridge_dir: Path,
    claude_config: Path,
    monkeypatch: pytest.MonkeyPatch,
    settings: str | None,
) -> None:
    _write_snapshot(bridge_dir, fast_mode=False)
    (claude_config / "settings.json").unlink()
    if settings is not None:
        (claude_config / "settings.json").write_text(settings)
    pane = _Pane(bridge_dir)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)
    registry = _Registry(_Terminal())
    healed: list[str] = []

    async def _heal(conversation_id: str, bridge: Path) -> None:
        healed.append(conversation_id)

    status, body = await _event(
        {"type": "fast_mode_change", "enabled": True}, registry=registry, prepare_pane=_heal
    )
    assert status == 409
    assert body["error"] == "claude_native_fast_mode_needs_per_session"
    assert '"fastModePerSessionOptIn": true' in body["detail"]
    assert "deploy/README.md" in body["detail"]
    assert '"Fast mode, per session"' in body["detail"]
    assert pane.calls == []
    assert healed == []
    assert registry.lookups == []


async def test_turning_off_needs_no_opt_in(
    bridge_dir: Path, claude_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_snapshot(bridge_dir, fast_mode=True)
    (claude_config / "settings.json").unlink()
    pane = _Pane(bridge_dir)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)

    assert await _event({"type": "fast_mode_change", "enabled": False}) == (
        200,
        {"enabled": False},
    )
    assert [call["command"] for call in pane.calls] == ["/fast off"]


async def test_change_mid_turn_answers_202_pending_without_waiting(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Claude Code queues the typed command until the reply ends."""
    _write_snapshot(bridge_dir, fast_mode=False)
    pane = _Pane(bridge_dir, applies=False)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)
    monkeypatch.setattr(ae_fast_mode, "FAST_MODE_CONFIRM_TIMEOUT_S", 5.0)

    started = time.monotonic()
    result = await _event({"type": "fast_mode_change", "enabled": True}, in_flight=True)

    assert result == (202, {"enabled": True, "pending": True, "reason": REASON_AFTER_REPLY})
    assert REASON_AFTER_REPLY == "Applies when the current reply finishes"
    assert [call["command"] for call in pane.calls] == ["/fast on"]
    assert time.monotonic() - started < 2.0


async def test_change_typed_but_unconfirmed_answers_202_not_a_failure(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_snapshot(bridge_dir, fast_mode=False)
    pane = _Pane(bridge_dir, applies=False)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)

    result = await _event({"type": "fast_mode_change", "enabled": True})

    assert result == (202, {"enabled": True, "pending": True, "reason": REASON_UNCONFIRMED})
    assert REASON_UNCONFIRMED == "Waiting for Claude Code to confirm"
    assert len(pane.calls) == 1


async def test_change_with_a_failed_injection_answers_503_without_the_path(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bridge_dir.mkdir(parents=True)

    def _fail(bridge_dir: Path, **kwargs: Any) -> None:
        raise RuntimeError(f"tmux target is not advertised in {bridge_dir}")

    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", _fail)

    status, body = await _event({"type": "fast_mode_change", "enabled": True})
    assert status == 503
    assert body["error"] == "claude_native_fast_mode_failed"
    assert str(bridge_dir) not in body["detail"]
    assert "/fast on" in body["detail"]


async def test_change_with_a_pending_question_answers_409(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bridge_dir.mkdir(parents=True)

    def _pending(bridge_dir: Path, **kwargs: Any) -> None:
        raise claude_native_bridge.ClaudeUserPromptPending(
            "Answer the pending Claude question or permission request before changing settings."
        )

    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", _pending)

    status, body = await _event({"type": "fast_mode_change", "enabled": True})
    assert status == 409
    assert body["error"] == "claude_native_prompt_pending"
    assert body["detail"].startswith("Answer the pending Claude question")


async def test_change_heals_a_live_pane_then_types(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_snapshot(bridge_dir, fast_mode=False)
    steps: list[str] = []
    pane = _Pane(bridge_dir)

    def _type(bridge_dir: Path, *, command: str, **kwargs: Any) -> None:
        steps.append(command)
        pane(bridge_dir, command=command, **kwargs)

    async def _heal(conversation_id: str, bridge: Path) -> None:
        steps.append(f"heal {conversation_id} {bridge.name}")

    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", _type)
    registry = _Registry(_Terminal())

    assert await _event(
        {"type": "fast_mode_change", "enabled": True}, registry=registry, prepare_pane=_heal
    ) == (200, {"enabled": True})
    assert steps == [f"heal {SESSION_ID} {SESSION_ID}", "/fast on"]
    assert registry.lookups == [(SESSION_ID, "claude", "main")]


@pytest.mark.parametrize(
    ("registry", "make_bridge"),
    [
        (None, True),
        (_Registry(None), True),
        (_Registry(_Terminal(alive=False)), True),
        (_Registry(_Terminal()), False),
    ],
    ids=["no-registry", "no-pane", "dead-pane", "no-bridge"],
)
async def test_change_without_a_live_terminal_answers_409_and_never_heals(
    bridge_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    registry: _Registry | None,
    make_bridge: bool,
) -> None:
    if make_bridge:
        bridge_dir.mkdir(parents=True)
    pane = _Pane(bridge_dir)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)
    healed: list[str] = []

    async def _heal(conversation_id: str, bridge: Path) -> None:
        healed.append(conversation_id)

    response = await handle_fast_mode_event(
        SESSION_ID,
        {"type": "fast_mode_change", "enabled": False},
        harness="claude-native",
        server_client=NullServerClient(),  # type: ignore[arg-type]
        terminal_registry=registry,  # type: ignore[arg-type]
        prepare_pane=_heal,
        turn_in_flight=lambda conversation_id: False,
    )
    body = json.loads(bytes(response.body))
    assert response.status_code == 409
    assert body == {"error": "claude_native_no_terminal", "detail": NO_TERMINAL_DETAIL}
    assert NO_TERMINAL_DETAIL == (
        "No Claude Code terminal right now; send the session a message first."
    )
    assert healed == []
    assert pane.calls == []


async def test_a_session_runs_one_change_at_a_time(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each change checks, types and confirms before the next one starts."""
    _write_snapshot(bridge_dir, fast_mode=False)
    steps: list[str] = []
    read = ae_fast_mode.read_claude_fast_mode

    async def _heal(conversation_id: str, bridge: Path) -> None:
        steps.append("heal")
        await asyncio.sleep(0.01)

    def _type(bridge_dir: Path, *, command: str, **kwargs: Any) -> None:
        steps.append(f"type {command}")
        time.sleep(0.02)
        _write_snapshot(bridge_dir, fast_mode=command == "/fast on")

    def _read(bridge_dir: Path) -> bool | None:
        value = read(bridge_dir)
        steps.append(f"read {value}")
        return value

    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", _type)
    monkeypatch.setattr(ae_fast_mode, "read_claude_fast_mode", _read)

    on, off = await asyncio.gather(
        _event({"type": "fast_mode_change", "enabled": True}, prepare_pane=_heal),
        _event({"type": "fast_mode_change", "enabled": False}, prepare_pane=_heal),
    )

    assert on == (200, {"enabled": True})
    assert off == (200, {"enabled": False})
    assert sorted([steps[:3], steps[3:]]) == [
        ["heal", "type /fast off", "read False"],
        ["heal", "type /fast on", "read True"],
    ]


@pytest.mark.parametrize("enabled", [None, "on", 1])
async def test_change_rejects_a_non_boolean(bridge_dir: Path, enabled: object) -> None:
    status, body = await _event({"type": "fast_mode_change", "enabled": enabled})
    assert status == 400
    assert body["error"] == "invalid_input"


async def test_change_before_the_runner_loads_the_session_answers_503(bridge_dir: Path) -> None:
    status, body = await _event({"type": "fast_mode_change", "enabled": True}, harness=None)
    assert status == 503
    assert body["error"] == "session_not_loaded"


@pytest.mark.parametrize("event", ["fast_mode_status", "fast_mode_change"])
async def test_other_harnesses_answer_409(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch, event: str
) -> None:
    pane = _Pane(bridge_dir)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)

    status, body = await _event({"type": event, "enabled": True}, harness="codex-native")
    assert status == 409
    assert body["error"] == "fast_mode_unsupported"
    assert "codex-native" in body["detail"]
    assert pane.calls == []


# The dispatch lines in the runner's /events route.


async def _post_events(
    harness: str, *bodies: dict[str, Any], app_state: dict[str, Any] | None = None
) -> list[Any]:
    spec = AgentSpec(
        spec_version=1,
        name="t",
        executor=ExecutorSpec(type="omnigent", config={"harness": harness}),
    )

    async def _resolver(agent_id: str, session_id: str | None = None) -> AgentSpec:
        del agent_id, session_id
        return spec

    app = create_runner_app(
        process_manager=_FakeProcessManager(_ScriptedHarnessClient([])),  # type: ignore[arg-type]
        spec_resolver=_resolver,
        server_client=NullServerClient(),  # type: ignore[arg-type]
    )
    if app_state is not None:
        app_state["app"] = app
    async with _runner_client(app) as client:
        created = await client.post(
            "/v1/sessions", json={"session_id": SESSION_ID, "agent_id": AGENT_ID}
        )
        assert created.status_code == 201, created.text
        return [
            await client.post(f"/v1/sessions/{SESSION_ID}/events", json=body) for body in bodies
        ]


@pytest.fixture
def probed_panes(monkeypatch: pytest.MonkeyPatch) -> list[tuple[Any, str, Path]]:
    """Report every Claude pane as live, recording what the dispatch passed in."""
    probed: list[tuple[Any, str, Path]] = []

    async def _alive(registry: Any, conversation_id: str, bridge: Path) -> bool:
        probed.append((registry, conversation_id, bridge))
        return True

    monkeypatch.setattr(ae_fast_mode, "claude_pane_alive", _alive)
    return probed


async def test_runner_routes_both_events_for_a_claude_session(
    bridge_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    probed_panes: list[tuple[Any, str, Path]],
) -> None:
    _write_snapshot(bridge_dir, fast_mode=False)
    pane = _Pane(bridge_dir)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)
    app_state: dict[str, Any] = {}

    before, change, after = await _post_events(
        "claude-native",
        {"type": "fast_mode_status"},
        {"type": "fast_mode_change", "enabled": True},
        {"type": "fast_mode_status"},
        app_state=app_state,
    )
    assert (before.status_code, before.json()) == (200, {"enabled": False, "per_session": True})
    assert (change.status_code, change.json()) == (200, {"enabled": True})
    assert (after.status_code, after.json()) == (200, {"enabled": True, "per_session": True})
    assert [call["command"] for call in pane.calls] == ["/fast on"]
    registry = app_state["app"].state.session_resource_registry.terminal_registry
    assert probed_panes == [(registry, SESSION_ID, bridge_dir)]


async def test_runner_answers_pending_for_a_change_typed_mid_turn(
    bridge_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    probed_panes: list[tuple[Any, str, Path]],
) -> None:
    """The dispatch passes the pane's turn status, the model change's queued-switch signal."""
    _write_snapshot(bridge_dir, fast_mode=False)
    pane = _Pane(bridge_dir, applies=False)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)

    running, change = await _post_events(
        "claude-native",
        {"type": "external_session_status", "data": {"status": "running"}},
        {"type": "fast_mode_change", "enabled": True},
    )
    assert running.status_code < 300, running.text
    assert (change.status_code, change.json()) == (
        202,
        {"enabled": True, "pending": True, "reason": REASON_AFTER_REPLY},
    )
    assert [call["command"] for call in pane.calls] == ["/fast on"]


async def test_runner_refuses_fast_mode_for_a_non_claude_session(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pane = _Pane(bridge_dir)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)

    (response,) = await _post_events("codex-native", {"type": "fast_mode_change", "enabled": True})
    assert response.status_code == 409, response.text
    assert response.json()["error"] == "fast_mode_unsupported"
    assert pane.calls == []
