"""User-id columns the accounts → OIDC remap must also rewrite.

:func:`omnigent.server.identity_migration.remap_identities` repoints grants,
comments, policies, tokens and hosts. A deployment that has been in use also
carries the user id on its agents, projects, schedules, device grants,
conversation items, preferences, connections, daily costs and the turn-actor
label; without these the renamed user loses their projects, schedules and
history attribution. This module rewrites them inside the same transaction,
so it assumes conversations live in the operational database (no separate
``conversation_storage_location``).
Connection secrets are encrypted under the owner's id, so a moved connection
is re-encrypted under the new one.
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
from omnigent.stores.credential_store import build_secret_cipher
from omnigent.stores.credential_store.secret_cipher import SecretCipher
from omnigent.stores.credential_store.sqlalchemy_store import _enc_context

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
    daily costs are summed (the approved checkpoint keeps the higher value). A
    moved connection whose secret the deployment's cipher cannot read (no
    cipher, wrong key) moves as is and is counted under
    ``connections_reconnect``: it was unreadable before the move too.

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

    cipher: SecretCipher | None = None
    if session.execute(
        select(SqlConnection.user_id).where(
            SqlConnection.workspace_id == ws, SqlConnection.user_id == old_id
        )
    ).first():
        cipher = build_secret_cipher()

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
                if model is SqlConnection and not _reencrypt(cipher, row, new_id):
                    bump("connections_reconnect", 1)
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
            # The approved soft-cap checkpoint, not a running total.
            clash.ask_approved_usd = max(clash.ask_approved_usd, row.ask_approved_usd)
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


def _reencrypt(cipher: SecretCipher | None, row: SqlConnection, new_id: str) -> bool:
    """Re-encrypt *row*'s secret under *new_id*; ``False`` if it cannot be read."""
    if cipher is None:
        return False
    old_ctx = _enc_context(row.workspace_id, row.user_id, row.provider, row.account_id)
    plaintext = cipher.decrypt(row.secret_enc, context=old_ctx)
    if plaintext is None:
        return False
    new_ctx = _enc_context(row.workspace_id, new_id, row.provider, row.account_id)
    row.secret_enc = cipher.encrypt(plaintext, context=new_ctx)
    return True
