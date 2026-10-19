"""
Background activity counts for a sidebar session row.

A row's ``status`` reads ``running`` only while a turn runs (or a direct
child is busy). Once the turn ends, a session still waiting on background
shells or on child sessions looks the same as a finished one. These two
counts let the sidebar show that "waiting on background work" state, and
``session_turn_active`` and ``session_blocked_on`` let a row that is not open
tell its own turn from its children's, as the open chat does.

Both read in-memory indexes only, so building a full page of rows costs no
extra I/O: the child ids come from the one batched
``list_child_conversation_ids_by_parent`` query the list builder already
makes. Like the existing child status roll-up, the counts are as fresh as
this replica's relay caches.
"""

from __future__ import annotations

from omnigent.runtime import pending_elicitations
from omnigent.server.routes._sessions.common import (
    _session_background_task_count_cache,
    _session_blocked_on_cache,
    _session_status_cache,
)
from omnigent.server.routes._sessions.helpers import _session_status_from_cache

# Relay statuses that mean a child is still doing work; ``waiting`` covers a
# child parked on an approval. A child still booting has no relay status yet,
# so it counts from its first ``running`` edge, a few seconds later.
_BUSY_CHILD_STATUSES = frozenset({"running", "waiting"})


def session_background_task_count(session_id: str) -> int:
    """
    Return the background shells still running for a session.

    :param session_id: Session/conversation identifier, e.g. ``"conv_abc123"``.
    :returns: The tally from the last authoritative ``Stop`` hook report,
        ``0`` when none is running or none was reported.
    """
    return _session_background_task_count_cache.get(session_id, 0)


def session_active_child_count(child_session_ids: list[str]) -> int:
    """
    Count a session's direct children that are still busy.

    A child counts while its relay status is running or waiting, or while it
    has an approval prompt outstanding (a prompt can land before the child's
    status edge does). A failed child never counts.

    :param child_session_ids: Direct child ids of one session, e.g.
        ``["conv_child1", "conv_child2"]``.
    :returns: Number of busy direct children, ``0`` when there are none.
    """
    if not child_session_ids:
        return 0
    approvals = pending_elicitations.counts_for(child_session_ids)
    busy = 0
    for child_id in child_session_ids:
        status = _session_status_cache.get(child_id)
        if status in _BUSY_CHILD_STATUSES or (
            status != "failed" and approvals.get(child_id, 0) > 0
        ):
            busy += 1
    return busy


def session_turn_active(session_id: str, db_status: str | None, *, starting: bool) -> bool:
    """
    Return whether a session's own turn is running, ignoring its children.

    The list ``status`` reads ``running`` while any direct child is busy, so a
    row whose own turn ended but whose agents still work needs this to read
    as waiting on them.

    :param session_id: Session/conversation identifier, e.g. ``"conv_abc123"``.
    :param db_status: The row's persisted ``live_status``, used on a cache miss.
    :param starting: Whether a message is still waiting on the session's runner.
    :returns: ``True`` while the session's own turn runs or is starting.
    """
    return starting or _session_status_from_cache(session_id, db_status) == "running"


def session_blocked_on(session_id: str) -> str | None:
    """
    Return the dialog a running session is parked on, if any.

    :param session_id: Session/conversation identifier, e.g. ``"conv_abc123"``.
    :returns: The reason from the session's latest status edge, e.g.
        ``"input needed"``, or ``None`` when it is not parked.
    """
    return _session_blocked_on_cache.get(session_id)
