"""A cold relaunch keeps a Claude transcript only when the server frontier matches."""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest

from omnigent.harnesses.claude_native import ae_resume_keep as keep
from omnigent.harnesses.claude_native import forwarder
from omnigent.harnesses.claude_native import main as claude_native
from omnigent.runner.native import orchestration

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

    def add(self, item: dict[str, Any]) -> str:
        item_id = f"item_{len(self.items)}"
        self.items.append({"id": item_id, **item})
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
            data = body["data"]
            item_id = self.add({"type": data["item_type"], **data["item_data"]})
            return httpx.Response(202, json={"queued": False, "item_id": item_id})
        return httpx.Response(202, json={})


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
    yield
    keep._own_ids.clear()


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


async def _forward(env: Env) -> None:
    """Run the real forwarder over whatever Claude has written since its cursor."""
    state = forwarder._read_forward_state(env.bridge)
    assert state is not None
    async with env.client() as client:
        await forwarder._forward_available_items(
            client=client,
            session_id=CONV,
            bridge_dir=env.bridge,
            agent_name="claude-native-ui",
            state=state,
            retry_tracker=forwarder._PostRetryTracker(),
            dedupe=forwarder._ForwardDedupeState(),
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
    assert keep._own_ids[CONV] == ["item_1"]
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
