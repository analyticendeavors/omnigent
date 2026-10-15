"""Native team permission translations preserve supported presets."""

import pytest

from omnigent.harness_plugins import CLAUDE_NATIVE_CODING_AGENT, CODEX_NATIVE_CODING_AGENT
from omnigent.server.routes._sessions.team_permissions import inherited_team_permission_args


@pytest.mark.parametrize(
    ("parent", "mode_key", "mode", "child"),
    [
        (CODEX_NATIVE_CODING_AGENT, "approval_mode", "read-only", CLAUDE_NATIVE_CODING_AGENT),
        (CLAUDE_NATIVE_CODING_AGENT, "permission_mode", "plan", CODEX_NATIVE_CODING_AGENT),
        (CLAUDE_NATIVE_CODING_AGENT, "permission_mode", "acceptEdits", CODEX_NATIVE_CODING_AGENT),
        (CODEX_NATIVE_CODING_AGENT, "approval_mode", "unknown", CODEX_NATIVE_CODING_AGENT),
    ],
)
def test_unsupported_cross_harness_mode_is_not_translated(parent, mode_key, mode, child) -> None:
    vendor = "codex" if parent == CODEX_NATIVE_CODING_AGENT else "claude"
    labels = {
        "omnigent.wrapper": parent.wrapper_label,
        f"omnigent.{vendor}_native.{mode_key}": mode,
    }
    assert inherited_team_permission_args(labels, child.wrapper_label) is None


def test_read_only_codex_team_member_keeps_read_only_sandbox() -> None:
    labels = {
        "omnigent.wrapper": CODEX_NATIVE_CODING_AGENT.wrapper_label,
        "omnigent.codex_native.approval_mode": "read-only",
    }
    assert inherited_team_permission_args(labels, CODEX_NATIVE_CODING_AGENT.wrapper_label) == [
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "on-request",
        "-c",
        'approvals_reviewer="user"',
    ]
