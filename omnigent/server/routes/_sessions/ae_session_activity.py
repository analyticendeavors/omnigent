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

A closed (archived) child never counts. ``sys_session_close`` archives the
child, and a child still marked running when that happened used to keep its
parent's badge lit for hours. The list builders now ask
``list_child_conversation_ids_by_parent`` to leave archived children out (the
flag sits on the row that query already reads), and ``settle_archived_session``
drops a closed session's busy status, cache and stored ``live_status``, once
the archive teardown runs.
"""

from __future__ import annotations

import logging
from typing import Literal

from omnigent.runtime import pending_elicitations
from omnigent.server.routes._sessions.common import (
    _session_background_task_count_cache,
    _session_blocked_on_cache,
    _session_status_cache,
)

_logger = logging.getLogger(__name__)

# Relay statuses that mean a child is still doing work; ``waiting`` covers a
# child parked on an approval. A child still booting has no relay status yet,
# so it counts from its first ``running`` edge, a few seconds later.
_BUSY_CHILD_STATUSES = frozenset({"running", "waiting"})


def settle_archived_session(session_id: str, persisted_status: str | None = None) -> bool:
    """
    Publish idle for an archived session that is still marked running or waiting.

    Runs from the archive teardown, after the best-effort stop, so the stop
    had its chance to end the turn the normal way. A closed sub-agent whose
    runner is gone never sends that idle edge, and its busy mark would
    otherwise count toward the parent's badge and read ``running`` on
    ``GET /v1/sessions/{id}`` for good. ``failed`` is left alone, and the
    Claude subagent staleness check (patch 0125) is cancelled, since the
    session is settled here.

    :param session_id: Archived session/conversation identifier.
    :param persisted_status: The row's stored ``live_status``, read when this
        replica's cache has no entry (a restart emptied it), e.g. ``"running"``.
    :returns: Whether an idle edge was published. Best-effort: a failure
        logs and returns ``False``, so the rest of the teardown still runs.
    """
    from omnigent.server.ae_subagent_liveness import cancel_stale_timer
    from omnigent.server.routes._sessions.helpers import _publish_status

    try:
        if _session_status_cache.get(session_id, persisted_status) not in _BUSY_CHILD_STATUSES:
            return False
        cancel_stale_timer(session_id)
        _publish_status(session_id, "idle")
        return True
    except Exception:  # noqa: BLE001 (archive teardown steps are all best-effort)
        _logger.warning("Could not settle archived session %s", session_id, exc_info=True)
        return False


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
    status edge does). A failed child never counts. Archived (closed)
    children are left out by the caller's child-id query.

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


def session_turn_active(
    own_status: Literal["idle", "running", "failed"], *, starting: bool
) -> bool:
    """
    Return whether a session's own turn is running, ignoring its children.

    The list ``status`` reads ``running`` while any direct child is busy, so a
    row whose own turn ended but whose agents still work needs this to read
    as waiting on them.

    :param own_status: The session's own list status, without the child
        roll-up, e.g. ``"idle"``.
    :param starting: Whether a message is still waiting on the session's runner.
    :returns: ``True`` while the session's own turn runs or is starting.
    """
    return starting or own_status == "running"


def session_blocked_on(session_id: str) -> str | None:
    """
    Return the dialog a running session is parked on, if any.

    Served only while the session's cached status is still running or
    waiting, so a status change that bypassed the publish path cannot leave
    a row parked on a dialog that is gone.

    :param session_id: Session/conversation identifier, e.g. ``"conv_abc123"``.
    :returns: The reason from the session's latest status edge, e.g.
        ``"input needed"``, or ``None`` when it is not parked.
    """
    if _session_status_cache.get(session_id) not in ("running", "waiting"):
        return None
    return _session_blocked_on_cache.get(session_id)
