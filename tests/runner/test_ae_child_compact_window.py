"""A child Claude session launches with the smaller auto-compact window."""

from __future__ import annotations

from omnigent.runner.ae_child_compact_window import (
    AUTO_COMPACT_WINDOW_ENV,
    CHILD_AUTO_COMPACT_WINDOW,
    apply_child_auto_compact_window,
)


def test_child_session_gets_the_window() -> None:
    env: dict[str, str] = {"A": "1"}
    apply_child_auto_compact_window(env, parent_session_id="conv_p", inherited_env={})
    assert env == {"A": "1", AUTO_COMPACT_WINDOW_ENV: CHILD_AUTO_COMPACT_WINDOW}
    assert CHILD_AUTO_COMPACT_WINDOW == "250000"


def test_parent_or_standalone_session_gets_nothing() -> None:
    for parent in (None, ""):
        env: dict[str, str] = {}
        apply_child_auto_compact_window(env, parent_session_id=parent, inherited_env={})
        assert env == {}


def test_existing_value_is_kept() -> None:
    env = {AUTO_COMPACT_WINDOW_ENV: "100000"}
    apply_child_auto_compact_window(env, parent_session_id="conv_p", inherited_env={})
    assert env == {AUTO_COMPACT_WINDOW_ENV: "100000"}
    inherited = {AUTO_COMPACT_WINDOW_ENV: "300000"}
    env2: dict[str, str] = {}
    apply_child_auto_compact_window(env2, parent_session_id="conv_p", inherited_env=inherited)
    assert env2 == {}
