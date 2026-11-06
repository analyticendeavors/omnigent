"""Observers of session turn edges: running, idle (completed), failed, interrupted.

A small registry the server calls at the points where a session's turn state
changes: every :func:`omnigent.server.routes._sessions.helpers._publish_status`
call, every interrupt, and the claude-native forwarder's ``Stop`` hook edge (an
``external_session_status`` ``idle`` carrying ``turn_completed=True``). That
last flag is neither stored nor published on the ``session.status`` stream, so
a module that must know a real turn ended (not a PTY-quiet guess) has nowhere
else to hook.

Observers run inline and synchronously, each wrapped so whatever it raises is
logged and dropped. They must be O(1) and must never block: ``_publish_status``
runs on the request path and sometimes off the event loop, so an observer may
be called from a worker thread and must guard its own state with a lock.

The registry is process-local, like :mod:`omnigent.server.item_observers`,
and empty until something registers. It imports nothing from
``omnigent.server`` so any module can import it without a cycle.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass

_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class TurnEdge:
    """One turn-state edge of a session.

    :param session_id: The conversation id, e.g. ``"conv_abc123"``.
    :param status: ``running``, ``waiting``, ``idle``, ``failed`` or ``interrupted``.
    :param response_id: The response id the edge carried, if any.
    :param turn_completed: ``True`` only for the Stop hook's idle edge.
    """

    session_id: str
    status: str
    response_id: str | None = None
    turn_completed: bool = False


TurnEdgeObserver = Callable[[TurnEdge], None]

_observers: list[TurnEdgeObserver] = []


def register_turn_edge_observer(fn: TurnEdgeObserver) -> None:
    """Add *fn* to the observers called on every edge; registering twice is a no-op."""
    if fn not in _observers:
        _observers.append(fn)


def unregister_turn_edge_observer(fn: TurnEdgeObserver) -> None:
    """Remove *fn*; an unknown callable is ignored."""
    if fn in _observers:
        _observers.remove(fn)


def reset_turn_edge_observers() -> None:
    """Drop every observer (tests)."""
    _observers.clear()


def notify_turn_edge(
    session_id: str,
    status: str,
    *,
    response_id: str | None = None,
    turn_completed: bool = False,
) -> None:
    """Hand one edge to every observer; an observer's failure never reaches the caller."""
    if not _observers:
        return
    edge = TurnEdge(session_id, status, response_id, turn_completed)
    for observer in list(_observers):
        try:
            observer(edge)
        except Exception:  # noqa: BLE001 — an observer must never break a status publish
            name = getattr(observer, "__qualname__", None) or repr(observer)
            _log.exception("turn edge observer %s failed for session=%s", name, session_id)


__all__ = [
    "TurnEdge",
    "TurnEdgeObserver",
    "notify_turn_edge",
    "register_turn_edge_observer",
    "reset_turn_edge_observers",
    "unregister_turn_edge_observer",
]
