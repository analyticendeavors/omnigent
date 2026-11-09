"""Whether a native Claude turn wrote visible reply text before a pop-up.

On 2026-11-09 a native chat raised an AskUserQuestion card ("Apply the proposed
copy from the assistant's message?") in a turn that wrote no text block at all: only a
redacted thinking block, a one-line summary and the tool call. The user saw the
card and nothing it referred to. The policy hook calls
:func:`reply_text_since_last_prompt` for a pop-up tool call and stamps the answer
on the call's arguments, where ``ae_omni_policies.popup_text`` reads it.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO

#: Bytes read per step while walking the transcript backward.
_CHUNK_BYTES = 1024 * 1024

#: Most of the transcript's tail the walk may read; past it the answer is unknown.
_MAX_BYTES = 16 * 1024 * 1024

#: Pop-up tools the flag is computed for.
POPUP_TOOLS = frozenset({"AskUserQuestion", "mcp__ae__ask_user"})

#: Key stamped on the tool call's ``arguments`` for the policy to read.
FLAG_KEY = "ae_reply_text_before"


class _TooLarge(Exception):
    """The walk reached the read cap before it found a boundary."""


def _reverse_lines(handle: BinaryIO, size: int) -> Iterator[bytes]:
    """Yield the file's lines newest first, reading backward in chunks.

    Splits on ``\\n`` only: JSON writes U+2028, U+2029 and U+0085 raw, and
    ``splitlines`` would cut a valid line there.

    :raises _TooLarge: When more than the read cap is needed.
    """
    pos = size
    buf = b""
    while pos > 0:
        if size - pos >= _MAX_BYTES:
            raise _TooLarge
        step = min(_CHUNK_BYTES, pos)
        pos -= step
        handle.seek(pos)
        buf = handle.read(step) + buf
        parts = buf.split(b"\n")
        buf = parts[0]
        yield from reversed(parts[1:])
    yield buf


def _blocks(message: object) -> list[object]:
    """A message's content as blocks; a plain string becomes one text block."""
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return content if isinstance(content, list) else []


def _is_human_prompt(message: object) -> bool:
    """A user message that is a typed prompt: a string, or text blocks and no tool_result."""
    blocks = _blocks(message)
    if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in blocks):
        return False
    return any(isinstance(b, dict) and b.get("type") == "text" for b in blocks)


def _walk(lines: Iterator[bytes], tool_use_id: str | None) -> bool | None:
    """Walk newest to oldest; True on reply text, False on a boundary, None when neither."""
    newest_assistant = True
    for raw in lines:
        if not raw.strip():
            continue
        try:
            entry = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError:
            continue  # a garbage line, or the cut-off first line of the file
        if not isinstance(entry, dict):
            continue
        if entry.get("isSidechain") or entry.get("isMeta") or entry.get("isCompactSummary"):
            continue
        kind = entry.get("type")
        if kind == "assistant":
            first = newest_assistant
            newest_assistant = False
            for block in reversed(_blocks(entry.get("message"))):
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text":
                    text = block.get("text")
                    if isinstance(text, str) and text.strip():
                        return True
                elif block.get("type") == "tool_use" and block.get("name") in POPUP_TOOLS:
                    # The pop-up being checked may already be on disk: skip it.
                    if tool_use_id is not None:
                        if block.get("id") == tool_use_id:
                            continue
                    elif first:
                        continue
                    return False  # an earlier, already answered pop-up
        elif kind == "user" and _is_human_prompt(entry.get("message")):
            return False
    return None


def reply_text_since_last_prompt(
    transcript_path: str, tool_use_id: str | None = None
) -> bool | None:
    """Report whether the assistant wrote reply text since the user's last prompt.

    The walk also stops at an earlier pop-up, which the user already answered.

    :param transcript_path: Claude's JSONL transcript, e.g.
        ``"~/.claude/projects/-x/abc.jsonl"`` (from the hook payload).
    :param tool_use_id: The id of the pop-up call being checked, e.g.
        ``"toolu_01abc"``; its own tool_use block is not a boundary. When absent,
        pop-up blocks in the newest assistant message are skipped instead.
    :returns: ``True`` when a visible text block follows the last boundary,
        ``False`` when none does, ``None`` when the file cannot be read, holds no
        boundary within the 16 MiB read cap, or anything else goes wrong (unknown,
        so no policy should act on it).
    """
    try:
        path = Path(transcript_path)
        size = path.stat().st_size
        with path.open("rb") as handle:
            return _walk(_reverse_lines(handle, size), tool_use_id)
    except _TooLarge:
        return None
    except Exception:  # noqa: BLE001 (a broken guard must never block a pop-up)
        return None
