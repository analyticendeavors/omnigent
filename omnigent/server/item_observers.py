"""Observers of conversation items the server persists.

A small registry the server calls after it appends conversation items on
behalf of a harness: the native transcript bridge
(``_persist_external_conversation_item`` in
:mod:`omnigent.server.routes._sessions.orchestration`) and the runner relay's
assistant text flush (``_flush_relay_text`` in
:mod:`omnigent.server.routes._sessions.helpers`). Those are the two paths
through which a harness's own turns become durable items without reaching
the ``response`` policy phase, so a module that wants to read what the
assistant wrote (to set session labels from it, say) has nowhere else to hook.

Observers are fire-and-forget. :func:`notify_items_persisted` never raises
into the request that persisted the items and never waits for an observer: a
sync observer runs on a worker thread, an async one as a task on the running
loop, and whatever either raises is logged and dropped. The registry is
process-local, like :mod:`omnigent.runtime.session_stream`, and empty until
something registers.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Callable, Sequence
from typing import Any

from omnigent.entities.conversation import ConversationItem

_log = logging.getLogger(__name__)

ItemObserver = Callable[[str, Sequence[ConversationItem]], Any]

_observers: list[ItemObserver] = []
# Strong references to in-flight observer tasks: the loop keeps only weak
# ones, so a task referenced nowhere else could be collected mid-flight.
_pending: set[asyncio.Task[None]] = set()


def register_item_observer(fn: ItemObserver) -> None:
    """Add *fn* to the observers called after every persisted batch.

    Registering the same callable twice is a no-op, so a module that
    registers at import time survives a re-import.

    :param fn: ``fn(session_id, items)``, sync or async. A sync observer runs
        on a worker thread, so it may do store I/O. Exceptions are logged,
        never raised into the request.
    """
    if fn not in _observers:
        _observers.append(fn)


def unregister_item_observer(fn: ItemObserver) -> None:
    """Remove *fn*; an unknown callable is ignored."""
    if fn in _observers:
        _observers.remove(fn)


def registered_item_observers() -> list[ItemObserver]:
    """The observers currently registered, in registration order (a copy)."""
    return list(_observers)


def reset_item_observers() -> None:
    """Drop every observer and forget in-flight tasks (tests)."""
    _observers.clear()
    _pending.clear()


def notify_items_persisted(session_id: str, items: Sequence[ConversationItem]) -> None:
    """Hand a freshly persisted batch to every observer without waiting for any.

    Must be called from a running event loop (both call sites are async
    route helpers); with no loop the observers are skipped with a warning
    rather than run on the caller's thread.

    :param session_id: The conversation the items belong to, e.g. ``"conv_abc123"``.
    :param items: The persisted items, ids assigned. An empty batch notifies nobody.
    """
    if not items or not _observers:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        _log.warning("notify_items_persisted called outside an event loop; observers skipped")
        return
    batch = list(items)
    for observer in list(_observers):
        task = loop.create_task(_run(observer, session_id, batch))
        _pending.add(task)
        task.add_done_callback(_pending.discard)


async def drain_item_observers() -> None:
    """Wait for every in-flight observer task to finish (tests and shutdown)."""
    while _pending:
        await asyncio.gather(*list(_pending), return_exceptions=True)


async def _run(observer: ItemObserver, session_id: str, items: list[ConversationItem]) -> None:
    """Run one observer off the request path and log anything it raises."""
    try:
        if inspect.iscoroutinefunction(observer):
            await observer(session_id, items)
        else:
            result = await asyncio.to_thread(observer, session_id, items)
            if inspect.isawaitable(result):
                await result
    except Exception:  # noqa: BLE001 — an observer must never break the persist
        name = getattr(observer, "__qualname__", None) or repr(observer)
        _log.exception("item observer %s failed for session=%s", name, session_id)


__all__ = [
    "ItemObserver",
    "drain_item_observers",
    "notify_items_persisted",
    "register_item_observer",
    "registered_item_observers",
    "reset_item_observers",
    "unregister_item_observer",
]
