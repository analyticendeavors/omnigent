"""``update_default(factory_params=...)`` on :class:`SqlAlchemyPolicyStore` (AE patch)."""

from __future__ import annotations

import pytest

from omnigent.stores.policy_store.sqlalchemy_store import SqlAlchemyPolicyStore

_ID = "5e0b9a7c2f4d4c1b8a6e3d2f1c0b9a87"


@pytest.fixture()
def store(db_uri: str) -> SqlAlchemyPolicyStore:
    store = SqlAlchemyPolicyStore(db_uri)
    store.create_default(
        policy_id=_ID,
        name="rabbit_hole",
        type="python",
        handler="mod.factory",
        factory_params={"hours": 4, "turns": 60},
    )
    return store


def test_omitting_factory_params_leaves_them(store: SqlAlchemyPolicyStore) -> None:
    updated = store.update_default(_ID, enabled=False)
    assert updated is not None
    assert updated.factory_params == {"hours": 4, "turns": 60}


def test_factory_params_are_replaced_whole(store: SqlAlchemyPolicyStore) -> None:
    updated = store.update_default(_ID, factory_params={"turns": 80})
    assert updated is not None
    assert updated.factory_params == {"turns": 80}
    assert updated.updated_at is not None
    assert store.get_default(_ID).factory_params == {"turns": 80}


@pytest.mark.parametrize("cleared", [None, {}])
def test_none_or_empty_clears_them(store: SqlAlchemyPolicyStore, cleared: dict | None) -> None:
    updated = store.update_default(_ID, factory_params=cleared)
    assert updated is not None
    assert updated.factory_params is None


def test_the_same_params_change_nothing(store: SqlAlchemyPolicyStore) -> None:
    updated = store.update_default(_ID, factory_params={"hours": 4, "turns": 60})
    assert updated is not None
    assert updated.updated_at is None
