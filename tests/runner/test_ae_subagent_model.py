"""Reporting each Claude Code subagent's model to its mirrored child session."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx
import pytest

from omnigent.harnesses.claude_native import ae_subagent_model
from omnigent.harnesses.claude_native.ae_subagent_model import report_subagent_model
from omnigent.harnesses.claude_native.bridge import record_hook_event
from omnigent.harnesses.claude_native.forwarder import forward_claude_transcript_to_session
from tests.test_claude_native_forwarder import (
    _allow_tmp_path_as_bridge_dir,  # noqa: F401 (autouse fixture)
    _get_recorded_request,
    _seed_subagent_on_disk,
    _start_recording_server_with_responses,
)


@pytest.fixture(autouse=True)
def _fresh_state() -> None:
    ae_subagent_model._reported.clear()
    ae_subagent_model._pending.clear()


class _Recorder:
    def __init__(self, fail: bool = False) -> None:
        self.calls: list[dict[str, Any]] = []
        self.fail = fail

    async def __call__(self, client: Any, *, session_id: str, model: str) -> None:
        self.calls.append({"session_id": session_id, "model": model})
        if self.fail:
            raise httpx.ConnectError("server unreachable")


@pytest.mark.asyncio
async def test_posts_each_model_once_per_child() -> None:
    post = _Recorder()
    for model in ("claude-sonnet-5-5", "claude-sonnet-5-5", None, "claude-opus-5-5"):
        await report_subagent_model(None, post, child_session_id="conv_a", latest_model=model)
    await report_subagent_model(
        None, post, child_session_id="conv_b", latest_model="claude-sonnet-5-5"
    )
    assert post.calls == [
        {"session_id": "conv_a", "model": "claude-sonnet-5-5"},
        {"session_id": "conv_a", "model": "claude-opus-5-5"},
        {"session_id": "conv_b", "model": "claude-sonnet-5-5"},
    ]


@pytest.mark.asyncio
async def test_a_failed_post_is_retried_on_the_next_read() -> None:
    failing = _Recorder(fail=True)
    await report_subagent_model(
        None, failing, child_session_id="conv_a", latest_model="claude-sonnet-5-5"
    )
    working = _Recorder()
    await report_subagent_model(
        None, working, child_session_id="conv_a", latest_model="claude-sonnet-5-5"
    )
    assert len(failing.calls) == 1
    assert working.calls == [{"session_id": "conv_a", "model": "claude-sonnet-5-5"}]


@pytest.mark.asyncio
async def test_retries_a_failed_model_after_the_cursor_moves_past_it() -> None:
    failing = _Recorder(fail=True)
    await report_subagent_model(
        None, failing, child_session_id="conv_a", latest_model="claude-sonnet-5-5"
    )
    # The next read starts past the entry that named the model.
    working = _Recorder()
    await report_subagent_model(None, working, child_session_id="conv_a", latest_model=None)
    await report_subagent_model(None, working, child_session_id="conv_a", latest_model=None)
    assert working.calls == [{"session_id": "conv_a", "model": "claude-sonnet-5-5"}]


@pytest.mark.asyncio
async def test_gives_up_after_repeated_failures() -> None:
    failing = _Recorder(fail=True)
    await report_subagent_model(
        None, failing, child_session_id="conv_gone", latest_model="claude-sonnet-5-5"
    )
    for _ in range(ae_subagent_model.MAX_ATTEMPTS + 3):
        await report_subagent_model(None, failing, child_session_id="conv_gone", latest_model=None)
    assert len(failing.calls) == ae_subagent_model.MAX_ATTEMPTS


@pytest.mark.asyncio
async def test_skips_placeholder_models() -> None:
    post = _Recorder()
    await report_subagent_model(None, post, child_session_id="conv_a", latest_model="<synthetic>")
    assert post.calls == []


@pytest.mark.asyncio
async def test_forwarder_reports_a_subagent_model_to_its_child(tmp_path: Path) -> None:
    bridge_dir = tmp_path / "bridge"
    transcript_path = tmp_path / "session.jsonl"
    transcript_path.write_text("", encoding="utf-8")
    _seed_subagent_on_disk(
        transcript_path=transcript_path,
        subagent_id="c7e9aaa",
        agent_type="Explore",
        description="Find the model",
        tool_use_id="toolu_model",
        transcript_records=[
            {
                "isSidechain": True,
                "type": "assistant",
                "uuid": "sa-assistant-1",
                "message": {
                    "role": "assistant",
                    "model": "claude-sonnet-5-5",
                    "content": [{"type": "text", "text": "looking now"}],
                },
            },
        ],
    )
    record_hook_event(
        bridge_dir,
        {
            "hook_event_name": "SessionStart",
            "session_id": "claude-session",
            "transcript_path": str(transcript_path),
        },
    )

    def response_for(body: object) -> object:
        if isinstance(body, list):
            return [{"queued": False, "item_id": f"item-{i}"} for i, _event in enumerate(body)]
        if isinstance(body, dict) and body.get("type") == "external_subagent_start":
            return {"queued": False, "child_session_id": "conv_child_model"}
        return {}

    server, _thread, base_url = _start_recording_server_with_responses(response_for)
    task = asyncio.create_task(
        forward_claude_transcript_to_session(
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
        reported: dict[str, Any] | None = None
        for _ in range(40):
            req = await _get_recorded_request(server)
            body = req["body"]
            if (
                req["path"] == "/v1/sessions/conv_child_model/events"
                and isinstance(body, dict)
                and body.get("type") == "external_model_change"
            ):
                reported = body
                break
        assert reported == {
            "type": "external_model_change",
            "data": {"model": "claude-sonnet-5-5"},
        }
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        server.shutdown()
        server.server_close()
