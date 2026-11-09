"""Whether a native Claude turn wrote visible reply text before a pop-up.

On 2026-11-09 a native chat raised an AskUserQuestion card ("Apply the proposed
copy from Rocky's message?") in a turn that wrote no text block at all: only a
redacted thinking block, a one-line summary and the tool call. The user saw the
card and nothing it referred to. The policy hook calls
:func:`reply_text_since_last_prompt` for a pop-up tool call and stamps the answer
on the call's arguments, where ``ae_omni_policies.popup_text`` reads it.
"""

from __future__ import annotations

import json
from pathlib import Path

#: How much of the transcript's tail to read; a turn's lines sit at the end.
_TAIL_BYTES = 2 * 1024 * 1024

#: Pop-up tools the flag is computed for.
POPUP_TOOLS = frozenset({"AskUserQuestion", "mcp__ae__ask_user"})

#: Key stamped on the tool call's ``arguments`` for the policy to read.
FLAG_KEY = "ae_reply_text_before"


def _blocks(message: object) -> list[object] | None:
    """Return a message's content as a list of blocks, or None for a plain string."""
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    if isinstance(content, list):
        return content
    return None


def _is_human_prompt(message: object) -> bool:
    """A user message that is a typed prompt, not only tool results."""
    if not isinstance(message, dict):
        return False
    content = message.get("content")
    if isinstance(content, str):
        return True
    if isinstance(content, list):
        return any(isinstance(b, dict) and b.get("type") == "text" for b in content)
    return False


def _has_visible_text(message: object) -> bool:
    """An assistant message with a text block holding non-whitespace text."""
    blocks = _blocks(message)
    if not blocks:
        return False
    return any(
        isinstance(b, dict)
        and b.get("type") == "text"
        and isinstance(b.get("text"), str)
        and b["text"].strip()
        for b in blocks
    )


def reply_text_since_last_prompt(transcript_path: str) -> bool | None:
    """Report whether the assistant wrote reply text since the user's last prompt.

    :param transcript_path: Claude's JSONL transcript, e.g.
        ``"~/.claude/projects/-x/abc.jsonl"`` (from the hook payload).
    :returns: ``True`` when a visible text block follows the last human prompt,
        ``False`` when none does, ``None`` when the file cannot be read or holds
        no human prompt in its tail (unknown, so no policy should act on it).
    """
    try:
        path = Path(transcript_path)
        size = path.stat().st_size
        with path.open("rb") as handle:
            if size > _TAIL_BYTES:
                handle.seek(size - _TAIL_BYTES)
            raw = handle.read()
    except (OSError, ValueError, TypeError):
        return None
    lines = raw.decode("utf-8", errors="replace").splitlines()
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue  # a garbage line, or the cut-off first line of the tail
        if not isinstance(entry, dict):
            continue
        if entry.get("isSidechain") or entry.get("isMeta") or entry.get("isCompactSummary"):
            continue
        kind = entry.get("type")
        if kind == "assistant":
            if _has_visible_text(entry.get("message")):
                return True
        elif kind == "user" and _is_human_prompt(entry.get("message")):
            return False
    return None
