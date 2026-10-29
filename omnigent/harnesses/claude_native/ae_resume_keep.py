"""
Keep a session's Claude transcript on a cold relaunch when it already covers the server.

Every cold relaunch (a deploy, a host restart, an idle chat woken, a relaunch after an
account or model switch) used to overwrite ``~/.claude/projects/<dir>/<sid>.jsonl`` with
a transcript rebuilt from server items. The rebuilt bytes differ from what Claude sent
before, so the next API call wrote the whole history (150k to 800k tokens) to the
prompt cache at the write price. When the file on disk can be resumed and covers the
server history, resuming from it keeps those bytes, and the cache read stays a read.

"Covers" means every ``toolu_*`` call id in the server items appears in the file and
the last server user text appears in a user record there. The file can also be ahead
of the server (the forwarder lagged when the runner died), and ``start_at_end`` would
then skip those rows in the UI. So the forwarder's own cursor is read before the
launch wipes it: a cursor that still matches the file seeds the forwarder at the
offset it had reached, and with no usable cursor the file must match the server
exactly (same ``toolu_*`` ids, same last user text) or the transcript is rebuilt.

A transcript that is missing under the current workspace dir (the folder moved or
was recreated) is looked up under every project dir and copied with its ``cwd``
rewritten, under the same covers check.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import urllib.parse
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import httpx

_logger = logging.getLogger(__name__)

# Which path the last cold relaunch took: ``kept``, ``copied`` or ``rebuilt``, and how
# many cold relaunches the session has had. Written by the runner at launch.
RESUME_LABEL = "ae.claude_native.resume"
RESUME_COUNT_LABEL = "ae.claude_native.resume_count"

KEPT = "kept"
COPIED = "copied"
REBUILT = "rebuilt"

_TOOL_ID_RE = re.compile(r"toolu_[A-Za-z0-9]+")
_MAX_PENDING_OUTCOMES = 256


class _StaleTranscriptError(Exception):
    """A transcript holds a record only a rebuild repairs."""


@dataclass(frozen=True)
class ForwardCursor:
    """
    What the transcript forwarder had reached, read before a launch wipes its state.

    :param transcript_path: File the cursor was recorded against.
    :param byte_offset: Bytes of that file already forwarded.
    :param fingerprint: Hash of the bytes before *byte_offset*.
    """

    transcript_path: Path
    byte_offset: int
    fingerprint: str


@dataclass(frozen=True)
class ResumeOutcome:
    """
    How one cold relaunch obtained its transcript.

    :param mode: ``"kept"``, ``"copied"`` or ``"rebuilt"``.
    :param forward_offset: Byte offset the forwarder should start from in the
        transcript, or ``None`` to use the measured size of the file.
    """

    mode: str
    forward_offset: int | None = None


_pending: dict[str, ResumeOutcome] = {}
_cursors: dict[str, ForwardCursor] = {}


def read_forward_cursor(bridge_dir: Path) -> ForwardCursor | None:
    """
    Read the forwarder cursor from *bridge_dir*, which the launch is about to wipe.

    :param bridge_dir: Native Claude bridge directory.
    :returns: The cursor, or ``None`` when there is none or it carries no byte offset
        and fingerprint.
    """
    from omnigent.harnesses.claude_native.forwarder import _read_forward_state

    try:
        state = _read_forward_state(bridge_dir)
    except Exception:  # noqa: BLE001 - an unreadable cursor only costs the keep
        return None
    if state is None or state.byte_offset is None or not state.cursor_fingerprint:
        return None
    return ForwardCursor(state.transcript_path, state.byte_offset, state.cursor_fingerprint)


def remember_cursor(session_id: str, cursor: ForwardCursor | None) -> None:
    """
    Hold the forwarder cursor read before a launch wipes it, for :func:`try_keep`.

    :param session_id: Omnigent conversation id, e.g. ``"conv_abc123"``.
    :param cursor: What :func:`read_forward_cursor` returned; ``None`` clears any held one.
    """
    _cursors.pop(session_id, None)
    if cursor is None:
        return
    while len(_cursors) >= _MAX_PENDING_OUTCOMES:
        _cursors.pop(next(iter(_cursors)))
    _cursors[session_id] = cursor


def _normalize(text: str) -> str:
    return " ".join(text.split())


def _content_text(content: object) -> str:
    """Text of a message ``content`` that is a string or a list of blocks."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(parts)


def _server_tool_ids_and_last_user(items: Sequence[Mapping[str, object]]) -> tuple[set[str], str]:
    tool_ids: set[str] = set()
    last_user = ""
    for item in items:
        call_id = item.get("call_id")
        if isinstance(call_id, str) and call_id.startswith("toolu_"):
            tool_ids.add(call_id)
        if item.get("type") == "message" and item.get("role") == "user":
            text = _normalize(_content_text(item.get("content")))
            if text:
                last_user = text
    return tool_ids, last_user


def _scan_transcript(path: Path, probe: str) -> tuple[set[str], str, bool]:
    """
    Read a transcript once.

    :param path: Claude transcript JSONL.
    :param probe: Normalized user text to look for, or ``""`` for none.
    :returns: Every ``toolu_*`` id in it, the normalized text of its last user text
        record, and whether any user record's text holds *probe*. A record carrying the
        old rebuild's duplicated image payload (``toolUseResult`` as a string that holds
        base64) is reported by raising :class:`_StaleTranscriptError`, so the rebuild
        repairs it.
    """
    tool_ids: set[str] = set()
    last_user = ""
    found = not probe
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if "toolu_" in line:
                tool_ids.update(_TOOL_ID_RE.findall(line))
            if '"user"' not in line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict) or record.get("type") != "user":
                continue
            tool_use_result = record.get("toolUseResult")
            if isinstance(tool_use_result, str) and '"base64"' in tool_use_result:
                raise _StaleTranscriptError(path)
            message = record.get("message")
            if not isinstance(message, dict):
                continue
            text = _normalize(_content_text(message.get("content")))
            if not text:
                continue
            last_user = text
            if probe and probe in text:
                found = True
    return tool_ids, last_user, found


def _covers(path: Path, items: Sequence[Mapping[str, object]], *, exact: bool) -> bool:
    """
    Whether *path* holds everything the server items do.

    :param path: Candidate transcript.
    :param items: Server session items.
    :param exact: Also require the file to hold no ``toolu_*`` id and no later user
        text that the server lacks, for when nothing says how far the forwarder got.
    :returns: ``True`` when the transcript can stand in for a rebuild.
    """
    server_ids, server_last = _server_tool_ids_and_last_user(items)
    if not server_ids and not server_last:
        return False
    try:
        file_ids, file_last, found = _scan_transcript(path, server_last)
    except _StaleTranscriptError:
        return False
    if not server_ids <= file_ids or not found:
        return False
    if exact:
        return file_ids == server_ids and (not server_last or server_last in file_last)
    return True


def _cursor_matches(path: Path, cursor: ForwardCursor | None) -> bool:
    if cursor is None or cursor.transcript_path != path:
        return False
    from omnigent.harnesses.claude_native.forwarder import _jsonl_cursor_fingerprint

    return _jsonl_cursor_fingerprint(path, cursor.byte_offset) == cursor.fingerprint


def _offset_after_lines(path: Path, lines: int) -> int:
    offset = 0
    with path.open("rb") as handle:
        for _ in range(lines):
            chunk = handle.readline()
            if not chunk:
                break
            offset += len(chunk)
    return offset


def _lines_before(path: Path, byte_offset: int) -> int:
    with path.open("rb") as handle:
        return handle.read(byte_offset).count(b"\n")


def try_keep(
    *,
    session_id: str,
    items: Sequence[Mapping[str, object]],
    target: Path,
    external_session_id: str,
    workspace: Path,
    is_resumable: Callable[[Path], bool],
    find_transcript: Callable[..., Path | None],
    copy_transcript: Callable[..., None],
) -> Path | None:
    """
    Use the transcript already on disk instead of rebuilding it, when it covers the server.

    :param session_id: Omnigent conversation id, e.g. ``"conv_abc123"``.
    :param items: Server session items for the conversation.
    :param target: Where ``claude --resume`` reads the transcript for this workspace.
    :param external_session_id: Claude session id, e.g.
        ``"<claude-session-uuid>"``.
    :param workspace: Resolved directory Claude runs in.
    :param is_resumable: ``_is_resumable_claude_transcript``.
    :param find_transcript: ``_find_claude_transcript``.
    :param copy_transcript: ``_copy_transcript_with_cwd``.
    :returns: *target* when it is now a transcript to resume from, or ``None`` when the
        caller should rebuild as before. The cursor :func:`remember_cursor` held is used
        up, and the path taken is left for :func:`take_outcome`.
    """
    try:
        return _try_keep(
            session_id=session_id,
            items=items,
            target=target,
            external_session_id=external_session_id,
            workspace=workspace,
            cursor=_cursors.pop(session_id, None),
            is_resumable=is_resumable,
            find_transcript=find_transcript,
            copy_transcript=copy_transcript,
        )
    except Exception:  # noqa: BLE001 - any doubt means the old rebuild
        _logger.warning(
            "claude-native: could not reuse the local transcript for %s; rebuilding it",
            session_id,
            exc_info=True,
            extra={"session_id": session_id},
        )
        return None


def _try_keep(
    *,
    session_id: str,
    items: Sequence[Mapping[str, object]],
    target: Path,
    external_session_id: str,
    workspace: Path,
    cursor: ForwardCursor | None,
    is_resumable: Callable[[Path], bool],
    find_transcript: Callable[..., Path | None],
    copy_transcript: Callable[..., None],
) -> Path | None:
    if target.is_file():
        if not is_resumable(target):
            return None
        usable = _cursor_matches(target, cursor)
        if not _covers(target, items, exact=not usable):
            return None
        offset = cursor.byte_offset if usable and cursor is not None else None
        _remember(session_id, ResumeOutcome(KEPT, offset))
        return target

    source = find_transcript(external_session_id, exclude=target)
    if source is None or not is_resumable(source):
        return None
    usable = _cursor_matches(source, cursor)
    if not _covers(source, items, exact=not usable):
        return None
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = target.with_suffix(".jsonl.tmp")
    try:
        copy_transcript(source=source, target=tmp, current=workspace)
        os.replace(tmp, target)
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
    offset = None
    if usable and cursor is not None:
        # The copy rewrites every line, so the bytes shift but the lines do not.
        offset = _offset_after_lines(target, _lines_before(source, cursor.byte_offset))
    _remember(session_id, ResumeOutcome(COPIED, offset))
    return target


def note_rebuilt(session_id: str) -> None:
    """
    Record that this launch rebuilt the transcript from server items.

    :param session_id: Omnigent conversation id, e.g. ``"conv_abc123"``.
    """
    _remember(session_id, ResumeOutcome(REBUILT))


def _remember(session_id: str, outcome: ResumeOutcome) -> None:
    _pending.pop(session_id, None)
    while len(_pending) >= _MAX_PENDING_OUTCOMES:
        _pending.pop(next(iter(_pending)))
    _pending[session_id] = outcome


def take_outcome(session_id: str) -> ResumeOutcome | None:
    """
    Return and clear the outcome of the last transcript preparation for a session.

    :param session_id: Omnigent conversation id, e.g. ``"conv_abc123"``.
    :returns: The outcome, or ``None`` when no cold resume ran.
    """
    return _pending.pop(session_id, None)


async def settle_resume(
    server_client: httpx.AsyncClient,
    session_id: str,
    measured_prefix_bytes: int | None,
    labels: Mapping[str, str] | None,
) -> int | None:
    """
    Label the session with the path its cold relaunch took and pick the forwarder offset.

    Never fails a launch: a label that cannot be written is logged.

    :param server_client: The runner's Omnigent client.
    :param session_id: Omnigent conversation id, e.g. ``"conv_abc123"``.
    :param measured_prefix_bytes: Size of the transcript measured before Claude starts.
    :param labels: The session's labels as the launch saw them, for the running count;
        ``None`` starts the count over.
    :returns: The byte offset the forwarder should start from: the recorded cursor when
        a kept or copied transcript was ahead of it, otherwise *measured_prefix_bytes*.
    """
    outcome = take_outcome(session_id)
    if outcome is None:
        return measured_prefix_bytes
    try:
        count = int((labels or {}).get(RESUME_COUNT_LABEL, "0")) + 1
    except ValueError:
        count = 1
    _logger.info(
        "claude-native: cold resume of %s used the %s transcript; resume=%d",
        session_id,
        outcome.mode,
        count,
        extra={"session_id": session_id},
    )
    try:
        resp = await server_client.patch(
            f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
            json={"labels": {RESUME_LABEL: outcome.mode, RESUME_COUNT_LABEL: str(count)}},
            params={"include_usage": "false"},
            timeout=10.0,
        )
        resp.raise_for_status()
    except Exception:  # noqa: BLE001 - a failed label must not sink the launch
        _logger.warning(
            "claude-native: could not label session %s with its resume path",
            session_id,
            exc_info=True,
            extra={"session_id": session_id},
        )
    if outcome.forward_offset is not None and measured_prefix_bytes is not None:
        return min(outcome.forward_offset, measured_prefix_bytes)
    return measured_prefix_bytes
