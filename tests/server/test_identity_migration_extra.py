"""Tests for the extra user-id columns the accounts → OIDC remap rewrites.

Covers :mod:`omnigent.server.identity_migration_extra` through
:func:`omnigent.server.identity_migration.remap_identities`: every extra
column moves to the new id, only the turn-actor label is rewritten, and a
``force`` merge resolves the user-keyed rows (preferences, connections,
daily costs) instead of violating their primary keys.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
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
from omnigent.db.utils import get_or_create_engine
from omnigent.server.accounts_store import SqlAlchemyAccountStore
from omnigent.server.identity_migration import remap_identities
from omnigent.server.identity_migration_extra import TURN_ACTOR_LABEL
from omnigent.server.passwords import hash_password
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore

OLD = "alice"
NEW = "alice@example.com"
AGENT_ID = "0b6f2f4c1d2e4a5b8c9d0e1f2a3b4c5d"


def _seed(db_uri: str, user: str, *, suffix: str = "") -> str:
    """Seed one row per extra column for *user*; return the conversation id."""
    conv_id = SqlAlchemyConversationStore(db_uri).create_conversation().id
    with Session(get_or_create_engine(db_uri)) as s:
        s.add(
            SqlAgent(
                id=f"1{suffix or '0'}a6858438cb1aa1b9e00dc79bb04dd9"[:32],
                created_at=1,
                name=f"agent{suffix}",
                bundle_location="/x",
                kind=1,
                created_by=user,
            )
        )
        s.add(
            SqlDeviceGrant(
                id=f"grant{suffix}",
                device_code_hash="h" * 64,
                user_code=f"CODE{suffix}",
                status=1,
                user_id=user,
                created_at=1,
                expires_at=2,
            )
        )
        s.add(
            SqlProject(
                id=f"2{suffix or '0'}a6858438cb1aa1b9e00dc79bb04dd9"[:32],
                name=f"proj{suffix}",
                user_id=user,
                created_at=1,
            )
        )
        s.add(
            SqlScheduledTask(
                id=f"3{suffix or '0'}a6858438cb1aa1b9e00dc79bb04dd9"[:32],
                name=f"task{suffix}",
                prompt="p",
                rrule="FREQ=DAILY",
                user_id=user,
                agent_id=AGENT_ID,
                created_at=1,
            )
        )
        s.add(
            SqlConversationItem(
                conversation_id=conv_id,
                id=f"4{suffix or '0'}a6858438cb1aa1b9e00dc79bb04dd9"[:32],
                response_id="r",
                created_at=1,
                position=0,
                type=1,
                data="{}",
                search_text="",
                created_by=user,
            )
        )
        s.add(
            SqlConversationLabel(
                conversation_id=conv_id, key=TURN_ACTOR_LABEL, value=user, updated_at=1
            )
        )
        # Same value under an unrelated key: must not be rewritten.
        s.add(SqlConversationLabel(conversation_id=conv_id, key="tag", value=user, updated_at=1))
        s.add(SqlPreference(user_id=user, key="theme", value=f"dark{suffix}"))
        s.add(
            SqlConnection(
                user_id=user,
                provider="github",
                account_id="acct",
                secret_enc=f"s{suffix}",
                metadata_json="{}",
                created_at=1,
                updated_at=1,
            )
        )
        s.add(
            SqlUserDailyCost(
                user_id=user,
                day_utc="2026-10-14",
                cost_usd=1.5,
                ask_approved_usd=0.5,
                updated_at=1,
            )
        )
        s.commit()
    return conv_id


def test_remap_repoints_every_extra_column(db_uri: str) -> None:
    """Agents, grants, projects, schedules, items, prefs, connections, costs move."""
    SqlAlchemyAccountStore(db_uri).create_user_with_password(OLD, hash_password("password123"))
    conv_id = _seed(db_uri, OLD)
    engine = get_or_create_engine(db_uri)

    report = remap_identities(engine, {OLD: NEW}, dry_run=False)

    assert report.committed is True
    with Session(engine) as s:
        for model, column in (
            (SqlAgent, SqlAgent.created_by),
            (SqlDeviceGrant, SqlDeviceGrant.user_id),
            (SqlProject, SqlProject.user_id),
            (SqlScheduledTask, SqlScheduledTask.user_id),
            (SqlConversationItem, SqlConversationItem.created_by),
            (SqlPreference, SqlPreference.user_id),
            (SqlConnection, SqlConnection.user_id),
            (SqlUserDailyCost, SqlUserDailyCost.user_id),
        ):
            assert s.execute(select(model).where(column == OLD)).first() is None, model
            assert s.execute(select(model).where(column == NEW)).first() is not None, model
        labels = dict(
            s.execute(
                select(SqlConversationLabel.key, SqlConversationLabel.value).where(
                    SqlConversationLabel.conversation_id == conv_id
                )
            ).all()
        )
    assert labels[TURN_ACTOR_LABEL] == NEW
    assert labels["tag"] == OLD
    assert report.per_table["projects"] == 1
    assert report.per_table["user_daily_cost"] == 1


def test_dry_run_leaves_extra_columns_alone(db_uri: str) -> None:
    """Without commit, the extra columns still name the old id."""
    SqlAlchemyAccountStore(db_uri).create_user_with_password(OLD, hash_password("password123"))
    _seed(db_uri, OLD)
    engine = get_or_create_engine(db_uri)

    report = remap_identities(engine, {OLD: NEW}, dry_run=True)

    assert report.committed is False
    assert report.per_table["scheduled_tasks"] == 1
    with Session(engine) as s:
        assert s.execute(select(SqlProject).where(SqlProject.user_id == OLD)).first() is not None


def test_force_merge_resolves_user_keyed_collisions(db_uri: str) -> None:
    """On a merge, NEW's preference and connection win and daily costs add up.

    The approved checkpoint is a high-water mark, so it keeps the higher value.
    """
    accounts = SqlAlchemyAccountStore(db_uri)
    accounts.create_user_with_password(OLD, hash_password("password123"))
    accounts.create_user_with_password(NEW, hash_password("password123"))
    _seed(db_uri, OLD)
    _seed(db_uri, NEW, suffix="9")
    engine = get_or_create_engine(db_uri)

    report = remap_identities(engine, {OLD: NEW}, dry_run=False, force=True)

    assert report.committed is True
    ws = current_workspace_id()
    with Session(engine) as s:
        pref = s.get(SqlPreference, (ws, NEW, "theme"))
        conn = s.get(SqlConnection, (ws, NEW, "github", "acct"))
        cost = s.get(SqlUserDailyCost, (ws, NEW, "2026-10-14"))
        leftover = s.execute(
            select(SqlUserDailyCost).where(SqlUserDailyCost.user_id == OLD)
        ).first()
    assert leftover is None
    assert pref is not None and pref.value == "dark9"
    assert conn is not None and conn.secret_enc == "s9"
    assert cost is not None and cost.cost_usd == 3.0 and cost.ask_approved_usd == 0.5


class _BoundCipher:
    """A cipher whose ciphertext only decrypts under the context it was made in."""

    def encrypt(self, plaintext: str, *, context: dict[str, str]) -> str:
        return f"{context['user_id']}|{plaintext}"

    def decrypt(self, ciphertext: str, *, context: dict[str, str]) -> str | None:
        owner, _, plaintext = ciphertext.partition("|")
        return plaintext if owner == context["user_id"] else None


def _seed_connection(db_uri: str, secret_enc: str) -> None:
    """Create OLD and one GitHub connection for it with *secret_enc*."""
    SqlAlchemyAccountStore(db_uri).create_user_with_password(OLD, hash_password("password123"))
    with Session(get_or_create_engine(db_uri)) as s:
        s.add(
            SqlConnection(
                user_id=OLD,
                provider="github",
                account_id="acct",
                secret_enc=secret_enc,
                metadata_json="{}",
                created_at=1,
                updated_at=1,
            )
        )
        s.commit()


def test_moved_connection_is_reencrypted_for_the_new_owner(
    db_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A readable secret decrypts under NEW after the move, and no longer under OLD."""
    cipher = _BoundCipher()
    monkeypatch.setattr(
        "omnigent.server.identity_migration_extra.build_secret_cipher", lambda: cipher
    )
    _seed_connection(db_uri, cipher.encrypt('{"token": "t"}', context={"user_id": OLD}))
    engine = get_or_create_engine(db_uri)

    report = remap_identities(engine, {OLD: NEW}, dry_run=False)

    with Session(engine) as s:
        row = s.get(SqlConnection, (current_workspace_id(), NEW, "github", "acct"))
    assert row is not None
    assert cipher.decrypt(row.secret_enc, context={"user_id": NEW}) == '{"token": "t"}'
    assert cipher.decrypt(row.secret_enc, context={"user_id": OLD}) is None
    assert "connections_reconnect" not in report.per_table


def test_unreadable_connection_moves_and_is_counted_for_reconnect(
    db_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without a cipher the row still moves; the report says it needs a reconnect."""
    monkeypatch.setattr(
        "omnigent.server.identity_migration_extra.build_secret_cipher", lambda: None
    )
    _seed_connection(db_uri, "opaque")
    engine = get_or_create_engine(db_uri)

    report = remap_identities(engine, {OLD: NEW}, dry_run=False)

    with Session(engine) as s:
        row = s.get(SqlConnection, (current_workspace_id(), NEW, "github", "acct"))
    assert row is not None and row.secret_enc == "opaque"
    assert report.per_table["connections_reconnect"] == 1


def test_turn_actor_label_matches_the_server() -> None:
    """The copied label name must stay the one the session routes write."""
    from omnigent.server.routes._sessions.common import _TURN_ACTOR_LABEL

    assert TURN_ACTOR_LABEL == _TURN_ACTOR_LABEL
