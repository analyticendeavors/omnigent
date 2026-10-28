"""Observers of elicitation verdicts the server accepts.

A small registry :func:`~omnigent.server.routes._sessions.orchestration._resolve_elicitation`
calls at the top of every verdict, whichever route delivered it (the ``approval``
event on ``POST /v1/sessions/{id}/events`` or ``POST .../elicitations/{eid}/resolve``).
A resolved elicitation persists no conversation item, so the item-observers
registry never sees it; a module that wants to react to an answer (to tell an
idle parent that its child resumed, say) has nowhere else to hook.

The pending prompt is read from :mod:`omnigent.runtime.pending_elicitations` at
notify time, before the resolution clears it, and handed to each observer; it is
``None`` when nothing was pending for that session and id (a repeat or bogus
verdict). Observers are fire-and-forget, as in :mod:`omnigent.server.item_observers`:
a sync one runs on a worker thread, an async one as a task on the running loop,
and whatever either raises is logged and dropped. The registry is process-local
and empty until something registers.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Callable
from typing import Any

from omnigent.runtime import pending_elicitations

_log = logging.getLogger(__name__)

ElicitationObserver = Callable[[str, str, dict[str, Any], dict[str, Any] | None], Any]

_observers: list[ElicitationObserver] = []
# Strong references to in-flight observer tasks: the loop keeps only weak ones.
# custom-lint: disable-next=workspace-scoped-cache -- task objects are globally unique
_pending: set[asyncio.Task[None]] = set()


def register_elicitation_observer(fn: ElicitationObserver) -> None:
    """Add *fn*; registering the same callable twice is a no-op.

    :param fn: ``fn(session_id, elicitation_id, data, pending)``, sync or async.
        ``data`` is the verdict payload (``action``, optional ``content``);
        ``pending`` is the prompt's ``response.elicitation_request`` event, or
        ``None`` when the id was not pending on that session.
    """
    if fn not in _observers:
        _observers.append(fn)


def unregister_elicitation_observer(fn: ElicitationObserver) -> None:
    """Remove *fn*; an unknown callable is ignored."""
    if fn in _observers:
        _observers.remove(fn)


def reset_elicitation_observers() -> None:
    """Drop every observer and forget in-flight tasks (tests)."""
    _observers.clear()
    _pending.clear()


def notify_elicitation_resolved(session_id: str, data: dict[str, Any]) -> None:
    """Hand a verdict to every observer without waiting for any.

    Never raises into the request. Must run on the event loop; with no loop the
    observers are skipped with a warning.

    :param session_id: Session the verdict was delivered under, e.g. ``"conv_abc123"``.
    :param data: The verdict payload carrying ``elicitation_id``, e.g.
        ``{"elicitation_id": "elicit_abc", "action": "accept"}``.
    """
    if not _observers:
        return
    try:
        elicitation_id = data.get("elicitation_id")
        if not isinstance(elicitation_id, str) or not elicitation_id:
            return
        found = pending_elicitations.lookup(elicitation_id)
        pending = found[1] if found is not None and found[0] == session_id else None
        loop = asyncio.get_running_loop()
        for observer in list(_observers):
            task = loop.create_task(_run(observer, session_id, elicitation_id, data, pending))
            _pending.add(task)
            task.add_done_callback(_pending.discard)
    except Exception:  # noqa: BLE001 (an observer hook must never break the resolve)
        _log.exception("elicitation observers could not be notified for session=%s", session_id)


async def drain_elicitation_observers() -> None:
    """Wait for every in-flight observer task to finish (tests and shutdown)."""
    while True:
        _pending.difference_update([task for task in _pending if task.done()])
        if not _pending:
            return
        await asyncio.gather(*list(_pending), return_exceptions=True)


async def _run(
    observer: ElicitationObserver,
    session_id: str,
    elicitation_id: str,
    data: dict[str, Any],
    pending: dict[str, Any] | None,
) -> None:
    """Run one observer off the request path and log anything it raises."""
    try:
        if inspect.iscoroutinefunction(observer):
            await observer(session_id, elicitation_id, data, pending)
        else:
            result = await asyncio.to_thread(observer, session_id, elicitation_id, data, pending)
            if inspect.isawaitable(result):
                await result
    except Exception:  # noqa: BLE001 (an observer must never break the resolve)
        name = getattr(observer, "__qualname__", None) or repr(observer)
        _log.exception("elicitation observer %s failed for session=%s", name, session_id)


__all__ = [
    "ElicitationObserver",
    "drain_elicitation_observers",
    "notify_elicitation_resolved",
    "register_elicitation_observer",
    "reset_elicitation_observers",
    "unregister_elicitation_observer",
]
