"""Tests for the claude-native live spinner parse and its relay."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from omnigent.harnesses.claude_native import ae_pane_progress, forwarder
from omnigent.harnesses.claude_native import bridge as claude_native_bridge
from omnigent.harnesses.claude_native.ae_pane_progress import (
    PROGRESS_REFRESH_S,
    PROGRESS_UNKNOWN,
    PaneProgress,
    PaneProgressRead,
    ProgressRelayState,
    clear_progress_on_rotation,
    progress_from_line,
    progress_from_pane,
    relay_progress,
)
from omnigent.harnesses.claude_native.bridge import PaneSignals
from omnigent.server.routes._sessions import ae_session_progress as route_module
from omnigent.util import ae_session_progress as contract

_RULE = "────────────────────────────────"
CRUNCHING = PaneProgress("Crunching", "4m 42s", 282, "24.5k tokens")


def _pane(*above_box: str) -> str:
    """Build a pane with transcript rows, the given rows, then input box and footer."""
    return "\n".join(
        [
            "● Writing the report now.",
            "",
            *above_box,
            "",
            _RULE,
            "❯ ",
            _RULE,
            "  ⏵⏵ auto mode on (shift+tab to cycle)",
        ]
    )


def _read(pane: str) -> PaneProgressRead:
    """Run the pane parse with the bridge's own box and /btw detectors."""
    return progress_from_pane(
        pane,
        find_box_opener=claude_native_bridge._composer_opening_rule,
        btw_overlay_shown=claude_native_bridge._btw_overlay_present,
    )


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("✻ Crunching… (4m 42s · ↓ 24.5k tokens)", CRUNCHING),
        ("· Thinking… (12s · esc to interrupt)", PaneProgress("Thinking", "12s", 12, None)),
        (
            "✶ Pondering… (38s · ↑ 1.2k tokens · esc to interrupt)",
            PaneProgress("Pondering", "38s", 38, "1.2k tokens"),
        ),
        (
            "✽ Catapulting… (6m 47s · ↓ 37.7k tokens · esc to interrupt)",
            PaneProgress("Catapulting", "6m 47s", 407, "37.7k tokens"),
        ),
        ("✢ Moonwalking... (1h 3m)", PaneProgress("Moonwalking", "1h 3m", 3780, None)),
        (
            "* Topsy-turvying… (2s · 312 tokens)",
            PaneProgress("Topsy-turvying", "2s", 2, "312 tokens"),
        ),
    ],
)
def test_progress_from_line_parses_the_spinner_shapes(line: str, expected: PaneProgress) -> None:
    """Every spinner shape Claude Code draws yields its verb, elapsed and tokens."""
    assert progress_from_line(line) == expected


@pytest.mark.parametrize(
    "line",
    [
        "✻ Worked for 4m 42s",
        "✻ Waiting for 1 background agent to finish",
        "✻ Crunching…",
        "✻ Crunching… (esc to interrupt)",
        "  ✻ Crunching… (4m 42s · ↓ 24.5k tokens)",
        "● ✻ Crunching… (4m 42s · ↓ 24.5k tokens)",
        "✻ crunching… (4m 42s)",
        "✻ Two words… (4m 42s)",
        "✻ Crunching (4m 42s)",
        "✻ Crunching… (soon)",
        "✻ Crunching… (9999h)",
        "",
    ],
)
def test_progress_from_line_rejects_other_wording(line: str) -> None:
    """Completion lines, indented echoes, unknown wording and absurd times are not progress."""
    assert progress_from_line(line) is None


def test_progress_from_pane_reads_the_spinner_above_the_input_box() -> None:
    """The spinner above the box is found even with todo rows under it."""
    pane = _pane(
        "✻ Crunching… (4m 42s · ↓ 24.5k tokens)",
        "  ⎿  ☐ Write the report",
        "     ☐ Run the tests",
    )
    assert _read(pane) == CRUNCHING


def test_progress_from_pane_finds_the_box_in_a_short_pane() -> None:
    """An earlier unrelated rule cannot pass for the box when the closing rule is cut off."""
    pane = "\n".join(
        [
            "  | col |",
            _RULE,
            "  table body",
            "✻ Crunching… (4m 42s · ↓ 24.5k tokens)",
            "",
            _RULE,
            "❯ a long draft",
        ]
    )
    assert _read(pane) == CRUNCHING


def test_progress_from_pane_returns_none_when_no_spinner_shows() -> None:
    """An idle pane, or a spinner echoed in the transcript, reads as no progress."""
    assert _read(_pane("✻ Worked for 3m 2s")) is None
    assert _read(_pane("  ✻ Crunching… (4m 42s · ↓ 24.5k tokens)")) is None


def test_progress_from_pane_is_unknown_when_it_cannot_tell() -> None:
    """A failed capture, a pane with no input box, or the /btw overlay reads as unknown."""
    assert _read("") == PROGRESS_UNKNOWN
    assert _read("   \n  \n") == PROGRESS_UNKNOWN
    assert _read("✻ Crunching… (4m 42s)\nloading…") == PROGRESS_UNKNOWN
    btw = "\n".join(
        [
            _pane("✻ Crunching… (4m 42s · ↓ 24.5k tokens)"),
            "▔" * 30,
            "    /btw is this safe?",
            "✻ Answering… (3s)",
            "    ←/→ to switch · x to clear history · Esc to close",
        ]
    )
    assert _read(btw) == PROGRESS_UNKNOWN


def test_read_pane_signals_carries_progress(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The one shared capture yields the progress beside the permission mode."""
    (tmp_path / "tmux.json").write_text(
        json.dumps({"socket_path": "/tmp/sock", "tmux_target": "main"}), encoding="utf-8"
    )
    monkeypatch.setattr(
        claude_native_bridge,
        "_capture_pane",
        lambda *_a, **_k: _pane("✻ Crunching… (4m 42s · ↓ 24.5k tokens)"),
    )
    signals = claude_native_bridge.read_pane_signals(tmp_path)
    assert signals.permission_mode == "auto"
    assert signals.progress == CRUNCHING


def test_read_pane_signals_failed_capture_is_unknown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``capture-pane`` failing returns ``""``, which must not read as "spinner gone"."""
    (tmp_path / "tmux.json").write_text(
        json.dumps({"socket_path": "/tmp/sock", "tmux_target": "main"}), encoding="utf-8"
    )
    monkeypatch.setattr(claude_native_bridge, "_capture_pane", lambda *_a, **_k: "")
    assert claude_native_bridge.read_pane_signals(tmp_path).progress == PROGRESS_UNKNOWN
    assert PaneSignals().progress == PROGRESS_UNKNOWN


def test_forwarder_and_route_share_one_contract() -> None:
    """The type string and bounds come from one module on both sides."""
    assert (
        ae_pane_progress.EXTERNAL_SESSION_PROGRESS_TYPE is contract.EXTERNAL_SESSION_PROGRESS_TYPE
    )
    assert route_module.EXTERNAL_SESSION_PROGRESS_TYPE is contract.EXTERNAL_SESSION_PROGRESS_TYPE
    assert route_module._FIELD_LIMITS == {
        "label": contract.MAX_LABEL_CHARS,
        "elapsed": contract.MAX_ELAPSED_CHARS,
        "tokens": contract.MAX_TOKENS_CHARS,
    }


def _recording_client(status: int = 202) -> tuple[list[dict[str, Any]], httpx.MockTransport]:
    """Return a list of posted bodies and a transport that records into it."""
    posts: list[dict[str, Any]] = []

    def _handle(request: httpx.Request) -> httpx.Response:
        """Record the POST body and answer with ``status``."""
        posts.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(status, json={})

    return posts, httpx.MockTransport(_handle)


class _Clock:
    """A settable stand-in for ``time.monotonic``."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    """Drive the relay's refresh timer by hand."""
    fake = _Clock()
    monkeypatch.setattr(ae_pane_progress.time, "monotonic", fake)
    return fake


def _data(progress: PaneProgress) -> dict[str, Any]:
    """The POST data the relay sends for ``progress``."""
    return {
        "label": progress.label,
        "elapsed": progress.elapsed,
        "elapsed_s": progress.elapsed_s,
        "tokens": progress.tokens,
    }


@pytest.mark.asyncio
async def test_relay_progress_posts_changes_refreshes_and_clears(clock: _Clock) -> None:
    """
    A new token count posts at once, an elapsed-only change waits for the
    refresh window, unknown reads post nothing, and the end posts one clear.
    """
    state = ProgressRelayState()
    posts, transport = _recording_client()
    tick_2s = PaneProgress("Crunching", "4m 44s", 284, "24.5k tokens")
    tick_10s = PaneProgress("Crunching", "4m 52s", 292, "24.5k tokens")
    more_tokens = PaneProgress("Crunching", "4m 54s", 294, "25.1k tokens")
    async with httpx.AsyncClient(transport=transport, base_url="http://ap") as client:

        async def relay(progress: PaneProgressRead, advance: float = 2.0) -> None:
            clock.now += advance
            await relay_progress(client, session_id="conv1", progress=progress, state=state)

        await relay(None)
        await relay(CRUNCHING)
        await relay(tick_2s)
        await relay(PROGRESS_UNKNOWN)
        await relay(tick_10s, advance=PROGRESS_REFRESH_S - 2.0)
        await relay(more_tokens)
        await relay(PROGRESS_UNKNOWN)
        await relay(None)
        await relay(None)

    assert [p["data"] for p in posts] == [
        _data(CRUNCHING),
        _data(tick_10s),
        _data(more_tokens),
        {"label": None},
    ]
    assert all(p["type"] == "external_session_progress" for p in posts)
    assert state.posted is None


@pytest.mark.asyncio
async def test_relay_progress_retries_a_failed_post_and_never_raises(clock: _Clock) -> None:
    """A rejected POST leaves the state alone so the next poll posts again."""
    state = ProgressRelayState()
    progress = PaneProgress("Thinking", "12s", 12)
    failing_posts, failing = _recording_client(status=503)
    async with httpx.AsyncClient(transport=failing, base_url="http://ap") as client:
        await relay_progress(client, session_id="conv1", progress=progress, state=state)
    assert len(failing_posts) == 1
    assert state.posted is None

    posts, transport = _recording_client()
    async with httpx.AsyncClient(transport=transport, base_url="http://ap") as client:
        await relay_progress(client, session_id="conv1", progress=progress, state=state)
    assert posts[0]["data"] == _data(progress)
    assert state.posted == progress


@pytest.mark.asyncio
async def test_clear_progress_on_rotation_clears_the_old_session_once(clock: _Clock) -> None:
    """A /clear or /fork rotation clears the line it left on the old conversation."""
    state = ProgressRelayState()
    posts, transport = _recording_client()
    async with httpx.AsyncClient(transport=transport, base_url="http://ap") as client:
        await clear_progress_on_rotation(client, old_session_id="conv_old", state=state)
        await relay_progress(client, session_id="conv_old", progress=CRUNCHING, state=state)
        await clear_progress_on_rotation(client, old_session_id="conv_old", state=state)

    assert [(p["data"]["label"]) for p in posts] == ["Crunching", None]
    assert state.posted is None


@pytest.mark.asyncio
async def test_forward_pane_signals_relays_progress(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The shared pane capture hands its spinner to the progress relay."""
    snapshots = iter(
        [
            PaneSignals(progress=CRUNCHING),
            PaneSignals(progress=CRUNCHING),
            PaneSignals(),
            PaneSignals(progress=None),
        ]
    )
    monkeypatch.setattr(forwarder, "read_pane_signals", lambda _bridge_dir: next(snapshots))
    monkeypatch.setattr(forwarder, "_PANE_POLL_INTERVAL_S", 0.0)
    dedupe = forwarder._ForwardDedupeState()
    posts, transport = _recording_client()
    async with httpx.AsyncClient(transport=transport, base_url="http://ap") as client:
        for _ in range(4):
            await forwarder._forward_pane_signals(
                client, session_id="conv1", bridge_dir=tmp_path, dedupe=dedupe
            )

    progress_posts = [p["data"] for p in posts if p["type"] == "external_session_progress"]
    assert progress_posts == [_data(CRUNCHING), {"label": None}]
    assert dedupe.progress_relay.posted is None
