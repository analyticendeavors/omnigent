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
from collections.abc import Callable
from typing import Any

from sqlalchemy import select

from omnigent.db.db_models import SqlConversationLabel, current_workspace_id
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.stores.conversation_store import SIDE_CHAT_SOURCE_LABEL_KEY

_logger = logging.getLogger(__name__)

SIDE_CHAT_ARCHIVED_WITH_LABEL_KEY = "ae.side_chat.archived_with"

_ARCHIVED_SOURCE_MESSAGE = "This chat is archived. Unarchive it to open a side chat."

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
        global _warned_no_label_table
        if not _warned_no_label_table:
            _warned_no_label_table = True
            _logger.warning(
                "Side chat archive cascade is inactive: the conversation store has no "
                "_conv_session (an upstream rename?)"
            )
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


# Decides whether the caller owns a session; ``None`` means every session is
# owned (auth disabled, no permission store).
OwnerCheck = Callable[[str], bool]

_warned_no_label_table = False


def make_owner_check(
    user_id: str | None,
    permission_store: Any,
    conversation_store: Any,
) -> OwnerCheck | None:
    """Build the ownership test the PATCH route applies to the session itself.

    A side chat the caller does not own (a reader of a shared session can fork
    one that only they own) is never archived or restored on their behalf.

    :param user_id: The authenticated user, or ``None`` when auth is off.
    :param permission_store: The permission store, ``None`` when permissions
        are disabled.
    :param conversation_store: The conversation store.
    :returns: A predicate over session ids, or ``None`` when every session counts
        as owned.
    """
    if permission_store is None:
        return None
    from omnigent.server.permissions import LEVEL_OWNER, check_session_access

    def owns(session_id: str) -> bool:
        return check_session_access(
            user_id, session_id, LEVEL_OWNER, permission_store, conversation_store
        )

    return owns


def refuse_side_chat_of_archived(source: Any, side_chat: bool) -> None:
    """Refuse a side chat forked from an archived session.

    Added 2026-11-18: the archive cascade runs only when the source is archived,
    so a side chat opened later would keep running unseen with nothing to stop
    it. Unarchiving the source first keeps it under the cascade.

    :param source: The source conversation row.
    :param side_chat: Whether the fork request asks for a side chat.
    :raises OmnigentError: When a side chat is asked of an archived source.
    """
    if side_chat and getattr(source, "archived", False):
        raise OmnigentError(
            _ARCHIVED_SOURCE_MESSAGE,
            code=ErrorCode.INVALID_INPUT,
        )


async def archive_side_chat_if_source_archived(
    side_id: str,
    source_id: str,
    conversation_store: Any,
    runner_router: Any,
    host_registry: Any,
) -> None:
    """Close the race between opening a side chat and archiving its source.

    Runs after the fork row is committed. The archive cascade reads the side
    chats only after the archive commits, so either it already sees this fork,
    or this re-read sees the source archived; then the new side chat is archived
    under the same root (so Undo restores it), stopped like the others, and the
    request is refused as the pre-check would have refused it. Added 2026-11-18.

    :param side_id: The side chat just created.
    :param source_id: Its source session.
    :param conversation_store: The conversation store.
    :param runner_router: Runner router for the deferred stop, or ``None``.
    :param host_registry: Host registry for the deferred stop, or ``None``.
    :raises OmnigentError: When the source is archived by now.
    """
    from omnigent.server.routes._sessions.orchestration import _spawn_archive_stop

    source = await asyncio.to_thread(conversation_store.get_conversation, source_id)
    if source is None or not source.archived:
        return
    root_id = source.labels.get(SIDE_CHAT_ARCHIVED_WITH_LABEL_KEY) or source_id
    if await asyncio.to_thread(_archive_one, conversation_store, side_id, root_id, None) == (
        "archived"
    ):
        _spawn_archive_stop(
            side_id, conversation_store, runner_router, host_registry, delete_worktree=False
        )
    raise OmnigentError(_ARCHIVED_SOURCE_MESSAGE, code=ErrorCode.INVALID_INPUT)


def _owned(owns: OwnerCheck | None, side_id: str) -> bool:
    return owns is None or owns(side_id)


def _load_owned(conversation_store: Any, side_id: str, owns: OwnerCheck | None) -> Any:
    """The side chat row when it exists and the caller owns it, else ``None``.

    A failed read or ownership check also gives ``None``: the walk descends only
    below a node whose ownership was established, never past an unknown one.
    """
    try:
        conv = conversation_store.get_conversation(side_id)
        if conv is None or not _owned(owns, side_id):
            return None
    except Exception:  # unknown owner: prune rather than guess
        _logger.warning("Side chat %s lookup or ownership check failed", side_id, exc_info=True)
        return None
    return conv


def _archive_one(
    conversation_store: Any, side_id: str, root_id: str, owns: OwnerCheck | None
) -> str:
    """Archive one side chat and mark it.

    :returns: ``"skip"`` (missing or not owned: prune its subtree),
        ``"present"`` (already archived: keep walking, change nothing) or
        ``"archived"``.
    """
    conv = _load_owned(conversation_store, side_id, owns)
    if conv is None:
        return "skip"
    if conv.archived:
        return "present"
    # Marker first: a crash between the writes leaves a stale marker on an
    # unarchived chat (harmless, restore needs ``archived``), never an archived
    # chat Undo cannot find.
    conversation_store.set_labels(side_id, {SIDE_CHAT_ARCHIVED_WITH_LABEL_KEY: root_id})
    try:
        conversation_store.update_conversation_with_changes(side_id, archived=True)
    except Exception:
        try:
            conversation_store.delete_label(side_id, SIDE_CHAT_ARCHIVED_WITH_LABEL_KEY)
        except Exception:  # best effort: the original failure is what matters
            _logger.debug("Marker cleanup on %s failed", side_id, exc_info=True)
        raise
    return "archived"


def _root_archived(conversation_store: Any, root_id: str) -> bool:
    conv = conversation_store.get_conversation(root_id)
    return conv is not None and bool(conv.archived)


async def cascade_archive(
    session_id: str,
    conversation_store: Any,
    runner_router: Any,
    host_registry: Any,
    owns: OwnerCheck | None = None,
) -> list[str]:
    """Archive the side chats of *session_id*, nested ones included.

    Breadth first, depth capped, cycle safe. The walk goes through every side
    chat whatever its state, so a descendant is archived even when its parent
    was archived or restored by hand. A side chat the caller does not own is
    skipped together with its subtree. Each side chat is best effort, so one
    failure never blocks the others or the archive of the parent. The worktree
    belongs to the parent, so the deferred stops never delete it.

    An Undo that lands while this runs (here or on another replica) is honoured:
    the root is re-read before each archive and once after the walk, and
    whatever this call archived is restored if the root is no longer archived.

    :param session_id: The session just archived.
    :param conversation_store: The conversation store.
    :param runner_router: Runner router for the deferred stop, or ``None``.
    :param host_registry: Host registry for the deferred stop, or ``None``.
    :param owns: Ownership test from :func:`make_owner_check`, or ``None``.
    :returns: Ids of the side chats archived by this call that stayed archived.
    """
    from omnigent.server.routes import sessions as facade
    from omnigent.server.routes._sessions.orchestration import _spawn_archive_stop

    archived: list[str] = []
    seen = {session_id}
    level = [session_id]
    undone = False
    halted = False
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
                    root_still_archived = await asyncio.to_thread(
                        _root_archived, conversation_store, session_id
                    )
                except Exception:  # cannot tell whether an Undo landed: stop here
                    _logger.warning(
                        "Root re-read failed for %s; stopping the side chat walk",
                        session_id,
                        exc_info=True,
                    )
                    halted = True
                    break
                if not root_still_archived:
                    undone = True
                    break
                try:
                    outcome = await asyncio.to_thread(
                        _archive_one, conversation_store, side_id, session_id, owns
                    )
                    if outcome == "skip":
                        continue
                    if outcome == "archived":
                        facade._prune_session_read_state(side_id)
                        _spawn_archive_stop(
                            side_id,
                            conversation_store,
                            runner_router,
                            host_registry,
                            delete_worktree=False,
                        )
                        archived.append(side_id)
                except Exception:  # best effort per side chat
                    # Ownership was established (a failed check returns "skip"), so a
                    # failed write still walks its children, each checked on its own.
                    _logger.warning("Archiving side chat %s failed", side_id, exc_info=True)
                next_level.append(side_id)
            if undone or halted:
                break
        if undone or halted or not next_level:
            break
        level = next_level
    try:
        if undone or not await asyncio.to_thread(_root_archived, conversation_store, session_id):
            if archived:
                _logger.info("Undo raced the side chat archive of %s; reverting", session_id)
                await cascade_unarchive(session_id, conversation_store, owns)
            return []
    except Exception:
        _logger.warning("Undo re-check failed for %s", session_id, exc_info=True)
    return archived


def _restore_one(
    conversation_store: Any, side_id: str, root_id: str, owns: OwnerCheck | None
) -> str:
    """Unarchive one side chat marked with *root_id*.

    :returns: ``"skip"`` (missing or not owned: prune), ``"present"`` (not ours:
        keep walking) or ``"restored"``.
    """
    conv = _load_owned(conversation_store, side_id, owns)
    if conv is None:
        return "skip"
    if not conv.archived or conv.labels.get(SIDE_CHAT_ARCHIVED_WITH_LABEL_KEY) != root_id:
        return "present"
    # Flag first, then marker: a stale marker on an unarchived chat is harmless.
    conversation_store.update_conversation_with_changes(side_id, archived=False)
    conversation_store.delete_label(side_id, SIDE_CHAT_ARCHIVED_WITH_LABEL_KEY)
    return "restored"


async def cascade_unarchive(
    session_id: str,
    conversation_store: Any,
    owns: OwnerCheck | None = None,
) -> list[str]:
    """Restore the side chats that archiving *session_id* archived.

    Only side chats that are archived and marked with this session as the
    archive root are restored; one the user archived by hand stays archived.
    The walk still goes through such nodes, so a marked descendant below them is
    restored. A side chat the caller does not own is skipped with its subtree.
    Best effort per side chat.

    :param session_id: The session just unarchived.
    :param conversation_store: The conversation store.
    :param owns: Ownership test from :func:`make_owner_check`, or ``None``.
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
                    outcome = await asyncio.to_thread(
                        _restore_one, conversation_store, side_id, session_id, owns
                    )
                    if outcome == "skip":
                        continue
                    if outcome == "restored":
                        facade._cancel_pending_archive_stop(side_id)
                        restored.append(side_id)
                except Exception:  # best effort per side chat
                    # Still walk its children, as the archive walk does.
                    _logger.warning("Restoring side chat %s failed", side_id, exc_info=True)
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
