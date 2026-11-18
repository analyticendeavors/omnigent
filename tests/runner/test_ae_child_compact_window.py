"""A child Claude session launches with the smaller auto-compact window."""

from __future__ import annotations

import pytest

from omnigent.inner.ae_roles import is_family_child
from omnigent.runner.ae_child_compact_window import (
    AUTO_COMPACT_WINDOW_ENV,
    CHILD_AUTO_COMPACT_WINDOW,
    apply_child_auto_compact_window,
)


def test_child_session_gets_the_window() -> None:
    env: dict[str, str] = {"A": "1"}
    apply_child_auto_compact_window(env, is_family_child=True, inherited_env={})
    assert env == {"A": "1", AUTO_COMPACT_WINDOW_ENV: CHILD_AUTO_COMPACT_WINDOW}
    assert CHILD_AUTO_COMPACT_WINDOW == "250000"


def test_lead_or_standalone_session_gets_nothing() -> None:
    env: dict[str, str] = {}
    apply_child_auto_compact_window(env, is_family_child=False, inherited_env={})
    assert env == {}


def test_existing_value_is_kept() -> None:
    env = {AUTO_COMPACT_WINDOW_ENV: "100000"}
    apply_child_auto_compact_window(env, is_family_child=True, inherited_env={})
    assert env == {AUTO_COMPACT_WINDOW_ENV: "100000"}
    inherited = {AUTO_COMPACT_WINDOW_ENV: "300000"}
    env2: dict[str, str] = {}
    apply_child_auto_compact_window(env2, is_family_child=True, inherited_env=inherited)
    assert env2 == {}


@pytest.mark.parametrize(
    "labels,parent,expected",
    [
        pytest.param({}, None, None, id="lead-no-env-var"),
        pytest.param({"ae.orch": "1"}, None, None, id="standalone-orch-one-no-env-var"),
        pytest.param(
            {"ae.orch": "conv_lead", "omnigent.fork.source_id": "conv_src"},
            None,
            None,
            id="fork-with-orch-label-no-env-var",
        ),
        pytest.param({"ae.orch": "conv_lead"}, None, "250000", id="family-child-orch-label"),
        pytest.param({}, "conv_p", "250000", id="parent-session-id"),
    ],
)
def test_launch_decision_follows_the_family_rule(
    labels: dict[str, str], parent: str | None, expected: str | None
) -> None:
    """The launch decision is the family view's rule, so the two cannot disagree."""
    env: dict[str, str] = {}
    apply_child_auto_compact_window(
        env, is_family_child=is_family_child(labels, parent), inherited_env={}
    )
    assert env.get(AUTO_COMPACT_WINDOW_ENV) == expected


def test_is_family_child_ignores_non_dict_labels_and_blank_orch() -> None:
    assert is_family_child(None, None) is False
    assert is_family_child({"ae.orch": "  "}, None) is False
    assert is_family_child({"ae.orch": 7}, None) is False
