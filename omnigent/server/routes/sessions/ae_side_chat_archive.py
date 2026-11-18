"""Archive and restore a session's side chats together with the session.

A side chat is a fork created with ``side_chat: true``. The session list hides
it, so it only shows as a Workspace-rail tab of its parent. Archiving the
parent used to leave those side chats unarchived and running, invisible yet
still counted as working. Archiving now walks the side chats (nested ones
included), archives each and defers its runner teardown the same way the
parent's is deferred. Each one archived this way carries
``ae.side_chat.archived_with`` naming the root session, so Undo on the parent
restores exactly those and never a side chat the user archived by hand.

Every archive path (UI, Undo, auto-archive, a runner closing its session) goes
through the session PATCH route, so the route is the one place that calls this.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy import select

from omnigent.db.db_models import SqlConversationLabel, current_workspace_id
from omnigent.stores.conversation_store import SIDE_CHAT_SOURCE_LABEL_KEY

_logger = logging.getLogger(__name__)

SIDE_CHAT_ARCHIVED_WITH_LABEL_KEY = "ae.side_chat.archived_with"

# Side chats of side chats are legal; the cap keeps a corrupt cycle finite.
_MAX_DEPTH = 8


def side_chat_ids(conversation_store: Any, source_id: str) -> list[str]:
    """Return the ids of the side chats forked from *source_id*.

    One indexed query on the label table. A store that is not the SQLAlchemy
    one has no label table to query, so it reports no side chats.

    :param conversation_store: The conversation store.
    :param source_id: The session whose side chats to find, e.g. ``"conv_abc"``.
    :returns: Side chat conversation ids, possibly empty.
    """
    session_maker = getattr(conversation_store, "_conv_session", None)
    if session_maker is None:
        _logger.debug("Side chat lookup skipped: store has no label table")
        return []
    with session_maker("select_side_chat_ids") as session:
        rows = session.execute(
            select(SqlConversationLabel.conversation_id).where(
                SqlConversationLabel.workspace_id == current_workspace_id(),
                SqlConversationLabel.key == SIDE_CHAT_SOURCE_LABEL_KEY,
                SqlConversationLabel.value == source_id,
            )
        ).scalars()
        return list(rows)


def _archive_one(conversation_store: Any, side_id: str, root_id: str) -> bool:
    """Archive one side chat and mark it; ``False`` when it must be skipped."""
    conv = conversation_store.get_conversation(side_id)
    if conv is None or conv.archived:
        return False
    conversation_store.update_conversation_with_changes(side_id, archived=True)
    conversation_store.set_labels(side_id, {SIDE_CHAT_ARCHIVED_WITH_LABEL_KEY: root_id})
    return True


async def cascade_archive(
    session_id: str,
    conversation_store: Any,
    runner_router: Any,
    host_registry: Any,
) -> list[str]:
    """Archive the side chats of *session_id*, nested ones included.

    Breadth first, depth capped, cycle safe. A side chat already archived is
    skipped together with its subtree: it was handled when it was archived.
    Each side chat is best effort, so one failure never blocks the others or
    the archive of the parent. The worktree belongs to the parent, so the
    deferred stops never delete it.

    :param session_id: The session just archived.
    :param conversation_store: The conversation store.
    :param runner_router: Runner router for the deferred stop, or ``None``.
    :param host_registry: Host registry for the deferred stop, or ``None``.
    :returns: Ids of the side chats archived by this call.
    """
    from omnigent.server.routes import sessions as facade
    from omnigent.server.routes._sessions.orchestration import _spawn_archive_stop

    archived: list[str] = []
    seen = {session_id}
    level = [session_id]
    for _depth in range(_MAX_DEPTH):
        next_level: list[str] = []
        for parent_id in level:
            try:
                children = await asyncio.to_thread(side_chat_ids, conversation_store, parent_id)
            except Exception:  # best effort: the parent's archive already succeeded
                _logger.warning("Side chat lookup failed for %s", parent_id, exc_info=True)
                continue
            for side_id in children:
                if side_id in seen:
                    continue
                seen.add(side_id)
                try:
                    changed = await asyncio.to_thread(
                        _archive_one, conversation_store, side_id, session_id
                    )
                    if not changed:
                        continue
                    facade._prune_session_read_state(side_id)
                    _spawn_archive_stop(
                        side_id,
                        conversation_store,
                        runner_router,
                        host_registry,
                        delete_worktree=False,
                    )
                except Exception:  # best effort per side chat
                    _logger.warning("Archiving side chat %s failed", side_id, exc_info=True)
                    continue
                archived.append(side_id)
                next_level.append(side_id)
        if not next_level:
            break
        level = next_level
    return archived


def _restore_one(conversation_store: Any, side_id: str, root_id: str) -> bool:
    """Unarchive one side chat marked with *root_id*; ``False`` when not ours."""
    conv = conversation_store.get_conversation(side_id)
    if conv is None or not conv.archived:
        return False
    if conv.labels.get(SIDE_CHAT_ARCHIVED_WITH_LABEL_KEY) != root_id:
        return False
    conversation_store.update_conversation_with_changes(side_id, archived=False)
    conversation_store.delete_label(side_id, SIDE_CHAT_ARCHIVED_WITH_LABEL_KEY)
    return True


async def cascade_unarchive(session_id: str, conversation_store: Any) -> list[str]:
    """Restore the side chats that archiving *session_id* archived.

    Only side chats marked with this session as the archive root are restored;
    one the user archived by hand stays archived and its subtree is not
    walked. Best effort per side chat.

    :param session_id: The session just unarchived.
    :param conversation_store: The conversation store.
    :returns: Ids of the side chats restored.
    """
    from omnigent.server.routes import sessions as facade

    restored: list[str] = []
    seen = {session_id}
    level = [session_id]
    for _depth in range(_MAX_DEPTH):
        next_level: list[str] = []
        for parent_id in level:
            try:
                children = await asyncio.to_thread(side_chat_ids, conversation_store, parent_id)
            except Exception:  # best effort: the parent's unarchive already succeeded
                _logger.warning("Side chat lookup failed for %s", parent_id, exc_info=True)
                continue
            for side_id in children:
                if side_id in seen:
                    continue
                seen.add(side_id)
                try:
                    changed = await asyncio.to_thread(
                        _restore_one, conversation_store, side_id, session_id
                    )
                    if not changed:
                        continue
                    facade._cancel_pending_archive_stop(side_id)
                except Exception:  # best effort per side chat
                    _logger.warning("Restoring side chat %s failed", side_id, exc_info=True)
                    continue
                restored.append(side_id)
                next_level.append(side_id)
        if not next_level:
            break
        level = next_level
    return restored


async def clear_archived_with(session_id: str, conversation_store: Any) -> None:
    """Delete the archive-root marker on *session_id* (no-op when absent)."""
    try:
        await asyncio.to_thread(
            conversation_store.delete_label, session_id, SIDE_CHAT_ARCHIVED_WITH_LABEL_KEY
        )
    except Exception:  # best effort: a stale marker is harmless
        _logger.warning("Clearing archive marker on %s failed", session_id, exc_info=True)
