"""User-id columns the accounts → OIDC remap must also rewrite.

:func:`omnigent.server.identity_migration.remap_identities` repoints grants,
comments, policies, tokens and hosts. A deployment that has been in use also
carries the user id on its agents, projects, schedules, device grants,
conversation items, preferences, connections, daily costs and the turn-actor
label; without these the renamed user loses their projects, schedules and
history attribution. This module rewrites them inside the same transaction.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, cast

from sqlalchemy import inspect, select, update
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from omnigent.db.db_models import (
    SqlAgent,
    SqlConnection,
    SqlConversationItem,
    SqlConversationLabel,
    SqlDeviceGrant,
    SqlPreference,
    SqlProject,
    SqlScheduledTask,
    SqlUserDailyCost,
    current_workspace_id,
)

# Mirrors ``_TURN_ACTOR_LABEL`` in ``omnigent.server.routes._sessions.common``;
# importing the routes package from here would pull the whole server in.
TURN_ACTOR_LABEL = "omnigent.turn_actor"

# Plain reference columns with no uniqueness: one bulk UPDATE each.
_BULK_COLUMNS: tuple[tuple[Any, str], ...] = (
    (SqlAgent, "created_by"),
    (SqlDeviceGrant, "user_id"),
    (SqlProject, "user_id"),
    (SqlConversationItem, "created_by"),
    (SqlScheduledTask, "user_id"),
)


def remap_extra_columns(
    session: Session,
    old_id: str,
    new_id: str,
    bump: Callable[[str, int], None],
) -> None:
    """Repoint the remaining user-id columns from ``old_id`` to ``new_id``.

    Runs inside the caller's transaction. Rows keyed by user id (preferences,
    connections, daily costs) can collide only when ``new_id`` already existed
    (a ``force`` merge): the new user's preference and connection win, and
    daily costs are summed.

    :param session: The open session of the remap transaction.
    :param old_id: The identity being retired, e.g. ``"alice"``.
    :param new_id: The identity replacing it, e.g. ``"alice@example.com"``.
    :param bump: Per-table counter, called as ``bump(table, rows)``.
    """
    ws = current_workspace_id()

    for model, column_name in _BULK_COLUMNS:
        column = getattr(model, column_name)
        result = cast(
            CursorResult[tuple[object]],
            session.execute(
                update(model)
                .where(model.workspace_id == ws, column == old_id)
                .values(**{column_name: new_id})
            ),
        )
        bump(model.__tablename__, result.rowcount or 0)

    result = cast(
        CursorResult[tuple[object]],
        session.execute(
            update(SqlConversationLabel)
            .where(
                SqlConversationLabel.workspace_id == ws,
                SqlConversationLabel.key == TURN_ACTOR_LABEL,
                SqlConversationLabel.value == old_id,
            )
            .values(value=new_id)
        ),
    )
    bump(SqlConversationLabel.__tablename__, result.rowcount or 0)

    for model in (SqlPreference, SqlConnection):
        rows = (
            session.execute(select(model).where(model.workspace_id == ws, model.user_id == old_id))
            .scalars()
            .all()
        )
        for row in rows:
            clash = session.get(model, _key_for(model, row, new_id))
            if clash is not None:
                session.delete(row)
            else:
                row.user_id = new_id
            bump(model.__tablename__, 1)
        session.flush()

    costs = (
        session.execute(
            select(SqlUserDailyCost).where(
                SqlUserDailyCost.workspace_id == ws, SqlUserDailyCost.user_id == old_id
            )
        )
        .scalars()
        .all()
    )
    for row in costs:
        clash = session.get(SqlUserDailyCost, _key_for(SqlUserDailyCost, row, new_id))
        if clash is not None:
            clash.cost_usd += row.cost_usd
            clash.ask_approved_usd += row.ask_approved_usd
            clash.updated_at = max(clash.updated_at or 0, row.updated_at or 0)
            session.delete(row)
        else:
            row.user_id = new_id
        bump(SqlUserDailyCost.__tablename__, 1)
    session.flush()


def _key_for(model: Any, row: Any, user_id: str) -> tuple[Any, ...]:
    """The primary key of *row* with its ``user_id`` part set to *user_id*."""
    return tuple(
        user_id if col.key == "user_id" else getattr(row, col.key)
        for col in inspect(model).primary_key
    )
