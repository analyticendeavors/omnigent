"""Show a claude-native chat as running when a prompt opens a turn the status file hides.

Claude Code's status file stays ``busy`` across a Stop while a background
helper is alive, so the next turn changes nothing in it and the poller
publishes no ``running``. The forwarder's prompt edge does arrive, but it
publishes no status. This module remembers that a prompt opened since the last
turn end; the first real work item (assistant text or a tool call) after it
flips the chat to ``running``. A Stop, a failure or an interrupt clears the
memory, so late items of an ended turn never flip it back and a blocked prompt
never leaves a stuck spinner.
"""

from __future__ import annotations

import threading
from collections import OrderedDict

# Most sessions remembered at once; the oldest is dropped past this.
MAX_TRACKED_SESSIONS = 1024

_lock = threading.Lock()
_open: OrderedDict[str, None] = OrderedDict()


def note_prompt(session_id: str) -> None:
    """Remember that a prompt opened a turn for *session_id*."""
    with _lock:
        _open[session_id] = None
        _open.move_to_end(session_id)
        while len(_open) > MAX_TRACKED_SESSIONS:
            _open.popitem(last=False)


def note_turn_end(session_id: str) -> None:
    """Forget the open prompt: the turn ended (Stop, failure or interrupt)."""
    with _lock:
        _open.pop(session_id, None)


def take_if_open(session_id: str) -> bool:
    """Return ``True`` once if a prompt is open, and clear it."""
    with _lock:
        return _open.pop(session_id, "absent") is None


def is_real_work(item_type: str, role: str | None = None) -> bool:
    """Whether an item is assistant text or a tool call, not a user or bookkeeping item."""
    return item_type == "function_call" or (item_type == "message" and role == "assistant")


def reset() -> None:
    """Drop all state (tests)."""
    with _lock:
        _open.clear()


__all__ = [
    "MAX_TRACKED_SESSIONS",
    "is_real_work",
    "note_prompt",
    "note_turn_end",
    "reset",
    "take_if_open",
]
