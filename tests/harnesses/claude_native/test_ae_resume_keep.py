"""A cold relaunch keeps a Claude transcript only when the server frontier matches."""

from __future__ import annotations

import copy
import json
import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import httpx
import pytest

from omnigent.harnesses.claude_native import ae_resume_keep as keep
from omnigent.harnesses.claude_native import forwarder
from omnigent.harnesses.claude_native import main as claude_native
from omnigent.runner.native import orchestration
from omnigent.runner.transports.ws_tunnel.event_delivery import (
    RunnerEventDispatcher,
    TunnelEventClient,
)
from omnigent.runner.transports.ws_tunnel.frames import (
    EventAckFrame,
    EventBatchFrame,
    decode_frame,
)
from omnigent.runtime import pending_inputs
from omnigent.server.routes._sessions import orchestration as server_orchestration
from omnigent.server.schemas import SessionEventInput
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore

SID = "sid123"
CONV = "conv_abc"
B64 = "iVBORw0KGgo" + "D" * 5000 + "="
IMAGE = {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": B64}}


def _user_row(uuid: str, text: str, cwd: str) -> dict[str, Any]:
    return {
        "type": "user",
        "uuid": uuid,
        "cwd": cwd,
        "message": {"role": "user", "content": text},
    }


def _assistant_row(uuid: str, text: str, cwd: str) -> dict[str, Any]:
    return {
        "type": "assistant",
        "uuid": uuid,
        "cwd": cwd,
        "message": {
            "role": "assistant",
            "model": "claude-opus-4-8",
            "content": [{"type": "text", "text": text}],
        },
    }


@dataclass
class FakeServer:
    """The conversation store: items with ids, served and appended like the real routes."""

    items: list[dict[str, Any]] = field(default_factory=list)
    patches: list[dict[str, Any]] = field(default_factory=list)
    source_ids: dict[str, str] = field(default_factory=dict)
    # Stamped on every forwarded item, as the real server copies it from the queued input.
    stamp_created_by: str | None = None
    # Give a posted item the id the real server derives from its source id.
    derived: bool = False
    # Whether the 202 names the item. The event tunnel's synthetic 202 never does.
    return_item_id: bool = True
    # Store the next post, then lose the response, as a timed-out POST does.
    lose_next_response: bool = False
    # Before the next post, a row of this shape already holds the id the post derives.
    collide_next_post: dict[str, Any] | None = None

    def add(self, item: dict[str, Any], item_id: str | None = None) -> str:
        item_id = item_id or f"item_{len(self.items)}"
        self.items.append({"id": item_id, **item})
        return item_id

    def post_item(self, data: dict[str, Any]) -> str:
        """Store one external item as the server does."""
        # The real server derives the id from the source id, so a re-post is a no-op.
        source_id = data.get("source_id")
        if self.collide_next_post is not None and isinstance(source_id, str):
            held_id = _server_item_id(CONV, source_id)
            self.add(self.collide_next_post, held_id)
            self.source_ids[source_id] = held_id
            self.collide_next_post = None
        if isinstance(source_id, str) and source_id in self.source_ids:
            return self.source_ids[source_id]
        stamp = {"created_by": self.stamp_created_by} if self.stamp_created_by else {}
        item_id = self.add(
            {"type": data["item_type"], **data["item_data"], **stamp},
            _server_item_id(CONV, source_id)
            if self.derived and isinstance(source_id, str)
            else None,
        )
        if isinstance(source_id, str):
            self.source_ids[source_id] = item_id
        return item_id

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "GET" and path.endswith("/items"):
            params = request.url.params
            order = params.get("order", "asc")
            rows = list(self.items) if order == "asc" else list(reversed(self.items))
            after = params.get("after")
            if after is not None:
                ids = [row["id"] for row in rows]
                rows = rows[ids.index(after) + 1 :] if after in ids else []
            limit = int(params.get("limit", "100"))
            return httpx.Response(200, json={"data": rows[:limit], "has_more": len(rows) > limit})
        if request.method == "PATCH":
            self.patches.append(json.loads(request.content))
            return httpx.Response(200, json={})
        body = json.loads(request.content)
        if body.get("type") == "external_conversation_item":
            item_id = self.post_item(body["data"])
            if self.lose_next_response:
                self.lose_next_response = False
                raise httpx.ReadTimeout("response lost", request=request)
            payload: dict[str, Any] = {"queued": False}
            if self.return_item_id:
                payload["item_id"] = item_id
            return httpx.Response(202, json=payload)
        return httpx.Response(202, json={})


def _server_item_id(session_id: str, source_id: str) -> str:
    """The server's formula for an external item's id, written out independently of the keep."""
    return uuid.uuid5(
        uuid.NAMESPACE_URL, f"omnigent-external-item:{session_id}:{source_id.strip()}"
    ).hex


@dataclass
class Env:
    root: Path
    server: FakeServer

    @property
    def workspace(self) -> Path:
        return self.root / "ws"

    @property
    def bridge(self) -> Path:
        return self.root / "bridge"

    @property
    def projects(self) -> Path:
        return self.root / "projects"

    def transcript(self, workspace: Path | None = None) -> Path:
        name = claude_native._sanitize_claude_project_name(str(workspace or self.workspace))
        return self.projects / name / f"{SID}.jsonl"

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.MockTransport(self.server.handle), base_url="http://test"
        )


def _write(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def _append(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


@pytest.fixture(autouse=True)
def _no_own_ids() -> Any:
    keep._own_ids.clear()
    keep._held_logged.clear()
    keep._warned_no_id.clear()
    yield
    keep._own_ids.clear()
    keep._held_logged.clear()
    keep._warned_no_id.clear()


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Env:
    environment = Env(tmp_path, FakeServer())
    monkeypatch.setattr(claude_native, "_CLAUDE_PROJECTS_DIR", environment.projects)
    monkeypatch.setattr(forwarder, "read_claude_context_state", lambda _: {})
    environment.bridge.mkdir()
    return environment


def _seed(env: Env, *, workspace: Path | None = None) -> Path:
    """
    What a launch leaves behind: a transcript, the forwarder cursor at its end and the
    frontier record for it, with one server item standing for the history.
    """
    workspace = workspace or env.workspace
    path = env.transcript(workspace)
    _write(
        path,
        [_user_row("u0", "hello", str(workspace)), _assistant_row("a0", "hi", str(workspace))],
    )
    env.server.add(
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello"}]}
    )
    offset = path.stat().st_size
    fingerprint = forwarder._jsonl_cursor_fingerprint(path, offset)
    assert fingerprint is not None
    forwarder._write_forward_state(
        env.bridge,
        forwarder.TranscriptForwardState(
            transcript_path=path,
            line_cursor=2,
            byte_offset=offset,
            cursor_fingerprint=fingerprint,
        ),
    )
    keep.write_frontier(
        env.bridge, keep.Frontier(path, offset, fingerprint, len(env.server.items), "item_0")
    )
    return path


async def _forward(env: Env, client: httpx.AsyncClient | None = None) -> None:
    """Run the real forwarder over whatever Claude has written since its cursor."""
    state = forwarder._read_forward_state(env.bridge)
    assert state is not None
    async with client or env.client() as active:
        await forwarder._forward_available_items(
            client=active,
            session_id=CONV,
            bridge_dir=env.bridge,
            agent_name="claude-native-ui",
            state=state,
            retry_tracker=forwarder._PostRetryTracker(),
            dedupe=forwarder._ForwardDedupeState(),
        )


def _tunnel_client(
    env: Env, *, error: str | None = None, retryable: bool = False
) -> TunnelEventClient:
    """
    The runner's real client over a stubbed tunnel: it acks every event as applied (the server
    stores it, naming no id), or, with *error*, rejects the batch and stores nothing.
    """
    dispatcher = RunnerEventDispatcher()

    async def send(text: str) -> None:
        frame = decode_frame(text)
        assert isinstance(frame, EventBatchFrame)
        if error is not None:
            dispatcher.acknowledge(EventAckFrame(frame.id, 0, error, retryable))
            return
        for event in frame.events:
            if event["type"] == "external_conversation_item":
                env.server.post_item(event["data"])
        dispatcher.acknowledge(EventAckFrame(frame.id, len(frame.events)))

    dispatcher.ready(send)
    return TunnelEventClient(
        event_dispatcher=dispatcher,
        transport=httpx.MockTransport(env.server.handle),
        base_url="http://test",
    )


def _restart_forwarder_at(env: Env, path: Path, offset: int) -> None:
    """What the relaunched forwarder starts from: a fresh cursor at *offset*."""
    forwarder.reset_transcript_forward_state(env.bridge)
    forwarder._write_forward_state(
        env.bridge,
        forwarder.TranscriptForwardState(
            transcript_path=path,
            line_cursor=0,
            byte_offset=offset,
            cursor_fingerprint=forwarder._jsonl_cursor_fingerprint(path, offset),
        ),
    )


async def _relaunch(
    env: Env, *, workspace: Path | None = None, stopped: bool = True
) -> tuple[Path | None, keep.ResumeContext]:
    """A cold relaunch up to the transcript: read the old forwarder's state, then resume."""
    ctx = keep.read_context(env.bridge, forwarder_stopped=stopped)
    async with env.client() as client:
        written = await claude_native._ensure_local_claude_resume_transcript(
            client,
            session_id=CONV,
            external_session_id=SID,
            workspace=workspace or env.workspace,
            bridge_dir=env.bridge,
            ae_resume=ctx,
        )
    return written, ctx


async def _settle(env: Env, written: Path | None, ctx: keep.ResumeContext) -> int | None:
    """What the runner does with its transcript: label, write the record, pick the offset."""
    assert written is not None
    async with env.client() as client:
        return await keep.settle_resume(client, CONV, ctx, written, written.stat().st_size, None)


def _mode(ctx: keep.ResumeContext) -> str | None:
    return ctx.outcome.mode if ctx.outcome is not None else None


def _posted_texts(server: FakeServer) -> list[str]:
    texts: list[str] = []
    for item in server.items[1:]:
        content = item.get("content")
        if isinstance(content, list):
            texts.extend(block.get("text", "") for block in content if isinstance(block, dict))
    return texts


@pytest.mark.asyncio
async def test_kept_when_the_frontier_matches_and_the_tail_is_forwarded_once(env: Env) -> None:
    path = _seed(env)
    _append(path, [_user_row("u1", "list files", str(env.workspace))])
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])
    await _forward(env)
    assert len(env.server.items) == 3
    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert (frontier.item_count, frontier.last_item_id) == (3, "item_2")
    # Claude writes more rows the forwarder has not read yet; the server lacks them.
    _append(path, [_assistant_row("a2", "tail one", str(env.workspace))])
    _append(path, [_assistant_row("a3", "tail two", str(env.workspace))])
    before = path.read_bytes()

    written, ctx = await _relaunch(env)

    assert written == path
    assert path.read_bytes() == before
    assert ctx.outcome == keep.ResumeOutcome(keep.KEPT, frontier.byte_offset)
    assert len(env.server.items) == 3
    # The record was deleted when the context was read and comes back with the settle.
    assert keep.read_frontier(env.bridge) is None
    assert await _settle(env, written, ctx) == frontier.byte_offset
    assert keep.read_frontier(env.bridge) == frontier
    # The relaunch resumes the forwarder at the cursor offset: each tail row posts once.
    _restart_forwarder_at(env, path, frontier.byte_offset)
    await _forward(env)
    await _forward(env)
    assert len(env.server.items) == 5
    advanced = keep.read_frontier(env.bridge)
    assert advanced is not None
    assert (advanced.item_count, advanced.last_item_id) == (5, "item_4")
    assert _posted_texts(env.server).count("tail one") == 1
    assert _posted_texts(env.server).count("tail two") == 1


@pytest.mark.asyncio
async def test_rebuilt_when_the_server_gained_an_item_after_the_cursor(env: Env) -> None:
    path = _seed(env)
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])
    await _forward(env)
    # A message typed in the web UI reaches the server, not yet Claude's file.
    env.server.add(
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "yes"}]}
    )
    count = len(env.server.items)

    written, ctx = await _relaunch(env)

    assert written == path
    assert _mode(ctx) == keep.REBUILT
    assert "yes" in path.read_text(encoding="utf-8")
    # The rebuilt file already holds every server item, so nothing is forwarded twice.
    _restart_forwarder_at(env, path, path.stat().st_size)
    await _forward(env)
    assert len(env.server.items) == count


@pytest.mark.asyncio
async def test_rebuilt_when_a_retried_turn_has_the_same_count_but_another_last_id(
    env: Env,
) -> None:
    path = _seed(env)
    _append(path, [_assistant_row("a1", "first try", str(env.workspace))])
    await _forward(env)
    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    # The turn was retried: same number of items, a different last one.
    env.server.items[-1] = {**env.server.items[-1], "id": "item_retry"}
    assert len(env.server.items) == frontier.item_count

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.REBUILT


@pytest.mark.asyncio
async def test_rebuilt_when_the_bytes_before_the_cursor_changed(env: Env) -> None:
    path = _seed(env)
    _append(path, [_assistant_row("a1", "newer", str(env.workspace))])
    await _forward(env)
    # A no-tool chat whose file was replaced by one of the same length: every line is still
    # complete JSON and the cursor still sits on a line break, but the bytes before it are
    # not the ones its fingerprint was taken over.
    original = path.read_bytes()
    replaced = original.replace(b"newer", b"newex")
    assert replaced != original
    assert len(replaced) == len(original)
    path.write_bytes(replaced)

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.REBUILT


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tail",
    [
        pytest.param('{"type":"assistant","uuid":"p', id="partial-line"),
        pytest.param(
            json.dumps(_assistant_row("a2", "no newline", "/x")), id="no-trailing-newline"
        ),
    ],
)
async def test_rebuilt_when_the_last_line_is_incomplete(env: Env, tail: str) -> None:
    path = _seed(env)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(tail)

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.REBUILT


def _image_records() -> dict[str, dict[str, Any]]:
    def record(content: object, tool_use_result: object) -> dict[str, Any]:
        return {
            "type": "user",
            "uuid": "r1",
            "cwd": "/x",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": content}],
            },
            "toolUseResult": tool_use_result,
        }

    truncated = '[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"'
    truncated += "iVBORw0KGgo" + "D" * 5000
    return {
        "dict": record([IMAGE], {"type": "image", "source": {"data": B64}}),
        "list": record([IMAGE], json.dumps([IMAGE])),
        "truncated": record(truncated, truncated),
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("form", ["dict", "list", "truncated"])
async def test_rebuilt_when_the_sanitizer_would_change_the_file(env: Env, form: str) -> None:
    record = _image_records()[form]
    probe = copy.deepcopy(record)
    claude_native._sanitize_cloned_tool_result_record(probe)
    assert probe != record, "the fixture must be something the sanitizer repairs"
    path = _seed(env)
    # The bad row sits BEFORE the cursor too: the whole file must be clean to keep.
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    _write(path, [rows[0], record, rows[1]])
    offset = path.stat().st_size
    _restart_forwarder_at(env, path, offset)
    fingerprint = forwarder._jsonl_cursor_fingerprint(path, offset)
    assert fingerprint is not None
    keep.write_frontier(env.bridge, keep.Frontier(path, offset, fingerprint, 1, "item_0"))

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.REBUILT


@pytest.mark.asyncio
async def test_a_file_the_sanitizer_leaves_alone_is_kept(env: Env) -> None:
    path = _seed(env)
    _append(
        path,
        [
            {
                "type": "user",
                "uuid": "r2",
                "cwd": str(env.workspace),
                "message": {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "toolu_2", "content": "ok"}
                    ],
                },
                "toolUseResult": "ok",
            }
        ],
    )

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.KEPT


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["cursor", "frontier"])
async def test_rebuilt_without_a_cursor_or_a_recorded_frontier(env: Env, missing: str) -> None:
    path = _seed(env)
    if missing == "cursor":
        forwarder.reset_transcript_forward_state(env.bridge)
    else:
        (env.bridge / keep.FRONTIER_FILE).unlink()
    before = path.read_bytes()

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.REBUILT
    assert path.read_bytes() != before


@pytest.mark.asyncio
async def test_rebuilt_when_the_old_forwarder_may_still_be_running(env: Env) -> None:
    _seed(env)

    _written, ctx = await _relaunch(env, stopped=False)

    assert ctx.cursor is None
    assert _mode(ctx) == keep.REBUILT


@pytest.mark.asyncio
async def test_an_exception_in_the_keep_path_falls_back_to_a_rebuild(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _seed(env)

    def boom(*_args: object, **_kwargs: object) -> bool:
        raise RuntimeError("disk trouble")

    monkeypatch.setattr(keep, "_tail_complete", boom)
    before = path.read_bytes()

    written, ctx = await _relaunch(env)

    assert written == path
    assert _mode(ctx) == keep.REBUILT
    assert path.read_bytes() != before


@pytest.mark.asyncio
async def test_copied_from_an_old_workspace_dir_when_the_frontier_matches(env: Env) -> None:
    old_ws = env.root / "old-ws"
    old_path = _seed(env, workspace=old_ws)
    _append(old_path, [_assistant_row("a1", "done", str(old_ws))])
    await _forward(env)
    cursor = keep.read_forward_cursor(env.bridge)
    assert cursor is not None
    _append(old_path, [_assistant_row("a2", "tail", str(old_ws))])
    new_target = env.transcript()
    assert not new_target.exists()

    written, ctx = await _relaunch(env)

    assert written == new_target
    assert old_path.is_file()
    rows = [json.loads(line) for line in new_target.read_text(encoding="utf-8").splitlines()]
    assert {row["cwd"] for row in rows} == {str(env.workspace)}
    assert ctx.outcome is not None
    assert ctx.outcome.mode == keep.COPIED
    # The offset is mapped by line count: everything before the tail row.
    assert ctx.outcome.forward_offset is not None
    head = new_target.read_bytes()[: ctx.outcome.forward_offset]
    assert head.count(b"\n") == old_path.read_bytes()[: cursor.byte_offset].count(b"\n")
    assert rows[-1]["uuid"] == "a2"
    assert new_target.read_bytes()[ctx.outcome.forward_offset :].count(b"\n") == 1
    # The frontier record describes the copy once the launch settles, so the next relaunch
    # can keep it.
    assert keep.read_frontier(env.bridge) is None
    await _settle(env, written, ctx)
    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert frontier.transcript_path == new_target
    assert frontier.byte_offset == ctx.outcome.forward_offset
    assert len(env.server.items) == 2
    _restart_forwarder_at(env, new_target, ctx.outcome.forward_offset)
    await _forward(env)
    assert len(env.server.items) == 3


@pytest.mark.asyncio
async def test_not_copied_when_the_old_workspace_file_is_behind_the_server(env: Env) -> None:
    old_ws = env.root / "old-ws"
    _seed(env, workspace=old_ws)
    env.server.add(
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "more"}]}
    )

    written, ctx = await _relaunch(env)

    assert written == env.transcript()
    assert _mode(ctx) == keep.REBUILT


@pytest.mark.asyncio
async def test_a_foreign_item_leaves_the_frontier_behind(env: Env) -> None:
    path = _seed(env)
    env.server.add(
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "other"}]}
    )
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])
    await _forward(env)

    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert frontier.item_count == 1

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.REBUILT


@pytest.mark.asyncio
async def test_the_final_cursor_of_a_forwarder_that_advances_while_cancelled_is_used(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _seed(env)
    _append(path, [_assistant_row("a1", "before cancel", str(env.workspace))])
    stale = keep.read_forward_cursor(env.bridge)
    assert stale is not None

    class Cancelling:
        """A forwarder task that finishes one more poll while it is being cancelled."""

        def __init__(self) -> None:
            self.cancelled = False

        def done(self) -> bool:
            return self.cancelled

        def cancel(self) -> bool:
            self.cancelled = True
            return True

        def __await__(self) -> Any:
            return _forward(env).__await__()

    async def wait(tasks: set[Any], timeout: float) -> tuple[set[Any], set[Any]]:
        for pending in tasks:
            await pending
        return set(tasks), set()

    monkeypatch.setattr(orchestration.asyncio, "wait", wait)
    monkeypatch.setitem(orchestration._AUTO_FORWARDER_TASKS, CONV, Cancelling())

    stopped = await orchestration._cancel_auto_forwarder_task(CONV)
    ctx = keep.read_context(env.bridge, forwarder_stopped=stopped)

    assert stopped is True
    assert ctx.cursor is not None
    assert ctx.cursor.byte_offset > stale.byte_offset
    assert ctx.frontier is not None
    assert ctx.frontier.byte_offset == ctx.cursor.byte_offset
    assert ctx.frontier.item_count == len(env.server.items) == 2
    async with env.client() as client:
        written = await claude_native._ensure_local_claude_resume_transcript(
            client,
            session_id=CONV,
            external_session_id=SID,
            workspace=env.workspace,
            bridge_dir=env.bridge,
            ae_resume=ctx,
        )
    assert written == path
    assert _mode(ctx) == keep.KEPT


@pytest.mark.asyncio
async def test_a_cancel_that_times_out_reports_a_running_forwarder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Stuck:
        def done(self) -> bool:
            return False

        def cancel(self) -> bool:
            return True

    async def wait(tasks: set[Any], timeout: float) -> tuple[set[Any], set[Any]]:
        return set(), set(tasks)

    monkeypatch.setattr(orchestration.asyncio, "wait", wait)
    monkeypatch.setitem(orchestration._AUTO_FORWARDER_TASKS, CONV, Stuck())
    keep.note_posted(CONV, "item_1")

    assert await orchestration._cancel_auto_forwarder_task(CONV) is False
    assert CONV not in keep._own_ids


@pytest.mark.asyncio
async def test_no_context_always_rebuilds(env: Env) -> None:
    path = _seed(env)
    before = path.read_bytes()
    async with env.client() as client:
        written = await claude_native._ensure_local_claude_resume_transcript(
            client,
            session_id=CONV,
            external_session_id=SID,
            workspace=env.workspace,
            bridge_dir=env.bridge,
        )

    assert written == path
    assert path.read_bytes() != before


@pytest.mark.asyncio
async def test_settle_labels_the_session_seeds_a_rebuilt_frontier_and_survives_a_failed_write(
    env: Env,
) -> None:
    _seed(env)
    (env.bridge / keep.FRONTIER_FILE).unlink()
    written, ctx = await _relaunch(env)
    assert written is not None
    assert _mode(ctx) == keep.REBUILT
    size = written.stat().st_size

    async with env.client() as client:
        offset = await keep.settle_resume(
            client, CONV, ctx, written, size, {keep.RESUME_COUNT_LABEL: "2"}
        )

    assert offset == size
    assert env.server.patches == [
        {"labels": {keep.RESUME_LABEL: keep.REBUILT, keep.RESUME_COUNT_LABEL: "3"}}
    ]
    seeded = keep.read_frontier(env.bridge)
    assert seeded is not None
    assert (seeded.byte_offset, seeded.item_count, seeded.last_item_id) == (size, 1, "item_0")
    # The next relaunch keeps what this one rebuilt.
    _restart_forwarder_at(env, written, size)
    _again, second = await _relaunch(env)
    assert _mode(second) == keep.KEPT

    def refuse(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={})

    transport = httpx.MockTransport(refuse)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as failing:
        assert await keep.settle_resume(failing, CONV, second, written, size, None) == size


@pytest.mark.asyncio
async def test_no_outcome_is_left_behind_when_history_is_unavailable(env: Env) -> None:
    path = _seed(env)

    def down(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={})

    ctx = keep.read_context(env.bridge)
    transport = httpx.MockTransport(down)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        written = await claude_native._ensure_local_claude_resume_transcript(
            client,
            session_id=CONV,
            external_session_id=SID,
            workspace=env.workspace,
            bridge_dir=env.bridge,
            ae_resume=ctx,
        )

    assert written == path
    assert ctx.outcome is None
    assert keep.read_frontier(env.bridge) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("early", ["history-unavailable", "no-records"])
async def test_a_launch_that_never_settles_leaves_no_record_to_vouch_for_a_fresh_cursor(
    env: Env, early: str
) -> None:
    path = _seed(env)
    old_size = path.stat().st_size
    # Claude wrote rows after the old cursor that the server never received.
    _append(path, [_assistant_row("a1", "never posted", str(env.workspace))])
    if early == "no-records":
        env.server.items.clear()

    def down(request: httpx.Request) -> httpx.Response:
        if early == "history-unavailable":
            return httpx.Response(503, json={})
        return env.server.handle(request)

    ctx = keep.read_context(env.bridge)
    transport = httpx.MockTransport(down)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        written = await claude_native._ensure_local_claude_resume_transcript(
            client,
            session_id=CONV,
            external_session_id=SID,
            workspace=env.workspace,
            bridge_dir=env.bridge,
            ae_resume=ctx,
        )
    assert (written is None) == (early == "no-records")
    assert keep.read_frontier(env.bridge) is None

    # The forwarder seeds a fresh cursor at the end of the file, skipping the unposted row,
    # then posts the next batch: with no record to advance, none is created.
    env.server.add(
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "x"}]}
    )
    _restart_forwarder_at(env, path, path.stat().st_size)
    _append(path, [_assistant_row("a2", "posted", str(env.workspace))])
    await _forward(env)
    assert path.stat().st_size > old_size
    assert keep.read_frontier(env.bridge) is None
    assert not (env.bridge / keep.FRONTIER_FILE).exists()

    _written, second = await _relaunch(env)

    assert _mode(second) == keep.REBUILT


@pytest.mark.asyncio
async def test_the_keep_checks_run_off_the_event_loop(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    import threading

    _seed(env)
    threads: list[int] = []
    real = keep._tail_complete

    def spy(path: Path, byte_offset: int) -> bool:
        threads.append(threading.get_ident())
        return real(path, byte_offset)

    monkeypatch.setattr(keep, "_tail_complete", spy)

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.KEPT
    assert threads
    assert threads[0] != threading.get_ident()


def test_lines_are_counted_in_chunks_across_a_large_prefix(tmp_path: Path) -> None:
    path = tmp_path / "big.jsonl"
    line = b'{"k":"' + b"x" * 998 + b'"}\n'
    path.write_bytes(line * 3000)
    assert keep._lines_before(path, len(line) * 2500 + 3) == 2500
    assert keep._lines_before(path, 10**9) == 3000
    assert keep._lines_before(path, 0) == 0


def test_own_post_ids_are_dropped_when_the_forwarder_ends() -> None:
    keep.note_posted(CONV, "item_1")
    keep.note_posted(CONV, None)
    assert keep._own_ids[CONV] == {"item_1": ""}
    keep.forget_session(CONV)
    assert CONV not in keep._own_ids


@pytest.mark.asyncio
async def test_no_record_is_written_when_the_transcript_size_could_not_be_measured(
    env: Env,
) -> None:
    path = _seed(env)
    written, ctx = await _relaunch(env)
    assert written == path
    assert _mode(ctx) == keep.KEPT

    async with env.client() as client:
        offset = await keep.settle_resume(client, CONV, ctx, path, None, None)

    assert offset is None
    assert keep.read_frontier(env.bridge) is None
    # The forwarder falls back to the live end of the file; the next launch must not trust it.
    _restart_forwarder_at(env, path, path.stat().st_size)
    _append(path, [_assistant_row("a1", "unposted", str(env.workspace))])
    await _forward(env)
    _written, second = await _relaunch(env)
    assert _mode(second) == keep.REBUILT


def _server_message(text: str, *, meta: bool = False) -> dict[str, Any]:
    item: dict[str, Any] = {
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": text}],
    }
    if meta:
        item["is_meta"] = True
    return item


# One server row per type the rebuild leaves out of the transcript.
_SKIPPED_ROWS: dict[str, dict[str, Any]] = {
    "reasoning": {"type": "reasoning", "summary": []},
    "error": {"type": "error", "message": "could not deliver"},
    "native_tool": {"type": "native_tool", "name": "x"},
    "resource_event": {"type": "resource_event", "event": "launched"},
    "routing_decision": {"type": "routing_decision"},
    "slash_command": {"type": "slash_command", "command": "/skill"},
    "terminal_command": {"type": "terminal_command", "command": "ls"},
}


@pytest.mark.asyncio
async def test_the_live_sequence_keeps_after_a_resource_event_and_a_mirrored_user_note(
    env: Env,
) -> None:
    path = _seed(env)
    # The relaunch adds its own resource_event right after the seed.
    env.server.add(_SKIPPED_ROWS["resource_event"])
    # A note typed in the TUI is written to the JSONL and mirrored with the queue's created_by.
    env.server.stamp_created_by = "user_1"
    _append(path, [_user_row("u1", "a note", str(env.workspace))])
    await _forward(env)
    _append(path, [_assistant_row("a1", "answer", str(env.workspace))])
    await _forward(env)

    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert (frontier.item_count, frontier.last_item_id) == (4, "item_3")
    assert len(env.server.items) == 4
    assert env.server.items[2]["created_by"] == "user_1"
    _append(path, [_assistant_row("a2", "tail", str(env.workspace))])

    written, ctx = await _relaunch(env)

    assert written == path
    assert _mode(ctx) == keep.KEPT
    assert len(env.server.items) == 4
    # The relaunched forwarder resumes at the cursor: the tail row posts once, nothing twice.
    await _settle(env, written, ctx)
    _restart_forwarder_at(env, path, frontier.byte_offset)
    await _forward(env)
    await _forward(env)
    assert len(env.server.items) == 5
    assert _posted_texts(env.server).count("a note") == 1
    assert _posted_texts(env.server).count("tail") == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("item_type", sorted(_SKIPPED_ROWS))
async def test_each_skipped_type_leaves_the_record_advancing_and_the_relaunch_kept(
    env: Env, item_type: str
) -> None:
    path = _seed(env)
    env.server.add(_SKIPPED_ROWS[item_type])
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])
    await _forward(env)

    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert (frontier.item_count, frontier.last_item_id) == (3, "item_2")

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.KEPT


@pytest.mark.asyncio
async def test_an_idle_session_that_only_gained_a_resource_event_is_kept(env: Env) -> None:
    _seed(env)
    env.server.add(_SKIPPED_ROWS["resource_event"])
    env.server.add(_SKIPPED_ROWS["resource_event"])

    written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.KEPT
    # The record moves up to the server's end, which the trailing items were checked against.
    await _settle(env, written, ctx)
    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert (frontier.item_count, frontier.last_item_id) == (3, "item_2")


@pytest.mark.asyncio
@pytest.mark.parametrize("order", ["error_first", "message_first", "message_only"])
async def test_a_server_written_user_message_after_a_resource_event_rebuilds(
    env: Env, order: str
) -> None:
    path = _seed(env)
    env.server.add(_SKIPPED_ROWS["resource_event"])
    error = _SKIPPED_ROWS["error"]
    undelivered = _server_message("never typed")
    for row in {
        "error_first": [error, undelivered],
        "message_first": [undelivered, error],
        "message_only": [undelivered],
    }[order]:
        env.server.add(row)

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.REBUILT
    assert "never typed" in path.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_a_server_written_message_in_the_delta_leaves_the_record_behind(env: Env) -> None:
    path = _seed(env)
    env.server.add(_SKIPPED_ROWS["resource_event"])
    env.server.add(_server_message("never typed"))
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])
    await _forward(env)

    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert frontier.item_count == 1

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.REBUILT


@pytest.mark.asyncio
async def test_a_skill_from_the_ui_the_forwarder_did_not_post_rebuilds(env: Env) -> None:
    path = _seed(env)
    # The UI route writes a slash_command item and an is_meta user message with the skill text.
    env.server.add(_SKIPPED_ROWS["slash_command"])
    env.server.add(_server_message("skill body", meta=True))

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.REBUILT
    assert "skill body" in path.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_a_compaction_the_forwarder_did_not_post_rebuilds(env: Env) -> None:
    path = _seed(env)
    env.server.add({"type": "compaction", "compacted_messages": [_server_message("summary")]})
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])
    await _forward(env)
    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert frontier.item_count == 1

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.REBUILT


_ODD_TYPES = [None, 12, "brand_new_type", ""]


def _odd_row(odd_type: object) -> dict[str, Any]:
    return {} if odd_type is None else {"type": odd_type}


@pytest.mark.asyncio
@pytest.mark.parametrize("odd_type", _ODD_TYPES)
async def test_a_missing_or_unknown_item_type_after_the_record_rebuilds(
    env: Env, odd_type: object
) -> None:
    _seed(env)
    env.server.add(_odd_row(odd_type))

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.REBUILT


@pytest.mark.asyncio
@pytest.mark.parametrize("odd_type", _ODD_TYPES)
async def test_a_missing_or_unknown_item_type_in_the_delta_leaves_the_record_behind(
    env: Env, odd_type: object
) -> None:
    path = _seed(env)
    env.server.add(_odd_row(odd_type))
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])
    await _forward(env)

    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert frontier.item_count == 1

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.REBUILT


@pytest.mark.asyncio
async def test_a_foreign_message_before_the_recorded_last_item_shifts_it_and_rebuilds(
    env: Env,
) -> None:
    _seed(env)
    # The item the record ends on is still there, but one place later than recorded.
    env.server.items.insert(0, {"id": "item_x", **_server_message("older")})
    assert env.server.items[-1]["id"] == "item_0"

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.REBUILT


@pytest.mark.asyncio
async def test_a_server_that_holds_fewer_items_than_the_record_rebuilds(
    env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    path = _seed(env)
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])
    await _forward(env)
    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    env.server.items.pop()
    assert len(env.server.items) < frontier.item_count

    with caplog.at_level("WARNING"):
        _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.REBUILT
    # The short server is refused by the check itself, not by an exception caught after it.
    assert not [r for r in caplog.records if "could not reuse" in r.getMessage()]


@pytest.mark.asyncio
async def test_a_skipped_row_posted_before_the_cursor_was_saved_is_kept_and_not_reposted(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _seed(env)
    thought = _assistant_row("a1", "", str(env.workspace))
    thought["message"]["content"] = [{"type": "thinking", "thinking": "hmm"}]
    _append(path, [thought])
    cursor_before = keep.read_forward_cursor(env.bridge)
    assert cursor_before is not None

    async def dies(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("process died before the cursor was written")

    # The forwarder posts the reasoning row, then dies before it saves the cursor.
    with monkeypatch.context() as patched:
        patched.setattr(forwarder, "_write_forward_state_async", dies)
        with pytest.raises(RuntimeError):
            await _forward(env)
    assert [item["type"] for item in env.server.items[1:]] == ["reasoning"]
    keep._own_ids.clear()

    written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.KEPT
    assert written == path
    # The forwarder resumes at the old cursor and posts the row again: the server dedupes it.
    await _settle(env, written, ctx)
    count = len(env.server.items)
    _restart_forwarder_at(env, path, cursor_before.byte_offset)
    await _forward(env)
    assert len(env.server.items) == count


@pytest.mark.asyncio
async def test_a_kept_and_a_copied_transcript_move_the_record_to_the_server_end(
    env: Env,
) -> None:
    old_ws = env.root / "old-ws"
    _seed(env, workspace=old_ws)
    env.server.add(_SKIPPED_ROWS["resource_event"])
    env.server.add(_SKIPPED_ROWS["error"])

    written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.COPIED
    assert ctx.pending_frontier is not None
    assert (ctx.pending_frontier.item_count, ctx.pending_frontier.last_item_id) == (3, "item_2")
    assert ctx.pending_frontier.transcript_path == written


@pytest.mark.asyncio
async def test_a_kept_transcript_moves_the_record_to_the_server_end(env: Env) -> None:
    _seed(env)
    env.server.add(_SKIPPED_ROWS["resource_event"])

    _written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.KEPT
    assert ctx.pending_frontier is not None
    assert (ctx.pending_frontier.item_count, ctx.pending_frontier.last_item_id) == (2, "item_1")


def test_the_skipped_set_and_the_rebuilt_types_cover_every_item_type(tmp_path: Path) -> None:
    from omnigent.db.enum_codecs import ITEM_TYPE

    rebuilt = {"message", "function_call", "function_call_output", "compaction"}
    assert keep._OUTSIDE_TRANSCRIPT | rebuilt == set(ITEM_TYPE)
    assert not keep._OUTSIDE_TRANSCRIPT & rebuilt
    for item_type in keep._OUTSIDE_TRANSCRIPT:
        record = claude_native._claude_transcript_record_from_session_item(
            {"id": "x", "type": item_type, "role": "user", "content": "text"},
            session_id=SID,
            record_uuid="r",
            parent_uuid=None,
            cwd=tmp_path,
            bridge_dir=tmp_path,
        )
        assert record is None, item_type


# ---- the forwarder's own posts are recognised when the post names no item -----------------


def _derived_env(env: Env) -> Env:
    env.server.derived = True
    env.server.return_item_id = False
    return env


@pytest.mark.asyncio
async def test_a_tunnel_post_names_no_id_yet_the_record_follows_and_the_next_relaunch_keeps(
    env: Env,
) -> None:
    _derived_env(env)
    path = _seed(env)
    _append(path, [_user_row("u1", "list files", str(env.workspace))])
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])

    await _forward(env, _tunnel_client(env))

    assert len(env.server.items) == 3
    last_source_id = list(env.server.source_ids)[-1]
    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert frontier.item_count == 3
    assert frontier.last_item_id == _server_item_id(CONV, last_source_id)
    assert frontier.last_item_id == env.server.items[-1]["id"]

    written, ctx = await _relaunch(env)

    assert _mode(ctx) == keep.KEPT
    assert written == path


@pytest.mark.parametrize(
    "source_id", ["src-1", "  src-2  ", "a b\tc  d", " x  y ", "claude:abc:uuid-1:0"]
)
def test_the_derived_id_is_the_id_the_server_gives_the_item(source_id: str) -> None:
    body = SessionEventInput(
        type="external_conversation_item",
        data={
            "item_type": "message",
            "item_data": {
                "role": "assistant",
                "content": [{"type": "output_text", "text": "x"}],
                "agent": "claude-native-ui",
            },
            "source_id": source_id,
        },
    )

    item = server_orchestration._new_external_conversation_item(CONV, body)

    assert keep.derived_item_id(CONV, source_id) == item.stable_id


@pytest.mark.asyncio
async def test_a_post_that_raised_notes_no_id_and_the_record_stays_behind(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    _derived_env(env)
    path = _seed(env)
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])

    async def fails(*_args: object, **_kwargs: object) -> None:
        raise httpx.ConnectError("down")

    monkeypatch.setattr(forwarder, "_post_external_conversation_item", fails)
    await _forward(env)

    assert not keep._own_ids.get(CONV)
    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert (frontier.item_count, frontier.last_item_id) == (1, "item_0")


@pytest.mark.asyncio
@pytest.mark.parametrize("rejection", ["tunnel-422", "http-503"])
async def test_a_rejected_post_notes_no_id(env: Env, rejection: str) -> None:
    _derived_env(env)
    path = _seed(env)
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])
    if rejection == "tunnel-422":
        client: httpx.AsyncClient = _tunnel_client(env, error="invalid session event")
    else:
        # A retryable tunnel ack never surfaces (the dispatcher resends it); the retryable
        # failure the forwarder sees is the HTTP fallback's 503.
        def busy(request: httpx.Request) -> httpx.Response:
            if request.method == "POST":
                return httpx.Response(503, json={"detail": "busy"})
            return env.server.handle(request)

        client = httpx.AsyncClient(transport=httpx.MockTransport(busy), base_url="http://test")

    await _forward(env, client)

    assert not keep._own_ids.get(CONV)
    assert len(env.server.items) == 1
    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert (frontier.item_count, frontier.last_item_id) == (1, "item_0")


@pytest.mark.asyncio
async def test_a_retry_that_hits_the_server_dedupe_moves_the_record_once(env: Env) -> None:
    _derived_env(env)
    path = _seed(env)
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])
    # The server stores the item but the forwarder never hears back, so it posts it again.
    env.server.lose_next_response = True
    await _forward(env)
    assert len(env.server.items) == 2

    # The retry goes over the tunnel, which acks the dedupe hit with no id.
    await _forward(env, _tunnel_client(env))

    assert len(env.server.items) == 2
    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert (frontier.item_count, frontier.last_item_id) == (2, env.server.items[-1]["id"])


@pytest.mark.asyncio
async def test_a_server_row_written_after_an_own_post_holds_the_record(env: Env) -> None:
    _derived_env(env)
    path = _seed(env)
    _append(path, [_assistant_row("a1", "first", str(env.workspace))])
    await _forward(env, _tunnel_client(env))
    anchor = keep.read_frontier(env.bridge)
    assert anchor is not None and anchor.item_count == 2
    # A drained pending input leaves a server-written user row behind the forwarder's own post.
    env.server.add(
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "queued"}]}
    )
    _append(path, [_assistant_row("a2", "second", str(env.workspace))])

    await _forward(env, _tunnel_client(env))

    assert len(env.server.items) == 4
    held = keep.read_frontier(env.bridge)
    assert held is not None
    assert (held.item_count, held.last_item_id) == (2, anchor.last_item_id)
    _written, ctx = await _relaunch(env)
    assert _mode(ctx) == keep.REBUILT


@pytest.mark.asyncio
async def test_a_real_item_id_wins_over_the_derived_one(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _seed(env)
    noted: list[tuple[object, object]] = []
    real = keep.note_posted

    def spy(session_id: str, item_id: object, source_id: object = None, kind: str = "") -> None:
        noted.append((item_id, source_id))
        real(session_id, item_id, source_id, kind)

    monkeypatch.setattr(keep, "note_posted", spy)
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])

    await _forward(env)

    assert [item_id for item_id, _ in noted] == ["item_1"]
    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert (frontier.item_count, frontier.last_item_id) == (2, "item_1")
    keep.note_posted(CONV, "real", "src")
    assert keep._own_ids[CONV] == {"real": ""}


@pytest.mark.asyncio
async def test_a_foreign_item_after_own_posts_is_logged_once_not_every_poll(
    env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    _derived_env(env)
    path = _seed(env)
    foreign = env.server.add(
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "other"}]}
    )
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])
    caplog.set_level(logging.INFO, logger=keep.__name__)

    await _forward(env, _tunnel_client(env))
    # Each later poll that finds the same delta records again; it must not log again.
    cursor = keep.read_forward_cursor(env.bridge)
    assert cursor is not None
    async with env.client() as client:
        for _ in range(2):
            await keep.record_frontier(client, env.bridge, CONV, cursor)

    held = [r for r in caplog.records if "held at" in r.getMessage()]
    assert len(held) == 1
    message = held[0].getMessage()
    assert foreign in message
    assert "held at 1:" in message
    assert "own_ids=1 delta=2" in message
    assert "other" not in message
    # Own posts that follow the same foreign row do not log it again.
    _append(path, [_assistant_row("a2", "more", str(env.workspace))])
    await _forward(env, _tunnel_client(env))
    assert len([r for r in caplog.records if "held at" in r.getMessage()]) == 1


def test_a_post_with_no_id_and_no_usable_source_id_notes_nothing_and_warns_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.WARNING, logger=keep.__name__)
    for source_id in (None, "", "   ", "x" * 257):
        keep.note_posted(CONV, None, source_id)
    keep.note_posted("conv_other", None, None)

    assert CONV not in keep._own_ids
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 2
    assert "x" * 257 not in "".join(r.getMessage() for r in warnings)
    keep.note_posted(CONV, None, "x" * 256)
    assert list(keep._own_ids[CONV]) == [keep.derived_item_id(CONV, "x" * 256)]
    keep.forget_session(CONV)
    assert CONV not in keep._warned_no_id


def test_the_held_log_state_is_capped_and_cleared_with_the_session() -> None:
    delta = [("item_9", "message", "message:user")]
    for number in range(keep._MAX_LOGGED_SESSIONS + 5):
        keep._log_held(f"conv_{number}", delta, {}, 1, 0)
    assert len(keep._held_logged) == keep._MAX_LOGGED_SESSIONS
    keep.forget_session("conv_0")
    assert "conv_0" not in keep._held_logged


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "colliding",
    [
        {"type": "function_call", "name": "Bash"},
        {"type": "message", "role": "user", "content": []},
    ],
    ids=["other-type", "other-role"],
)
async def test_a_row_that_reuses_an_own_id_under_another_type_or_role_holds_the_record(
    env: Env, caplog: pytest.LogCaptureFixture, colliding: dict[str, Any]
) -> None:
    _derived_env(env)
    path = _seed(env)
    # The server already holds a foreign row under the id this post derives, so the post is
    # a dedupe hit that the forwarder takes for its own.
    env.server.collide_next_post = colliding
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])
    caplog.set_level(logging.INFO, logger=keep.__name__)

    await _forward(env, _tunnel_client(env))

    assert len(env.server.items) == 2
    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert (frontier.item_count, frontier.last_item_id) == (1, "item_0")
    held = [r.getMessage() for r in caplog.records if "held at" in r.getMessage()]
    assert len(held) == 1
    assert env.server.items[1]["id"] in held[0]
    _written, ctx = await _relaunch(env)
    assert _mode(ctx) == keep.REBUILT


@pytest.mark.asyncio
async def test_a_matching_type_and_role_still_counts_as_own(env: Env) -> None:
    _derived_env(env)
    path = _seed(env)
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])
    env.server.collide_next_post = {
        "type": "message",
        "role": "assistant",
        "content": [{"type": "output_text", "text": "done"}],
    }

    await _forward(env, _tunnel_client(env))

    frontier = keep.read_frontier(env.bridge)
    assert frontier is not None
    assert frontier.item_count == 2


@pytest.mark.asyncio
async def test_a_session_with_no_record_drops_every_per_session_note(env: Env) -> None:
    path = _seed(env)
    (env.bridge / keep.FRONTIER_FILE).unlink()
    keep._own_ids[CONV] = {"item_1": ""}
    keep._held_logged[CONV] = ("item_1", "message")
    keep._warned_no_id.add(CONV)
    _append(path, [_assistant_row("a1", "done", str(env.workspace))])

    await _forward(env)

    assert CONV not in keep._own_ids
    assert CONV not in keep._held_logged
    assert CONV not in keep._warned_no_id


@pytest.mark.asyncio
async def test_the_server_stores_a_drained_user_message_and_a_dedupe_hit_under_the_derived_id(
    db_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    conv = store.create_conversation(title="Drain")
    monkeypatch.setattr("omnigent.runtime.session_stream.publish", Mock())
    # An older queued message and the one this transcript row answers: the drain skips the
    # first and consumes the second, and the anchor still takes the source-derived id.
    pending_inputs.record(conv.id, [{"type": "input_text", "text": "Still queued"}])
    pending_inputs.record(conv.id, [{"type": "input_text", "text": "hello"}])
    source_id = "claude:abc:user-record:0"
    body = SessionEventInput(
        type="external_conversation_item",
        data={
            "item_type": "message",
            "item_data": {"role": "user", "content": [{"type": "input_text", "text": "hello"}]},
            "source_id": source_id,
        },
    )

    first = await server_orchestration._persist_external_conversation_item(
        conv.id, conv, body, store
    )

    assert first == keep.derived_item_id(conv.id, source_id)
    stored = store.get_item(conv.id, first)
    assert stored is not None and stored.type == "message"
    # A retry of the same source id is a dedupe hit and names the same item.
    again = await server_orchestration._persist_external_conversation_item(
        conv.id, conv, body, store
    )
    assert again == first
    rows = [row for row in store.list_items(conv.id).data if row.id == first]
    assert len(rows) == 1
