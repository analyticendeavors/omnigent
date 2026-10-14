"""Tests for the claude-native fast mode events and the snapshot they read.

The pane is never real here: ``inject_slash_command`` is stubbed, and the stub
plays Claude Code plus the forwarder by writing ``context.json`` the way the
statusLine wrapper does, so the reader under test is the real one.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from omnigent.harnesses.claude_native import bridge as claude_native_bridge
from omnigent.harnesses.claude_native import status as claude_native_status
from omnigent.runner import ae_fast_mode, create_runner_app
from omnigent.runner.ae_fast_mode import handle_fast_mode_event, read_claude_fast_mode
from omnigent.spec.types import AgentSpec, ExecutorSpec
from tests.runner.conftest import _FakeProcessManager, _runner_client, _ScriptedHarnessClient
from tests.runner.helpers import NullServerClient

SESSION_ID = "5f1e0c3a9b7d4e2fa6c8b0d1e3f5a7c9"
AGENT_ID = "880b5afda28ad55ff74cbeb9b5fc67fb"


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


@pytest.fixture
def bridge_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point every bridge id at a temp dir and keep the confirm loop fast."""
    root = tmp_path / "bridges"
    monkeypatch.setattr(claude_native_bridge, "bridge_dir_for_bridge_id", lambda bid: root / bid)
    monkeypatch.setattr(ae_fast_mode, "FAST_MODE_CONFIRM_TIMEOUT_S", 0.2)
    monkeypatch.setattr(ae_fast_mode, "FAST_MODE_CONFIRM_POLL_S", 0.01)
    return root / SESSION_ID


async def _no_heal(conversation_id: str, bridge_dir: Path) -> None:
    del conversation_id, bridge_dir


async def _event(body: dict[str, Any], *, harness: str | None = "claude-native") -> Any:
    response = await handle_fast_mode_event(
        SESSION_ID,
        body,
        harness=harness,
        server_client=NullServerClient(),  # type: ignore[arg-type]
        prepare_pane=_no_heal,
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


# The handler, called directly.


async def test_status_reads_the_snapshot(bridge_dir: Path) -> None:
    _write_snapshot(bridge_dir, fast_mode=True)
    assert await _event({"type": "fast_mode_status"}) == (200, {"enabled": True})


async def test_status_is_unknown_without_a_snapshot(bridge_dir: Path) -> None:
    assert await _event({"type": "fast_mode_status"}) == (200, {"enabled": None})


async def test_status_is_unknown_before_the_runner_loads_the_session(bridge_dir: Path) -> None:
    assert await _event({"type": "fast_mode_status"}, harness=None) == (200, {"enabled": None})


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


async def test_change_already_in_place_types_nothing(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_snapshot(bridge_dir, fast_mode=True)
    pane = _Pane(bridge_dir)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)

    assert await _event({"type": "fast_mode_change", "enabled": True}) == (200, {"enabled": True})
    assert pane.calls == []


async def test_change_that_never_shows_answers_503(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_snapshot(bridge_dir, fast_mode=False)
    pane = _Pane(bridge_dir, applies=False)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)

    status, body = await _event({"type": "fast_mode_change", "enabled": True})
    assert status == 503
    assert body["error"] == "claude_native_fast_mode_unconfirmed"
    assert "did not confirm the change" in body["detail"]
    assert "/fast" in body["detail"]


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


async def test_change_without_a_bridge_answers_503_after_the_heal(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pane = _Pane(bridge_dir)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)
    healed: list[tuple[str, Path]] = []

    async def _heal(conversation_id: str, bridge: Path) -> None:
        healed.append((conversation_id, bridge))

    response = await handle_fast_mode_event(
        SESSION_ID,
        {"type": "fast_mode_change", "enabled": True},
        harness="claude-native",
        server_client=NullServerClient(),  # type: ignore[arg-type]
        prepare_pane=_heal,
    )
    body = json.loads(bytes(response.body))
    assert response.status_code == 503
    assert body["error"] == "claude_native_bridge_missing"
    assert healed == [(SESSION_ID, bridge_dir)]
    assert pane.calls == []


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


async def _post_events(harness: str, *bodies: dict[str, Any]) -> list[Any]:
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
    async with _runner_client(app) as client:
        created = await client.post(
            "/v1/sessions", json={"session_id": SESSION_ID, "agent_id": AGENT_ID}
        )
        assert created.status_code == 201, created.text
        return [
            await client.post(f"/v1/sessions/{SESSION_ID}/events", json=body) for body in bodies
        ]


async def test_runner_routes_both_events_for_a_claude_session(
    bridge_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_snapshot(bridge_dir, fast_mode=False)
    pane = _Pane(bridge_dir)
    monkeypatch.setattr(claude_native_bridge, "inject_slash_command", pane)

    before, change, after = await _post_events(
        "claude-native",
        {"type": "fast_mode_status"},
        {"type": "fast_mode_change", "enabled": True},
        {"type": "fast_mode_status"},
    )
    assert (before.status_code, before.json()) == (200, {"enabled": False})
    assert (change.status_code, change.json()) == (200, {"enabled": True})
    assert (after.status_code, after.json()) == (200, {"enabled": True})
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
