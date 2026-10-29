"""A cold relaunch keeps a local Claude transcript that already covers the server (omnigent-ae)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from omnigent.harnesses.claude_native import ae_resume_keep as keep
from omnigent.harnesses.claude_native import main as claude_native
from omnigent.harnesses.claude_native.forwarder import _jsonl_cursor_fingerprint

SID = "sid123"
WORKSPACE = Path("/work/some-repo")

ITEMS = [
    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "list files"}]},
    {"type": "function_call", "name": "Bash", "call_id": "toolu_01A", "arguments": "{}"},
    {"type": "function_call_output", "call_id": "toolu_01A", "output": "a.txt"},
    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]},
    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "now read a"}]},
]


def _user(text: str, cwd: str = "/work/some-repo") -> dict[str, object]:
    return {"type": "user", "cwd": cwd, "message": {"role": "user", "content": text}}


def _tool_use(call_id: str) -> dict[str, object]:
    return {
        "type": "assistant",
        "cwd": "/work/some-repo",
        "message": {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": call_id, "name": "Bash", "input": {}}],
        },
    }


def _tool_result(call_id: str) -> dict[str, object]:
    return {
        "type": "user",
        "cwd": "/work/some-repo",
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": call_id, "content": "a.txt"}],
        },
    }


def _write(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


def _covering_rows() -> list[dict[str, object]]:
    return [
        _user("list files"),
        _tool_use("toolu_01A"),
        _tool_result("toolu_01A"),
        _user("now read a"),
    ]


def _page(items: list[dict[str, object]]) -> httpx.Response:
    return httpx.Response(200, json={"data": items, "has_more": False})


@pytest.fixture
def projects(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "projects"
    monkeypatch.setattr(claude_native, "_CLAUDE_PROJECTS_DIR", root)
    keep._pending.clear()
    keep._cursors.clear()
    return root


def _target(projects: Path) -> Path:
    return projects / claude_native._sanitize_claude_project_name(str(WORKSPACE)) / f"{SID}.jsonl"


async def _ensure(
    items: list[dict[str, object]], cursor: keep.ForwardCursor | None = None
) -> Path | None:
    keep.remember_cursor("conv_abc", cursor)
    transport = httpx.MockTransport(lambda request: _page(items))
    async with httpx.AsyncClient(transport=transport, base_url="https://example.com") as client:
        return await claude_native._ensure_local_claude_resume_transcript(
            client,
            session_id="conv_abc",
            external_session_id=SID,
            workspace=WORKSPACE,
        )


def _cursor(path: Path, offset: int) -> keep.ForwardCursor:
    fingerprint = _jsonl_cursor_fingerprint(path, offset)
    assert fingerprint is not None
    return keep.ForwardCursor(path, offset, fingerprint)


@pytest.mark.asyncio
async def test_kept_when_the_file_covers_the_server_items(projects: Path) -> None:
    target = _target(projects)
    _write(target, _covering_rows())
    before = target.read_bytes()
    stamp = target.stat().st_mtime_ns

    written = await _ensure(ITEMS)

    assert written == target
    assert target.read_bytes() == before
    assert target.stat().st_mtime_ns == stamp
    outcome = keep.take_outcome("conv_abc")
    assert outcome == keep.ResumeOutcome(keep.KEPT, None)


@pytest.mark.asyncio
async def test_rebuilt_when_a_tool_call_id_is_missing_from_the_file(projects: Path) -> None:
    target = _target(projects)
    _write(target, [_user("list files"), _user("now read a")])

    written = await _ensure(ITEMS)

    assert written == target
    assert "toolu_01A" in target.read_text(encoding="utf-8")
    assert keep.take_outcome("conv_abc") == keep.ResumeOutcome(keep.REBUILT)


@pytest.mark.asyncio
async def test_rebuilt_when_the_last_user_text_is_missing_from_the_file(projects: Path) -> None:
    target = _target(projects)
    _write(target, _covering_rows()[:-1])

    await _ensure(ITEMS)

    assert "now read a" in target.read_text(encoding="utf-8")
    assert keep.take_outcome("conv_abc") == keep.ResumeOutcome(keep.REBUILT)


@pytest.mark.asyncio
async def test_rebuilt_when_the_local_file_is_not_resumable(projects: Path) -> None:
    target = _target(projects)
    target.parent.mkdir(parents=True)
    target.write_text("not json\n", encoding="utf-8")

    await _ensure(ITEMS)

    assert keep.take_outcome("conv_abc") == keep.ResumeOutcome(keep.REBUILT)


@pytest.mark.asyncio
async def test_copied_when_the_file_sits_under_an_old_workspace_dir(projects: Path) -> None:
    old = projects / "-old-workspace" / f"{SID}.jsonl"
    _write(old, [{**row, "cwd": "/old/workspace"} for row in _covering_rows()])

    written = await _ensure(ITEMS)

    target = _target(projects)
    assert written == target
    rows = [json.loads(line) for line in target.read_text(encoding="utf-8").splitlines()]
    assert {row["cwd"] for row in rows} == {str(WORKSPACE)}
    assert rows[0]["message"]["content"] == "list files"
    assert old.is_file()
    assert keep.take_outcome("conv_abc") == keep.ResumeOutcome(keep.COPIED, None)


@pytest.mark.asyncio
async def test_rebuilt_when_the_old_workspace_copy_does_not_cover(projects: Path) -> None:
    old = projects / "-old-workspace" / f"{SID}.jsonl"
    _write(old, [_user("list files")])

    await _ensure(ITEMS)

    assert "toolu_01A" in _target(projects).read_text(encoding="utf-8")
    assert keep.take_outcome("conv_abc") == keep.ResumeOutcome(keep.REBUILT)


@pytest.mark.asyncio
async def test_a_file_ahead_of_the_server_is_kept_and_forwarded_from_the_cursor(
    projects: Path,
) -> None:
    target = _target(projects)
    rows = _covering_rows()
    _write(target, rows)
    forwarded = target.stat().st_size
    # The forwarder lagged at a crash: the file holds a turn the server never got.
    with target.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(_tool_use("toolu_02B")) + "\n")
        handle.write(json.dumps(_user("a later prompt")) + "\n")

    written = await _ensure(ITEMS, _cursor(target, forwarded))

    assert written == target
    assert "toolu_02B" in target.read_text(encoding="utf-8")
    assert keep.take_outcome("conv_abc") == keep.ResumeOutcome(keep.KEPT, forwarded)


@pytest.mark.asyncio
async def test_a_file_ahead_of_the_server_with_no_cursor_is_rebuilt(projects: Path) -> None:
    target = _target(projects)
    _write(target, [*_covering_rows(), _tool_use("toolu_02B"), _user("a later prompt")])

    await _ensure(ITEMS)

    assert "toolu_02B" not in target.read_text(encoding="utf-8")
    assert keep.take_outcome("conv_abc") == keep.ResumeOutcome(keep.REBUILT)


@pytest.mark.asyncio
async def test_a_stale_cursor_counts_as_no_cursor(projects: Path) -> None:
    target = _target(projects)
    _write(target, [*_covering_rows(), _tool_use("toolu_02B")])
    stale = _cursor(target, target.stat().st_size)
    target.write_text(target.read_text(encoding="utf-8").replace("toolu_02B", "toolu_02C"))

    await _ensure(ITEMS, stale)

    assert keep.take_outcome("conv_abc") == keep.ResumeOutcome(keep.REBUILT)


@pytest.mark.asyncio
async def test_copied_file_ahead_of_the_server_maps_the_cursor_to_the_copy(
    projects: Path,
) -> None:
    old = projects / "-old-workspace" / f"{SID}.jsonl"
    rows = [{**row, "cwd": "/old/workspace"} for row in _covering_rows()]
    _write(old, rows)
    forwarded = old.stat().st_size
    with old.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({**_user("a later prompt"), "cwd": "/old/workspace"}) + "\n")

    await _ensure(ITEMS, _cursor(old, forwarded))

    target = _target(projects)
    outcome = keep.take_outcome("conv_abc")
    assert outcome is not None
    assert outcome.mode == keep.COPIED
    assert outcome.forward_offset is not None
    # Everything before the offset is what the server has; the later prompt is after it.
    forwarded_text = target.read_bytes()[: outcome.forward_offset].decode("utf-8")
    assert "now read a" in forwarded_text
    assert "a later prompt" not in forwarded_text
    assert "a later prompt" in target.read_text(encoding="utf-8")


def test_read_forward_cursor_reads_the_forwarder_state(tmp_path: Path) -> None:
    transcript = tmp_path / "t.jsonl"
    _write(transcript, _covering_rows())
    offset = transcript.stat().st_size
    fingerprint = _jsonl_cursor_fingerprint(transcript, offset)
    (tmp_path / "transcript_forwarder.json").write_text(
        json.dumps(
            {
                "transcript_path": str(transcript),
                "line_cursor": 4,
                "byte_offset": offset,
                "cursor_fingerprint": fingerprint,
            }
        ),
        encoding="utf-8",
    )

    assert keep.read_forward_cursor(tmp_path) == keep.ForwardCursor(
        transcript, offset, fingerprint
    )
    assert keep.read_forward_cursor(tmp_path / "missing") is None


@pytest.mark.asyncio
async def test_settle_labels_the_session_and_picks_the_forwarder_offset() -> None:
    patches: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        patches.append(json.loads(request.content))
        return httpx.Response(200, json={})

    keep._pending.clear()
    keep._remember("conv_abc", keep.ResumeOutcome(keep.KEPT, 40))
    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport, base_url="https://example.com") as client:
        offset = await keep.settle_resume(client, "conv_abc", 100, {keep.RESUME_COUNT_LABEL: "2"})
        # No outcome pending (a path that never prepared a transcript): nothing is written.
        untouched = await keep.settle_resume(client, "conv_abc", 100, None)

    assert offset == 40
    assert untouched == 100
    assert patches == [{"labels": {keep.RESUME_LABEL: "kept", keep.RESUME_COUNT_LABEL: "3"}}]


@pytest.mark.asyncio
async def test_settle_survives_a_failed_label_write() -> None:
    keep._pending.clear()
    keep._remember("conv_abc", keep.ResumeOutcome(keep.REBUILT))
    transport = httpx.MockTransport(lambda request: httpx.Response(500))
    async with httpx.AsyncClient(transport=transport, base_url="https://example.com") as client:
        offset = await keep.settle_resume(client, "conv_abc", 100, None)

    assert offset == 100


@pytest.mark.asyncio
async def test_rebuilt_when_the_file_carries_the_old_duplicated_image(projects: Path) -> None:
    target = _target(projects)
    image = {"type": "image", "source": {"type": "base64", "data": "AAAA"}}
    stale = {
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "toolu_01A", "content": [image]}],
        },
        "toolUseResult": json.dumps([image]),
    }
    _write(target, [_user("list files"), _tool_use("toolu_01A"), stale, _user("now read a")])

    await _ensure(ITEMS)

    assert "AAAA" not in target.read_text(encoding="utf-8")
    assert keep.take_outcome("conv_abc") == keep.ResumeOutcome(keep.REBUILT)
