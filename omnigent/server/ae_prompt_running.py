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
import time
from collections import OrderedDict
from collections.abc import Callable

# Most sessions remembered at once; the oldest is dropped past this.
MAX_TRACKED_SESSIONS = 1024

# A prompt open longer than this is dropped: a hook-blocked prompt must not be
# taken by an unrelated item much later.
OPEN_PROMPT_TTL_S = 600.0

_lock = threading.Lock()
_open: OrderedDict[str, float] = OrderedDict()
_clock: Callable[[], float] = time.monotonic


def note_prompt(session_id: str) -> None:
    """Remember that a prompt opened a turn for *session_id*."""
    with _lock:
        _open[session_id] = _clock()
        _open.move_to_end(session_id)
        while len(_open) > MAX_TRACKED_SESSIONS:
            _open.popitem(last=False)


def note_turn_end(session_id: str) -> None:
    """Forget the open prompt: the turn ended (Stop, failure or interrupt)."""
    with _lock:
        _open.pop(session_id, None)


def take_if_open(session_id: str) -> bool:
    """Return ``True`` once if a fresh prompt is open, and clear it."""
    with _lock:
        opened = _open.pop(session_id, None)
        return opened is not None and _clock() - opened <= OPEN_PROMPT_TTL_S


def is_real_work(item_type: str, role: str | None = None) -> bool:
    """Whether an item is assistant text or a tool call, not a user or bookkeeping item."""
    return item_type == "function_call" or (item_type == "message" and role == "assistant")


def reset(clock: Callable[[], float] | None = None) -> None:
    """Drop all state and set the clock (tests)."""
    global _clock
    with _lock:
        _open.clear()
        _clock = clock or time.monotonic


__all__ = [
    "MAX_TRACKED_SESSIONS",
    "OPEN_PROMPT_TTL_S",
    "is_real_work",
    "note_prompt",
    "note_turn_end",
    "reset",
    "take_if_open",
]
