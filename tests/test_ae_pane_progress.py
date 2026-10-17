"""Tests for the claude-native live spinner parse and its relay."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from omnigent.harnesses.claude_native import bridge as claude_native_bridge
from omnigent.harnesses.claude_native import forwarder
from omnigent.harnesses.claude_native.ae_pane_progress import (
    PaneProgress,
    ProgressRelayState,
    progress_from_line,
    progress_from_pane,
    relay_progress,
)
from omnigent.harnesses.claude_native.bridge import PaneSignals


def _pane(*above_box: str) -> str:
    """Build a pane with transcript rows, the given rows, then input box and footer."""
    return "\n".join(
        [
            "● Writing the report now.",
            "",
            *above_box,
            "",
            "────────────────────────────────",
            "❯ ",
            "────────────────────────────────",
            "  ⏵⏵ auto mode on (shift+tab to cycle)",
        ]
    )


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        (
            "✻ Crunching… (4m 42s · ↓ 24.5k tokens)",
            PaneProgress("Crunching", "4m 42s", "24.5k tokens"),
        ),
        ("· Thinking… (12s · esc to interrupt)", PaneProgress("Thinking", "12s", None)),
        (
            "✶ Pondering… (38s · ↑ 1.2k tokens · esc to interrupt)",
            PaneProgress("Pondering", "38s", "1.2k tokens"),
        ),
        (
            "✽ Catapulting… (6m 47s · ↓ 37.7k tokens · esc to interrupt)",
            PaneProgress("Catapulting", "6m 47s", "37.7k tokens"),
        ),
        ("✢ Moonwalking... (1h 3m)", PaneProgress("Moonwalking", "1h 3m", None)),
        (
            "* Topsy-turvying… (2s · 312 tokens)",
            PaneProgress("Topsy-turvying", "2s", "312 tokens"),
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
        "",
    ],
)
def test_progress_from_line_rejects_other_wording(line: str) -> None:
    """Completion lines, indented echoes and unknown wording are not progress."""
    assert progress_from_line(line) is None


def test_progress_from_pane_reads_the_spinner_above_the_input_box() -> None:
    """The spinner above the box is found even with todo rows under it."""
    pane = _pane(
        "✻ Crunching… (4m 42s · ↓ 24.5k tokens)",
        "  ⎿  ☐ Write the report",
        "     ☐ Run the tests",
    )
    assert progress_from_pane(pane, claude_native_bridge._is_box_rule) == PaneProgress(
        "Crunching", "4m 42s", "24.5k tokens"
    )


def test_progress_from_pane_returns_none_when_no_spinner_shows() -> None:
    """An idle pane, or a spinner echoed in the transcript, reads as no progress."""
    is_rule = claude_native_bridge._is_box_rule
    assert progress_from_pane(_pane("✻ Worked for 3m 2s"), is_rule) is None
    echoed = _pane("  ✻ Crunching… (4m 42s · ↓ 24.5k tokens)")
    assert progress_from_pane(echoed, is_rule) is None
    assert progress_from_pane("", is_rule) is None


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
    assert signals.progress == PaneProgress("Crunching", "4m 42s", "24.5k tokens")


def _recording_client(status: int = 202) -> tuple[list[dict[str, Any]], httpx.MockTransport]:
    """Return a list of posted bodies and a transport that records into it."""
    posts: list[dict[str, Any]] = []

    def _handle(request: httpx.Request) -> httpx.Response:
        """Record the POST body and answer with ``status``."""
        posts.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(status, json={})

    return posts, httpx.MockTransport(_handle)


@pytest.mark.asyncio
async def test_relay_progress_posts_changes_once_and_clears_once() -> None:
    """A steady spinner posts once, a change posts again, and its end posts one clear."""
    state = ProgressRelayState()
    posts, transport = _recording_client()
    first = PaneProgress("Crunching", "4m 42s", "24.5k tokens")
    later = PaneProgress("Crunching", "4m 44s", "24.9k tokens")
    async with httpx.AsyncClient(transport=transport, base_url="http://ap") as client:
        for progress in (None, first, first, later, None, None):
            await relay_progress(client, session_id="conv1", progress=progress, state=state)

    assert posts == [
        {
            "type": "external_session_progress",
            "data": {"label": "Crunching", "elapsed": "4m 42s", "tokens": "24.5k tokens"},
        },
        {
            "type": "external_session_progress",
            "data": {"label": "Crunching", "elapsed": "4m 44s", "tokens": "24.9k tokens"},
        },
        {"type": "external_session_progress", "data": {"label": None}},
    ]
    assert state.posted is None


@pytest.mark.asyncio
async def test_relay_progress_retries_a_failed_post_and_never_raises() -> None:
    """A rejected POST leaves the state alone so the next poll posts again."""
    state = ProgressRelayState()
    progress = PaneProgress("Thinking", "12s")
    failing_posts, failing = _recording_client(status=503)
    async with httpx.AsyncClient(transport=failing, base_url="http://ap") as client:
        await relay_progress(client, session_id="conv1", progress=progress, state=state)
    assert len(failing_posts) == 1
    assert state.posted is None

    posts, transport = _recording_client()
    async with httpx.AsyncClient(transport=transport, base_url="http://ap") as client:
        await relay_progress(client, session_id="conv1", progress=progress, state=state)
    assert posts[0]["data"] == {"label": "Thinking", "elapsed": "12s", "tokens": None}
    assert state.posted == progress


@pytest.mark.asyncio
async def test_forward_pane_signals_relays_progress(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The shared pane capture hands its spinner to the progress relay."""
    snapshots = iter(
        [
            PaneSignals(progress=PaneProgress("Crunching", "4m 42s", "24.5k tokens")),
            PaneSignals(progress=PaneProgress("Crunching", "4m 42s", "24.5k tokens")),
            PaneSignals(),
        ]
    )
    monkeypatch.setattr(forwarder, "read_pane_signals", lambda _bridge_dir: next(snapshots))
    monkeypatch.setattr(forwarder, "_PANE_POLL_INTERVAL_S", 0.0)
    dedupe = forwarder._ForwardDedupeState()
    posts, transport = _recording_client()
    async with httpx.AsyncClient(transport=transport, base_url="http://ap") as client:
        for _ in range(3):
            await forwarder._forward_pane_signals(
                client, session_id="conv1", bridge_dir=tmp_path, dedupe=dedupe
            )

    progress_posts = [p["data"] for p in posts if p["type"] == "external_session_progress"]
    assert progress_posts == [
        {"label": "Crunching", "elapsed": "4m 42s", "tokens": "24.5k tokens"},
        {"label": None},
    ]
    assert dedupe.progress_relay.posted is None
