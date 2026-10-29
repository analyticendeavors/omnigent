"""
Keep a session's Claude transcript on a cold relaunch when the server has seen nothing it lacks.

Every cold relaunch (a deploy, a host restart, an idle chat woken, a relaunch after an
account or model switch) used to overwrite ``~/.claude/projects/<dir>/<sid>.jsonl`` with
a transcript rebuilt from server items. The rebuilt bytes differ from what Claude sent
before, so the next API call wrote the whole history (150k to 800k tokens) to the
prompt cache at the write price.

Whether the file on disk can stand in for a rebuild is decided by identity, never by
matching content. Each time the forwarder advances its cursor it also records the server
*frontier* it has seen (the number of items the conversation holds and the id of the
last one) in ``ae_transcript_frontier.json`` next to the cursor, with the offset and
fingerprint of the file it describes. A cold relaunch keeps the file only when:

* the forwarder cursor exists, the bytes before its offset still hash to its fingerprint,
  and the frontier record describes that same cursor;
* the server still holds the item the frontier ends on at the position it recorded, and
  everything after that position is an item the rebuild would leave out of the transcript
  (the server's own resource and error items; see ``_OUTSIDE_TRANSCRIPT``), so the server
  gained or changed nothing the forwarder had not accounted for: a retried or edited turn, an
  item from another harness or a message typed in the web UI all force a rebuild;
* the file ends in a newline, every line after the cursor parses as JSON and the image and
  ``toolUseResult`` repair a rebuild would make has nothing to change.

The forwarder then starts at the cursor's offset, because the rows after it are by
construction absent from the server. A file missing under the current workspace dir is
looked up under every project dir and copied with ``cwd`` rewritten under the same test,
the offset mapped by line count. Anything else (no cursor, no frontier, a mismatch, an
exception) rebuilds exactly as before.
"""

from __future__ import annotations

import asyncio
import contextlib
import copy
import json
import logging
import os
import urllib.parse
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
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

FRONTIER_FILE = "ae_transcript_frontier.json"
_ITEMS_PAGE = 1000
_MAX_PAGES = 50
_MAX_OWN_IDS = 1024

# Item types the transcript rebuild skips (``_claude_record_from_item`` returns ``None``
# for each), by wire name. The server adds some of them on its own: a ``resource_event``
# right after every relaunch, an ``error`` when it cannot deliver a message. Such an item
# says nothing the file lacks, so it neither blocks the frontier record nor forces a
# rebuild. Any other type, including one this list has never seen, counts as part of the
# transcript. ``tests/harnesses/claude_native/test_ae_resume_keep.py`` ties this set to
# ``ITEM_TYPE`` so a new item type has to be placed on purpose.
_OUTSIDE_TRANSCRIPT = frozenset(
    {
        "reasoning",
        "error",
        "native_tool",
        "resource_event",
        "routing_decision",
        "slash_command",
        "terminal_command",
    }
)


def _in_transcript(item_type: str) -> bool:
    return item_type not in _OUTSIDE_TRANSCRIPT


@dataclass(frozen=True)
class ForwardCursor:
    """
    What the transcript forwarder had reached.

    :param transcript_path: File the cursor was recorded against.
    :param byte_offset: Bytes of that file already forwarded.
    :param fingerprint: Hash of the bytes before *byte_offset*.
    """

    transcript_path: Path
    byte_offset: int
    fingerprint: str


@dataclass(frozen=True)
class Frontier:
    """
    The server state the forwarder had seen when its cursor stood at one offset.

    :param transcript_path: File the cursor was recorded against.
    :param byte_offset: Cursor offset the record belongs to.
    :param fingerprint: Fingerprint of the bytes before *byte_offset*.
    :param item_count: Number of items the conversation held.
    :param last_item_id: Id of the last of them.
    """

    transcript_path: Path
    byte_offset: int
    fingerprint: str
    item_count: int
    last_item_id: str


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


@dataclass
class ResumeContext:
    """
    What one cold relaunch knows, handed down the call chain and back up as an object.

    :param bridge_dir: Bridge directory holding the forwarder state.
    :param cursor: The final forwarder cursor of the old forwarder, or ``None``.
    :param frontier: The final frontier record, or ``None``.
    :param server_frontier: Item count and last item id of the history this launch
        fetched, set once the launch has it.
    :param outcome: Set by the launch: how the transcript was obtained.
    :param pending_frontier: The record to write once the launch has its transcript
        (see :func:`settle_resume`); the old record is deleted when the context is read.
    """

    bridge_dir: Path
    cursor: ForwardCursor | None = None
    frontier: Frontier | None = None
    server_frontier: tuple[int, str] | None = None
    outcome: ResumeOutcome | None = None
    pending_frontier: Frontier | None = None


def _same_path(left: Path, right: Path) -> bool:
    try:
        return left.resolve() == right.resolve()
    except OSError:
        return left == right


def read_forward_cursor(bridge_dir: Path) -> ForwardCursor | None:
    """
    Read the forwarder cursor from *bridge_dir*.

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


def read_frontier(bridge_dir: Path) -> Frontier | None:
    """
    Read the frontier record from *bridge_dir*.

    :param bridge_dir: Native Claude bridge directory.
    :returns: The record, or ``None`` when absent or malformed.
    """
    try:
        raw = json.loads((bridge_dir / FRONTIER_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    path = raw.get("transcript_path")
    offset = raw.get("byte_offset")
    fingerprint = raw.get("cursor_fingerprint")
    count = raw.get("item_count")
    last = raw.get("last_item_id")
    if not (
        isinstance(path, str)
        and isinstance(offset, int)
        and isinstance(fingerprint, str)
        and isinstance(count, int)
        and isinstance(last, str)
        and last
    ):
        return None
    return Frontier(Path(path), offset, fingerprint, count, last)


def write_frontier(bridge_dir: Path, frontier: Frontier) -> None:
    """
    Write the frontier record atomically.

    :param bridge_dir: Native Claude bridge directory.
    :param frontier: What to record.
    """
    from omnigent.harnesses.claude_native.forwarder import _write_json_atomic

    _write_json_atomic(
        bridge_dir / FRONTIER_FILE,
        {
            "transcript_path": str(frontier.transcript_path),
            "byte_offset": frontier.byte_offset,
            "cursor_fingerprint": frontier.fingerprint,
            "item_count": frontier.item_count,
            "last_item_id": frontier.last_item_id,
        },
    )


def read_context(bridge_dir: Path, *, forwarder_stopped: bool = True) -> ResumeContext:
    """
    Read the old forwarder's final cursor and frontier for a cold relaunch.

    Call it after the old forwarder has been cancelled and awaited, and before the
    launch wipes its state, so a cursor written while it was being cancelled is the one
    used.

    :param bridge_dir: Native Claude bridge directory.
    :param forwarder_stopped: ``False`` when the old forwarder may still be running; the
        context then carries no cursor and the launch rebuilds. The frontier record is
        deleted either way.
    :returns: The context for this launch.
    """
    ctx = ResumeContext(bridge_dir=bridge_dir)
    if forwarder_stopped:
        ctx.cursor = read_forward_cursor(bridge_dir)
        ctx.frontier = read_frontier(bridge_dir)
    # The record belongs to the cursor the launch is about to wipe. Delete it now, so a
    # launch that never reaches :func:`settle_resume` (history unavailable, no transcript,
    # an exception) leaves none behind for a fresh cursor to inherit; only a keep, a copy
    # or a rebuild writes the next one.
    with contextlib.suppress(OSError):
        (bridge_dir / FRONTIER_FILE).unlink()
    return ctx


# Ids the forwarder's own posts returned that no frontier record has yet absorbed, per
# session, each with the kind of item that was posted (see :func:`item_kind`; empty when
# unknown). Process-local bookkeeping of the forwarder itself (it is never read by a
# launch) so a post made in an earlier, interrupted poll is not mistaken for a foreign item.
# An id counts as own only for a server row of the same kind, so a foreign row that reuses
# the id (a same source id under another type or role) still holds the record.
_own_ids: dict[str, dict[str, str]] = {}


# Longest ``source_id`` the server accepts; it rejects longer ones (and empty ones), so no
# item was stored for such a post and no id can be derived for it.
_MAX_SOURCE_ID = 256

# Per session, the (id, type) of the foreign item named by the last "held" line
# :func:`record_frontier` logged, so one foreign item is logged once, not on every poll and
# however many own posts follow it. Ids and types only, never item text.
_MAX_LOGGED_SESSIONS = 1024
_held_logged: dict[str, tuple[str, str]] = {}

# Sessions already warned about a post that left no id to note.
_warned_no_id: set[str] = set()


def derived_item_id(session_id: str, source_id: str) -> str:
    """
    The id the server gives the item it stores for an external post with *source_id*.

    The runner reaches the server over the event tunnel, whose acknowledgement carries no
    item id, so the forwarder cannot read the id back from the post. The server keys the
    item's stable id by this formula, so the forwarder derives it. It must stay in step with
    ``_new_external_conversation_item`` in ``omnigent/server/routes/_sessions/orchestration.py``.

    :param session_id: Omnigent conversation id the item was posted to, e.g. ``"conv_abc123"``.
    :param source_id: The post's ``source_id``; surrounding whitespace is ignored, as on the
        server.
    :return: The item's id: a 32-character lowercase hex string.
    """
    return uuid.uuid5(
        uuid.NAMESPACE_URL, f"omnigent-external-item:{session_id}:{source_id.strip()}"
    ).hex


def item_kind(item_type: object, role: object = None) -> str:
    """
    The kind of an item as the server's item list reports it, for telling a row from the
    one the forwarder posted: the wire type, plus the role for a message.

    :param item_type: Wire item type, e.g. ``"message"`` or ``"function_call"``.
    :param role: The message role, e.g. ``"assistant"``; ignored for other types.
    :return: e.g. ``"message:assistant"`` or ``"function_call"``; ``""`` when untyped.
    """
    if not isinstance(item_type, str):
        return ""
    if item_type == "message" and isinstance(role, str):
        return f"message:{role}"
    return item_type


def note_posted(
    session_id: str, item_id: object, source_id: object = None, kind: str = ""
) -> None:
    """
    Remember the id the server gave an item the forwarder posted.

    The id the post returned wins. A post over the event tunnel returns none, so the id is
    derived from *source_id* (see :func:`derived_item_id`); that is safe because ``_own_ids``
    only whitelists ids that also appear in the server's item list, and the id of a source id
    this forwarder posted can only be the item the server stored for that post. Call it only
    after the post succeeded.

    :param session_id: Omnigent conversation id, e.g. ``"conv_abc123"``.
    :param item_id: The ``item_id`` of the post's response; anything else is ignored.
    :param source_id: The ``source_id`` the post carried, used when *item_id* is unusable.
    :param kind: :func:`item_kind` of the item posted; the id counts as own only for a row of
        this kind. Empty means any kind.
    """
    if not isinstance(item_id, str) or not item_id:
        if isinstance(source_id, str) and source_id.strip() and len(source_id) <= _MAX_SOURCE_ID:
            item_id = derived_item_id(session_id, source_id)
        else:
            if session_id not in _warned_no_id and len(_warned_no_id) < _MAX_LOGGED_SESSIONS:
                _warned_no_id.add(session_id)
                _logger.warning(
                    "claude-native: a posted item for %s has no item id and no usable "
                    "source id; the transcript keep cannot recognise it",
                    session_id,
                )
            return
    ids = _own_ids.setdefault(session_id, {})
    ids.pop(item_id, None)
    ids[item_id] = kind
    while len(ids) > _MAX_OWN_IDS:
        del ids[next(iter(ids))]


def forget_session(session_id: str) -> None:
    """
    Drop the forwarder's own-post ids for a session whose forwarder has ended.

    :param session_id: Omnigent conversation id, e.g. ``"conv_abc123"``.
    """
    _own_ids.pop(session_id, None)
    _held_logged.pop(session_id, None)
    _warned_no_id.discard(session_id)


def _log_held(
    session_id: str,
    delta: list[tuple[str, str, str]],
    own: Mapping[str, str],
    held: int,
    foreign: int,
) -> None:
    """
    Log, once per change, that the record is held at *held* items by ``delta[foreign]``.

    :param held: The recorded item count, where the frontier stays.
    :param foreign: Index in *delta* of the first item the forwarder did not post.
    """
    item_id, item_type, _kind = delta[foreign]
    marker = (item_id, item_type)
    if _held_logged.get(session_id) == marker:
        return
    if session_id not in _held_logged and len(_held_logged) >= _MAX_LOGGED_SESSIONS:
        return
    _held_logged[session_id] = marker
    _logger.info(
        "claude-native: frontier for %s held at %d: item %s (%s) not posted by this "
        "forwarder; own_ids=%d delta=%d",
        session_id,
        held,
        item_id,
        item_type or "untyped",
        len(own),
        len(delta),
    )


async def _items_after(
    client: httpx.AsyncClient, session_id: str, after: str
) -> list[tuple[str, str, str]] | None:
    """
    The items created after *after* as ``(id, wire type name, kind)`` triples (see
    :func:`item_kind`), or ``None`` when they could not be read. A missing or non-string type
    is the empty string, which counts as part of the transcript.
    """
    ids: list[tuple[str, str, str]] = []
    cursor = after
    for _ in range(_MAX_PAGES):
        resp = await client.get(
            f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}/items",
            params={"limit": _ITEMS_PAGE, "order": "asc", "after": cursor},
        )
        if resp.status_code != 200:
            return None
        payload = resp.json()
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, list):
            return None
        batch = [
            (
                row["id"],
                row["type"] if isinstance(row.get("type"), str) else "",
                item_kind(row.get("type"), row.get("role")),
            )
            for row in data
            if isinstance(row, dict) and isinstance(row.get("id"), str)
        ]
        if len(batch) != len(data):
            return None
        ids.extend(batch)
        if not payload.get("has_more") or not batch:
            return ids
        cursor = batch[-1][0]
    return None


async def record_frontier(
    client: httpx.AsyncClient,
    bridge_dir: Path,
    session_id: str,
    cursor: ForwardCursor,
) -> None:
    """
    Record the server frontier for the cursor the forwarder has just persisted.

    Called by the forwarder after it posts rows and writes its cursor. It advances the
    previous record by the items created since, and only when every one of them is an item
    the forwarder itself posted or a type the rebuild leaves out of the transcript (the
    server's own resource and error items); any other item leaves the record behind, so the
    next cold relaunch sees a mismatch and rebuilds. It never creates a record from nothing:
    with no previous record (a session started before this existed, or a launch that did not
    settle) nothing is written, because a record made at a cursor the forwarder seeded itself would
    vouch for rows the server never received. Never raises.

    :param client: Omnigent HTTP client.
    :param bridge_dir: Native Claude bridge directory.
    :param session_id: Omnigent conversation id, e.g. ``"conv_abc123"``.
    :param cursor: The cursor just persisted.
    """
    try:
        previous = read_frontier(bridge_dir)
        if previous is None:
            forget_session(session_id)
            return
        if (
            _same_path(previous.transcript_path, cursor.transcript_path)
            and previous.byte_offset == cursor.byte_offset
            and previous.fingerprint == cursor.fingerprint
        ):
            return
        delta = await _items_after(client, session_id, previous.last_item_id)
        if delta is None:
            return
        own = _own_ids.get(session_id, {})
        for index, (item_id, item_type, kind) in enumerate(delta):
            recorded = own.get(item_id)
            is_own = recorded is not None and recorded in ("", kind)
            if not is_own and _in_transcript(item_type):
                _log_held(session_id, delta, own, previous.item_count, index)
                return
        _held_logged.pop(session_id, None)
        write_frontier(
            bridge_dir,
            Frontier(
                cursor.transcript_path,
                cursor.byte_offset,
                cursor.fingerprint,
                previous.item_count + len(delta),
                delta[-1][0] if delta else previous.last_item_id,
            ),
        )
        absorbed = {item_id for item_id, _type, _kind in delta}
        _own_ids[session_id] = {
            item_id: kind for item_id, kind in own.items() if item_id not in absorbed
        }
    except Exception:  # noqa: BLE001 - a missed record only costs a later keep
        _logger.debug(
            "claude-native: could not record the server frontier for %s",
            session_id,
            exc_info=True,
        )


def _cursor_matches(path: Path, cursor: ForwardCursor) -> bool:
    from omnigent.harnesses.claude_native.forwarder import _jsonl_cursor_fingerprint

    return _jsonl_cursor_fingerprint(path, cursor.byte_offset) == cursor.fingerprint


def _tail_complete(path: Path, byte_offset: int) -> bool:
    """Whether *path* ends in a newline and every line after *byte_offset* parses as JSON."""
    size = path.stat().st_size
    if size == 0 or byte_offset > size:
        return False
    with path.open("rb") as handle:
        handle.seek(size - 1)
        if handle.read(1) != b"\n":
            return False
        handle.seek(byte_offset)
        for line in handle:
            if not line.strip():
                continue
            if not isinstance(json.loads(line), dict):
                return False
    return True


def _sanitizer_changes_nothing(path: Path, sanitize_record: Callable[[dict], None]) -> bool:
    """Whether the rebuild's image and ``toolUseResult`` repair leaves every record as is."""
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if "tool_result" not in line and "toolUseResult" not in line:
                continue
            record = json.loads(line)
            if not isinstance(record, dict):
                continue
            probe = copy.deepcopy(record)
            sanitize_record(probe)
            if probe != record:
                return False
    return True


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
    count = 0
    remaining = byte_offset
    with path.open("rb") as handle:
        while remaining > 0:
            chunk = handle.read(min(remaining, 1 << 20))
            if not chunk:
                break
            count += chunk.count(b"\n")
            remaining -= len(chunk)
    return count


async def try_keep(
    ctx: ResumeContext,
    *,
    session_id: str,
    items: Sequence[Mapping[str, object]],
    target: Path,
    external_session_id: str,
    workspace: Path,
    is_resumable: Callable[[Path], bool],
    find_transcript: Callable[..., Path | None],
    copy_transcript: Callable[..., None],
    sanitize_record: Callable[[dict], None],
) -> Path | None:
    """
    Use the transcript already on disk instead of rebuilding it, when the test above passes.

    :param ctx: This launch's context; its ``outcome`` is set when the file is used.
    :param session_id: Omnigent conversation id, e.g. ``"conv_abc123"``.
    :param items: Server session items for the conversation, as fetched for this launch.
    :param target: Where ``claude --resume`` reads the transcript for this workspace.
    :param external_session_id: Claude session id, e.g. ``"<claude-session-uuid>"``.
    :param workspace: Resolved directory Claude runs in.
    :param is_resumable: ``_is_resumable_claude_transcript``.
    :param find_transcript: ``_find_claude_transcript``.
    :param copy_transcript: ``_copy_transcript_with_cwd``.
    :param sanitize_record: ``_sanitize_cloned_tool_result_record``.
    :returns: *target* when it is now a transcript to resume from, or ``None`` when the
        caller should rebuild as before. Any exception also gives ``None``. The file work
        runs in a worker thread, so a large transcript does not stall the runner's loop.
    """
    try:
        return await asyncio.to_thread(
            _try_keep,
            ctx,
            items=items,
            target=target,
            external_session_id=external_session_id,
            workspace=workspace,
            is_resumable=is_resumable,
            find_transcript=find_transcript,
            copy_transcript=copy_transcript,
            sanitize_record=sanitize_record,
        )
    except Exception:  # noqa: BLE001 - any doubt means the old rebuild
        _logger.warning(
            "claude-native: could not reuse the local transcript for %s; rebuilding it",
            session_id,
            exc_info=True,
            extra={"session_id": session_id},
        )
        ctx.outcome = None
        return None


def _frontier_holds(frontier: Frontier, items: Sequence[Mapping[str, object]]) -> bool:
    """
    Whether the server still holds the frontier and has added nothing the file lacks.

    The item at the recorded position must be the recorded one (so a retried or replaced
    turn fails), and every later item must be of a type the rebuild leaves out.
    """
    count = frontier.item_count
    if count < 1 or len(items) < count:
        return False
    if items[count - 1].get("id") != frontier.last_item_id:
        return False
    for item in items[count:]:
        item_type = item.get("type")
        if not isinstance(item_type, str) or _in_transcript(item_type):
            return False
    return True


def _try_keep(
    ctx: ResumeContext,
    *,
    items: Sequence[Mapping[str, object]],
    target: Path,
    external_session_id: str,
    workspace: Path,
    is_resumable: Callable[[Path], bool],
    find_transcript: Callable[..., Path | None],
    copy_transcript: Callable[..., None],
    sanitize_record: Callable[[dict], None],
) -> Path | None:
    cursor, frontier = ctx.cursor, ctx.frontier
    if cursor is None or frontier is None or not items:
        return None
    if not _frontier_holds(frontier, items):
        return None
    last_id = items[-1].get("id")
    if not isinstance(last_id, str):
        return None
    if (
        not _same_path(frontier.transcript_path, cursor.transcript_path)
        or frontier.byte_offset != cursor.byte_offset
        or frontier.fingerprint != cursor.fingerprint
    ):
        return None

    copying = not target.is_file()
    if copying:
        source = find_transcript(external_session_id, exclude=target)
        if source is None or not _same_path(source, cursor.transcript_path):
            return None
    else:
        source = target
        if not _same_path(target, cursor.transcript_path):
            return None
    if not is_resumable(source) or not _cursor_matches(source, cursor):
        return None
    if not _tail_complete(source, cursor.byte_offset):
        return None
    if not _sanitizer_changes_nothing(source, sanitize_record):
        return None

    # The trailing items were just checked, so the record moves up to the server's end.
    if not copying:
        ctx.pending_frontier = replace(frontier, item_count=len(items), last_item_id=last_id)
        ctx.outcome = ResumeOutcome(KEPT, cursor.byte_offset)
        return target

    from omnigent.harnesses.claude_native.forwarder import _jsonl_cursor_fingerprint

    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = target.with_suffix(".jsonl.tmp")
    try:
        copy_transcript(source=source, target=tmp, current=workspace)
        os.replace(tmp, target)
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
    # The copy rewrites every line, so the bytes shift but the lines do not.
    offset = _offset_after_lines(target, _lines_before(source, cursor.byte_offset))
    fingerprint = _jsonl_cursor_fingerprint(target, offset)
    if fingerprint is None:
        target.unlink()
        return None
    ctx.pending_frontier = Frontier(target, offset, fingerprint, len(items), last_id)
    ctx.outcome = ResumeOutcome(COPIED, offset)
    return target


def note_rebuilt(ctx: ResumeContext, items: Sequence[Mapping[str, object]]) -> None:
    """
    Record that this launch rebuilt the transcript from server items.

    :param ctx: This launch's context.
    :param items: The server items the rebuild used.
    """
    last_id = items[-1].get("id") if items else None
    ctx.server_frontier = (len(items), last_id) if isinstance(last_id, str) and last_id else None
    ctx.outcome = ResumeOutcome(REBUILT)


async def settle_resume(
    server_client: httpx.AsyncClient,
    session_id: str,
    ctx: ResumeContext,
    transcript: Path,
    measured_prefix_bytes: int | None,
    labels: Mapping[str, str] | None,
) -> int | None:
    """
    Label the session with the path its cold relaunch took and pick the forwarder offset.

    The frontier record the launch deleted when it read its context is written back here
    (the same one for a keep, the remapped one for a copy, a first one for a rebuild), so
    the next cold relaunch has one to test and a launch that never gets here leaves none.
    Never fails a launch: a label that cannot be written is logged.

    :param server_client: The runner's Omnigent client.
    :param session_id: Omnigent conversation id, e.g. ``"conv_abc123"``.
    :param ctx: This launch's context.
    :param transcript: The transcript the launch resumes from.
    :param measured_prefix_bytes: Size of the transcript measured before Claude starts.
    :param labels: The session's labels as the launch saw them, for the running count;
        ``None`` starts the count over.
    :returns: The byte offset the forwarder should start from: the recorded cursor when
        a kept or copied transcript was ahead of it, otherwise *measured_prefix_bytes*.
    """
    outcome = ctx.outcome
    if outcome is None:
        return measured_prefix_bytes
    try:
        pending = ctx.pending_frontier
        if outcome.mode == REBUILT and ctx.server_frontier and measured_prefix_bytes is not None:
            from omnigent.harnesses.claude_native.forwarder import _jsonl_cursor_fingerprint

            fingerprint = _jsonl_cursor_fingerprint(transcript, measured_prefix_bytes)
            if fingerprint is not None:
                count, last_id = ctx.server_frontier
                pending = Frontier(transcript, measured_prefix_bytes, fingerprint, count, last_id)
        # With no measured size the forwarder seeds from the live end of the file, which can
        # be past rows the server lacks; a record written now would vouch for them.
        if pending is not None and measured_prefix_bytes is not None:
            write_frontier(ctx.bridge_dir, pending)
    except Exception:  # noqa: BLE001 - a missed record only costs a later keep
        _logger.warning(
            "claude-native: could not record the server frontier for %s",
            session_id,
            exc_info=True,
            extra={"session_id": session_id},
        )
    try:
        count_now = int((labels or {}).get(RESUME_COUNT_LABEL, "0")) + 1
    except ValueError:
        count_now = 1
    _logger.info(
        "claude-native: cold resume of %s used the %s transcript; resume=%d",
        session_id,
        outcome.mode,
        count_now,
        extra={"session_id": session_id},
    )
    try:
        resp = await server_client.patch(
            f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
            json={"labels": {RESUME_LABEL: outcome.mode, RESUME_COUNT_LABEL: str(count_now)}},
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
