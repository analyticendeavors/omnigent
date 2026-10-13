"""Host-connect observers and the server-side resume of an interrupted session.

A host restart kills every runner it spawned; the host comes back with new
runner ids, so the reconnect path in ``app._on_runner_connect`` (keyed by the
old runner id) never revisits the sessions that were mid-turn. They stay
``failed`` with ``runner_disconnected`` until someone clicks Resume.

- **The seam.** :func:`notify_host_connected` runs each registered observer as
  a background task after a host tunnel registers, so a slow observer never
  holds the host handshake. Whatever an observer raises is logged and dropped.
- **The resume.** :func:`resume_interrupted_session` is the Resume button's
  recovery (``retry_session``) for a caller with no request, with
  ``resume_interrupted_turn`` set so the relaunched runner continues the turn
  it lost instead of waiting idle.

Which sessions to resume is left to whoever registers an observer.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

_logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class HostConnectEvent:
    """One host tunnel registering, as host-connect observers see it.

    :param host_id: The host that connected.
    :param owner: The host's owner, or ``None`` in single-user mode.
    :param app_state: The server's ``app.state`` (registries and settings).
    :param conversation_store: The server's conversation store.
    """

    host_id: str
    owner: str | None
    app_state: Any
    conversation_store: Any


HostConnectObserver = Callable[[HostConnectEvent], Awaitable[None]]

_observers: list[HostConnectObserver] = []
# custom-lint: disable-next=workspace-scoped-cache -- holds task objects, globally unique
_pending: set[asyncio.Task[None]] = set()


def register_host_connect_observer(fn: HostConnectObserver) -> None:
    """Add async *fn* to the observers run after every host connect (idempotent)."""
    if fn not in _observers:
        _observers.append(fn)


def unregister_host_connect_observer(fn: HostConnectObserver) -> None:
    """Remove *fn*; an unknown callable is ignored."""
    if fn in _observers:
        _observers.remove(fn)


def registered_host_connect_observers() -> list[HostConnectObserver]:
    """The observers currently registered, in registration order (a copy)."""
    return list(_observers)


async def _run_observers(event: HostConnectEvent) -> None:
    for observer in list(_observers):
        try:
            await observer(event)
        except Exception:
            name = getattr(observer, "__qualname__", None) or repr(observer)
            _logger.exception("host-connect observer %s failed for host %s", name, event.host_id)


def notify_host_connected(
    app_state: Any, conversation_store: Any, host_id: str, owner: str | None
) -> None:
    """Schedule every observer for *host_id* in the background; never raises."""
    if not _observers:
        return
    event = HostConnectEvent(
        host_id=host_id, owner=owner, app_state=app_state, conversation_store=conversation_store
    )
    task = asyncio.get_running_loop().create_task(
        _run_observers(event), name=f"host-connect-observers-{host_id}"
    )
    _pending.add(task)
    task.add_done_callback(_pending.discard)


async def resume_interrupted_session(
    app_state: Any, conversation_store: Any, session_id: str
) -> dict[str, bool | str]:
    """Relaunch *session_id*'s runner and continue its interrupted turn.

    The same recovery as ``POST /v1/sessions/{id}/events`` with
    ``retry_session``, minus the request and the permission check: the caller
    owns that decision.

    :raises OmnigentError: When the session is missing or no runner is available.
    """
    from omnigent.server.routes.sessions.routes_events import (
        _recover_retry_session,
        get_server_runner_router,
    )

    request = SimpleNamespace(app=SimpleNamespace(state=app_state))
    return await _recover_retry_session(
        request=request,  # type: ignore[arg-type]
        session_id=session_id,
        conversation_store=conversation_store,
        runner_router=get_server_runner_router(),
        resume_interrupted_turn=True,
    )
