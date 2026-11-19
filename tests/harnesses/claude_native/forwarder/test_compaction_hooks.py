"""Compaction hooks tests for Claude-native forwarding."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest

import omnigent.harnesses.claude_native.forwarder as forwarder
from omnigent.harnesses.claude_native.bridge import (
    record_hook_event,
)
from tests.harnesses.claude_native.forwarder._support import (
    _CapturedRequest,
    _get_recorded_request,
    _start_recording_server,
)


@pytest.mark.asyncio
async def test_forwarder_posts_compaction_in_progress_on_precompact_hook(
    tmp_path: Path,
) -> None:
    """
    Claude Code's ``PreCompact`` hook surfaces as ``in_progress``.

    Claude compacts its own context in the terminal (manual ``/compact``
    or automatic overflow); the Omnigent server never runs the compaction for
    a claude-native session. Without forwarding ``PreCompact``, the web
    UI gets no signal while Claude compacts — the gap the user reported
    (the summary flushes in with no "Compacting…" spinner). The
    forwarder maps it to ``external_compaction_status: in_progress`` so
    Omnigent can publish the spinner SSE.
    """
    bridge_dir = tmp_path / "bridge"
    transcript_path = tmp_path / "session.jsonl"
    transcript_path.write_text("", encoding="utf-8")
    # SessionStart (no source) populates transcript_path so the forwarder
    # enters its loop; it is NOT a compaction edge and must NOT post.
    record_hook_event(
        bridge_dir,
        {
            "hook_event_name": "SessionStart",
            "session_id": "claude-session",
            "transcript_path": str(transcript_path),
        },
    )
    record_hook_event(
        bridge_dir,
        {"hook_event_name": "PreCompact", "trigger": "manual", "session_id": "claude-session"},
    )
    server, thread, base_url = _start_recording_server()
    task = asyncio.create_task(
        forwarder.forward_claude_transcript_to_session(
            base_url=base_url,
            headers={},
            session_id="conv_abc",
            bridge_dir=bridge_dir,
            agent_name="claude-native-ui",
            start_at_end=False,
            poll_interval_s=0.01,
        )
    )
    try:
        request = await _get_recorded_request(server)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)

    # First POST is the compaction in_progress — the plain SessionStart
    # before it produced no POST (it is not a compaction edge). If this
    # were external_session_status or absent, the spinner would never
    # appear for claude-native compaction.
    assert request["path"] == "/v1/sessions/conv_abc/events"
    assert request["body"] == {
        "type": "external_compaction_status",
        "data": {"status": "in_progress"},
    }


@pytest.mark.asyncio
async def test_compact_refusal_in_progress_precedes_failed_same_poll(
    tmp_path: Path,
) -> None:
    """
    A same-poll ``/compact`` refusal posts ``in_progress`` BEFORE ``failed``.

    Regression for the stranded spinner: the ``PreCompact`` hook (→
    ``in_progress``, which raises the spinner) is forwarded AFTER transcript
    items each poll, and Claude writes the refusal (transcript) and the
    ``PreCompact`` (hook) close enough to land in one poll. If the dismissal
    fired during the transcript phase it would clear nothing, then the hook
    would raise a spinner that never clears. The dismissal is deferred to
    after the hook phase, so the ordered posts are ``in_progress`` then
    ``failed`` — a net-dismissed spinner.
    """
    bridge_dir = tmp_path / "bridge"
    transcript_path = tmp_path / "session.jsonl"
    # The two records Claude writes for a declined /compact: the command echo
    # and the standalone refusal stdout.
    transcript_path.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "type": "user",
                        "uuid": "compact-cmd",
                        "message": {
                            "role": "user",
                            "content": (
                                "<command-name>/compact</command-name>\n<command-args></command-args>"
                            ),
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "system",
                        "subtype": "local_command",
                        "uuid": "compact-stdout",
                        "isMeta": False,
                        "content": (
                            "<local-command-stdout>Not enough messages to compact."
                            "</local-command-stdout>"
                        ),
                    }
                ),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    record_hook_event(
        bridge_dir,
        {
            "hook_event_name": "SessionStart",
            "session_id": "claude-session",
            "transcript_path": str(transcript_path),
        },
    )
    record_hook_event(
        bridge_dir,
        {"hook_event_name": "PreCompact", "session_id": "claude-session"},
    )
    server, thread, base_url = _start_recording_server()
    task = asyncio.create_task(
        forwarder.forward_claude_transcript_to_session(
            base_url=base_url,
            headers={},
            session_id="conv_abc",
            bridge_dir=bridge_dir,
            agent_name="claude-native-ui",
            start_at_end=False,
            poll_interval_s=0.01,
        )
    )
    try:
        # Collect compaction-status posts until both edges are seen.
        statuses: list[str] = []
        deadline = asyncio.get_running_loop().time() + 5.0
        while "failed" not in statuses and asyncio.get_running_loop().time() < deadline:
            request = await _get_recorded_request(server)
            if request["body"].get("type") == "external_compaction_status":
                statuses.append(request["body"]["data"]["status"])
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)

    # in_progress (spinner raised by the hook) must land before failed
    # (the deferred dismissal), so the net effect is a dismissed spinner.
    assert statuses == ["in_progress", "failed"], (
        f"expected in_progress then failed, got {statuses!r}"
    )


@pytest.mark.asyncio
async def test_forwarder_posts_compaction_completed_on_compact_session_start(
    tmp_path: Path,
) -> None:
    """
    Post-compaction ``SessionStart source=compact`` surfaces as ``completed``.

    Claude Code has no dedicated post-compaction hook; it resumes on the
    freshly-compacted context with a ``SessionStart`` whose ``source`` is
    ``"compact"``. The forwarder maps exactly that source to
    ``external_compaction_status: completed`` so the web UI upgrades the
    spinner to the permanent "Conversation compacted" marker. Other
    SessionStart sources (startup/resume/clear) are not compaction and
    must not post this.
    """
    bridge_dir = tmp_path / "bridge"
    transcript_path = tmp_path / "session.jsonl"
    transcript_path.write_text("", encoding="utf-8")
    # Initial SessionStart enters the loop (not a compaction edge).
    record_hook_event(
        bridge_dir,
        {
            "hook_event_name": "SessionStart",
            "session_id": "claude-session",
            "transcript_path": str(transcript_path),
        },
    )
    # Post-compaction SessionStart — the completion signal.
    record_hook_event(
        bridge_dir,
        {
            "hook_event_name": "SessionStart",
            "source": "compact",
            "session_id": "claude-session",
        },
    )
    server, thread, base_url = _start_recording_server()
    task = asyncio.create_task(
        forwarder.forward_claude_transcript_to_session(
            base_url=base_url,
            headers={},
            session_id="conv_abc",
            bridge_dir=bridge_dir,
            agent_name="claude-native-ui",
            start_at_end=False,
            poll_interval_s=0.01,
        )
    )
    try:
        request = await _get_recorded_request(server)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)

    # First (and only) POST is compaction completed. If the source check
    # regressed (e.g. firing for every SessionStart), startup/resume would
    # spuriously emit completed and flicker the UI marker.
    assert request["path"] == "/v1/sessions/conv_abc/events"
    assert request["body"] == {
        "type": "external_compaction_status",
        "data": {"status": "completed"},
    }


@pytest.mark.asyncio
async def test_forwarder_does_not_post_compaction_on_non_compact_session_start(
    tmp_path: Path,
) -> None:
    """
    A non-compact ``SessionStart`` (``source=startup``) emits no compaction.

    Guards the source check specifically: only ``source == "compact"``
    is the completion signal. A regression that fired on any
    SessionStart — or used ``source is not None`` instead of
    ``== "compact"`` — would spuriously flash the "Conversation
    compacted" marker on every startup/resume. We record a
    ``startup`` SessionStart followed by ``StopFailure``; because records
    are processed in order, a spurious compaction POST would land BEFORE
    the ``StopFailure`` → failed POST, so asserting the first POST is the
    failed status proves the startup SessionStart emitted nothing.
    (``StopFailure`` is used as the anchor because ``Stop`` no longer
    posts a status — idle now comes from PTY pane activity.)
    """
    bridge_dir = tmp_path / "bridge"
    transcript_path = tmp_path / "session.jsonl"
    transcript_path.write_text("", encoding="utf-8")
    record_hook_event(
        bridge_dir,
        {
            "hook_event_name": "SessionStart",
            "source": "startup",
            "session_id": "claude-session",
            "transcript_path": str(transcript_path),
        },
    )
    record_hook_event(
        bridge_dir,
        {"hook_event_name": "StopFailure", "session_id": "claude-session"},
    )
    server, thread, base_url = _start_recording_server()
    task = asyncio.create_task(
        forwarder.forward_claude_transcript_to_session(
            base_url=base_url,
            headers={},
            session_id="conv_abc",
            bridge_dir=bridge_dir,
            agent_name="claude-native-ui",
            start_at_end=False,
            poll_interval_s=0.01,
        )
    )
    try:
        request = await _get_recorded_request(server)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)

    # The first POST is the StopFailure→failed status, NOT a compaction
    # event: the preceding startup SessionStart produced nothing. If this
    # body were external_compaction_status, the source check regressed.
    assert request["path"] == "/v1/sessions/conv_abc/events"
    context = request["body"]["data"].pop("failure_context")
    assert context["native_hook_event"] == "StopFailure"
    assert request["body"] == {
        "type": "external_session_status",
        "data": {"status": "failed"},
    }


async def _run_dismiss_stranded_spinner(
    *,
    bridge_dir: Path,
    seq: int,
    status: int = 200,
) -> list[_CapturedRequest]:
    """
    Drive ``_maybe_dismiss_stranded_compaction_spinner`` against a mock AP.

    :param bridge_dir: Bridge dir holding the compaction state.
    :param seq: The refused compaction's ``PreCompact`` seq to dismiss.
    :param status: HTTP status the mock endpoint returns.
    :returns: Every request the helper issued, in order.
    """
    captured: list[_CapturedRequest] = []

    def handler(request: httpx.Request) -> httpx.Response:
        """Record the request and return a canned response."""
        body = json.loads(request.content.decode("utf-8")) if request.content else None
        captured.append(_CapturedRequest(method=request.method, path=request.url.path, body=body))
        return httpx.Response(status, json={"queued": False})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport, base_url="http://ap") as client:
        await forwarder._maybe_dismiss_stranded_compaction_spinner(
            client, session_id="conv_x", bridge_dir=bridge_dir, seq=seq
        )
    return captured


async def test_compact_refusal_dismisses_stranded_spinner(tmp_path: Path) -> None:
    """
    A ``/compact`` refusal posts ``failed`` and drops the refused token.

    Claude fired ``PreCompact`` (raising the spinner) but declined to
    compact, so no completion signal follows. The forwarder must dismiss
    the "Compacting…" spinner with ``external_compaction_status: failed``
    and clear the dangling ``PreCompact`` token for that seq.
    """
    bridge_dir = tmp_path / "bridge"
    bridge_dir.mkdir()
    await forwarder._note_precompact(
        bridge_dir, claude_session_id="claude-1", transcript_path="/t/session.jsonl"
    )
    seq = forwarder._read_compaction_state(bridge_dir).pending.seq

    captured = await _run_dismiss_stranded_spinner(bridge_dir=bridge_dir, seq=seq)

    assert captured == [
        _CapturedRequest(
            method="POST",
            path="/v1/sessions/conv_x/events",
            body={"type": "external_compaction_status", "data": {"status": "failed"}},
        )
    ], f"expected one failed compaction-status POST, got {captured!r}"
    # Dangling token cleared so a later genuine compaction reconciles cleanly.
    assert forwarder._read_compaction_state(bridge_dir).pending is None


async def test_compact_refusal_without_pending_token_no_ops(tmp_path: Path) -> None:
    """
    A refusal whose ``PreCompact`` was missed posts nothing.

    No pending token means the ``PreCompact`` was never observed, so no
    spinner is up and a ``failed`` post would be spurious.
    """
    bridge_dir = tmp_path / "bridge"
    bridge_dir.mkdir()

    captured = await _run_dismiss_stranded_spinner(bridge_dir=bridge_dir, seq=1)

    assert captured == [], f"expected no POST without a pending token, got {captured!r}"


async def test_compact_refusal_does_not_dismiss_a_different_compaction(tmp_path: Path) -> None:
    """
    A stale refusal seq never dismisses a later genuine compaction's token.

    Regression for the flag-leak hazard: a refusal armed for seq N must not
    fire against a fresh seq N+1 minted by a subsequent real ``/compact`` —
    doing so would clear that live spinner and discard its boundary token.
    """
    bridge_dir = tmp_path / "bridge"
    bridge_dir.mkdir()
    # A genuine, later compaction is pending (seq 1); the refusal we're
    # flushing was armed for a missed earlier compaction (seq 0).
    await forwarder._note_precompact(
        bridge_dir, claude_session_id="claude-1", transcript_path="/t/session.jsonl"
    )
    live_seq = forwarder._read_compaction_state(bridge_dir).pending.seq

    captured = await _run_dismiss_stranded_spinner(bridge_dir=bridge_dir, seq=live_seq - 1)

    assert captured == [], f"a stale refusal seq must post nothing, got {captured!r}"
    # The genuine compaction's token is untouched.
    assert forwarder._read_compaction_state(bridge_dir).pending.seq == live_seq


async def test_compact_refusal_swallows_post_failure(tmp_path: Path) -> None:
    """A failed dismissal POST is best-effort — attempted, logged, never raised."""
    bridge_dir = tmp_path / "bridge"
    bridge_dir.mkdir()
    await forwarder._note_precompact(
        bridge_dir, claude_session_id="claude-1", transcript_path="/t/session.jsonl"
    )
    seq = forwarder._read_compaction_state(bridge_dir).pending.seq

    captured = await _run_dismiss_stranded_spinner(bridge_dir=bridge_dir, seq=seq, status=503)

    # Attempted once, the 503 swallowed. The token is still cleared (the
    # spinner-owning PreCompact will never complete regardless).
    assert len(captured) == 1
    assert captured[0].method == "POST"
    assert forwarder._read_compaction_state(bridge_dir).pending is None


@pytest.mark.asyncio
async def test_auto_precompact_posts_no_status_but_mints_token_and_persists_once(
    tmp_path: Path,
) -> None:
    """
    An ``auto`` ``PreCompact`` shows no strip, yet the boundary still lands once.

    Claude fires ``PreCompact`` with ``trigger=auto`` when it starts
    precomputing a summary in the background (about 85% of the auto-compact
    window) and applies it only when context reaches the window, possibly
    never. Treating that as ``in_progress`` pinned the web strip near 97%. The
    forwarder must post nothing for it, still mint the pending token, and let
    the later ``SessionStart source=compact`` post ``completed`` and persist
    exactly one boundary.
    """
    bridge_dir = tmp_path / "bridge"
    transcript_path = tmp_path / "session.jsonl"
    transcript_path.write_text("", encoding="utf-8")
    record_hook_event(
        bridge_dir,
        {
            "hook_event_name": "SessionStart",
            "session_id": "claude-session",
            "transcript_path": str(transcript_path),
        },
    )
    record_hook_event(
        bridge_dir,
        {"hook_event_name": "PreCompact", "trigger": "auto", "session_id": "claude-session"},
    )
    server, thread, base_url = _start_recording_server()
    persist_mock = AsyncMock(return_value=None)
    with patch(
        "omnigent.harnesses.claude_native.forwarder._persist_native_compaction_item",
        persist_mock,
    ):
        task = asyncio.create_task(
            forwarder.forward_claude_transcript_to_session(
                base_url=base_url,
                headers={},
                session_id="conv_auto",
                bridge_dir=bridge_dir,
                agent_name="claude-native-ui",
                start_at_end=False,
                poll_interval_s=0.01,
            )
        )
        try:
            # Let the forwarder consume the auto PreCompact over several polls.
            for _ in range(30):
                await asyncio.sleep(0.02)
                state = forwarder._read_compaction_state(bridge_dir)
                if state.pending is not None:
                    break
            state = forwarder._read_compaction_state(bridge_dir)
            # Settle: a late status post (a regression) would land within a few polls.
            await asyncio.sleep(0.2)
            # The token is minted even though no status was posted.
            assert state.pending is not None
            assert state.pending.trigger == "auto"
            assert state.last_seq == 1
            assert not any(
                r["body"].get("type") == "external_compaction_status"
                for r in list(server.requests.queue)
            ), "an auto PreCompact must not post any compaction status"
            persist_mock.assert_not_called()

            # The summary is applied: SessionStart source=compact completes it.
            record_hook_event(
                bridge_dir,
                {
                    "hook_event_name": "SessionStart",
                    "source": "compact",
                    "session_id": "claude-session",
                },
            )
            request = await _get_recorded_request(server)
            await asyncio.sleep(0.2)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            server.shutdown()
            server.server_close()
            thread.join(timeout=5.0)

    assert request["body"] == {
        "type": "external_compaction_status",
        "data": {"status": "completed"},
    }
    persist_mock.assert_called_once()
    assert forwarder._read_compaction_state(bridge_dir).last_seq == 1


@pytest.mark.asyncio
async def test_manual_precompact_still_posts_in_progress_and_mints_token(
    tmp_path: Path,
) -> None:
    """
    A ``manual`` ``PreCompact`` keeps the strip: ``/compact`` runs synchronously.
    """
    bridge_dir = tmp_path / "bridge"
    transcript_path = tmp_path / "session.jsonl"
    transcript_path.write_text("", encoding="utf-8")
    record_hook_event(
        bridge_dir,
        {
            "hook_event_name": "SessionStart",
            "session_id": "claude-session",
            "transcript_path": str(transcript_path),
        },
    )
    record_hook_event(
        bridge_dir,
        {"hook_event_name": "PreCompact", "trigger": "manual", "session_id": "claude-session"},
    )
    server, thread, base_url = _start_recording_server()
    task = asyncio.create_task(
        forwarder.forward_claude_transcript_to_session(
            base_url=base_url,
            headers={},
            session_id="conv_manual",
            bridge_dir=bridge_dir,
            agent_name="claude-native-ui",
            start_at_end=False,
            poll_interval_s=0.01,
        )
    )
    try:
        request = await _get_recorded_request(server)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)

    assert request["body"] == {
        "type": "external_compaction_status",
        "data": {"status": "in_progress"},
    }
    assert forwarder._read_compaction_state(bridge_dir).pending is not None


async def _run_forwarder_until_settled(
    bridge_dir: Path, session_id: str, persist_mock: AsyncMock
) -> list[dict[str, object]]:
    """
    Run the forwarder over the hooks already written, then return posted statuses.

    :param bridge_dir: Bridge directory holding the hook records.
    :param session_id: Omnigent session id to forward into.
    :param persist_mock: Mock standing in for ``_persist_native_compaction_item``.
    :returns: The ``data["status"]`` values of every posted compaction status, in order.
    """
    server, thread, base_url = _start_recording_server()
    with patch(
        "omnigent.harnesses.claude_native.forwarder._persist_native_compaction_item",
        persist_mock,
    ):
        task = asyncio.create_task(
            forwarder.forward_claude_transcript_to_session(
                base_url=base_url,
                headers={},
                session_id=session_id,
                bridge_dir=bridge_dir,
                agent_name="claude-native-ui",
                start_at_end=False,
                poll_interval_s=0.01,
            )
        )
        try:
            await asyncio.sleep(0.5)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            server.shutdown()
            server.server_close()
            thread.join(timeout=5.0)
    return [
        r["body"]["data"]["status"]
        for r in list(server.requests.queue)
        if r["body"].get("type") == "external_compaction_status"
    ]


def _write_session_start(bridge_dir: Path, transcript_path: Path) -> None:
    """
    Record a plain ``SessionStart`` so the forwarder learns the transcript path.

    :param bridge_dir: Bridge directory.
    :param transcript_path: Empty transcript file path.
    :returns: None.
    """
    transcript_path.write_text("", encoding="utf-8")
    record_hook_event(
        bridge_dir,
        {
            "hook_event_name": "SessionStart",
            "session_id": "claude-session",
            "transcript_path": str(transcript_path),
        },
    )


@pytest.mark.asyncio
async def test_synchronous_auto_compaction_in_one_poll_persists_once(tmp_path: Path) -> None:
    """
    ``PreCompact`` auto plus ``SessionStart source=compact`` in one poll persists once.

    When Claude compacts synchronously at the window, both hooks can land in
    the same poll. The auto ``PreCompact`` posts no ``in_progress``, the
    ``SessionStart`` posts ``completed``, and exactly one boundary persists.
    """
    bridge_dir = tmp_path / "bridge"
    _write_session_start(bridge_dir, tmp_path / "session.jsonl")
    record_hook_event(
        bridge_dir,
        {"hook_event_name": "PreCompact", "trigger": "auto", "session_id": "claude-session"},
    )
    record_hook_event(
        bridge_dir,
        {"hook_event_name": "SessionStart", "source": "compact", "session_id": "claude-session"},
    )
    persist_mock = AsyncMock(return_value=None)

    statuses = await _run_forwarder_until_settled(bridge_dir, "conv_sync_auto", persist_mock)

    assert statuses == ["completed"]
    persist_mock.assert_called_once()


@pytest.mark.asyncio
async def test_auto_token_then_manual_compact_yields_one_boundary(tmp_path: Path) -> None:
    """
    An unused auto token followed by a manual ``/compact`` is one compaction.

    The manual ``PreCompact`` supersedes the stale auto token, so the strip
    shows one ``in_progress`` and one ``completed`` and a single boundary
    persists.
    """
    bridge_dir = tmp_path / "bridge"
    _write_session_start(bridge_dir, tmp_path / "session.jsonl")
    record_hook_event(
        bridge_dir,
        {"hook_event_name": "PreCompact", "trigger": "auto", "session_id": "claude-session"},
    )
    record_hook_event(
        bridge_dir,
        {"hook_event_name": "PreCompact", "trigger": "manual", "session_id": "claude-session"},
    )
    record_hook_event(
        bridge_dir,
        {"hook_event_name": "SessionStart", "source": "compact", "session_id": "claude-session"},
    )
    persist_mock = AsyncMock(return_value=None)

    statuses = await _run_forwarder_until_settled(bridge_dir, "conv_auto_manual", persist_mock)

    assert statuses == ["in_progress", "completed"]
    persist_mock.assert_called_once()


def test_pending_compaction_trigger_round_trips_through_state(tmp_path: Path) -> None:
    """
    The pending token keeps its trigger across the durable state file.

    The refusal path reads the token back from disk, so a lost trigger would
    re-arm the spurious dismissal for an auto token.
    """
    bridge_dir = tmp_path / "bridge"
    forwarder._write_compaction_state(
        bridge_dir,
        forwarder.CompactionForwardState(
            pending=forwarder._PendingCompaction(seq=1, trigger="auto"),
            last_seq=1,
        ),
    )

    assert forwarder._read_compaction_state(bridge_dir).pending == forwarder._PendingCompaction(
        seq=1, trigger="auto"
    )
