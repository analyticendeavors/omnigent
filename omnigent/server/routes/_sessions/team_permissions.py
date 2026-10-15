"""Permission defaults for user-added native team members."""

from collections.abc import Mapping

from omnigent.harness_plugins import CLAUDE_NATIVE_CODING_AGENT, CODEX_NATIVE_CODING_AGENT


def inherited_team_permission_args(
    parent_labels: Mapping[str, str], child_wrapper: str | None
) -> list[str] | None:
    """Translate the parent's observed mode without copying unrelated CLI options."""
    parent_wrapper = parent_labels.get("omnigent.wrapper")
    claude_mode = None
    codex_mode = None
    if parent_wrapper == CLAUDE_NATIVE_CODING_AGENT.wrapper_label:
        claude_mode = parent_labels.get("omnigent.claude_native.permission_mode")
        codex_mode = {
            "default": "ask-for-approval",
            "auto": "approve-for-me",
            "bypassPermissions": "full-access",
        }.get(claude_mode or "")
    elif parent_wrapper == CODEX_NATIVE_CODING_AGENT.wrapper_label:
        codex_mode = parent_labels.get("omnigent.codex_native.approval_mode")
        claude_mode = {
            "ask-for-approval": "default",
            "approve-for-me": "auto",
            "full-access": "bypassPermissions",
        }.get(codex_mode or "")
    if child_wrapper == CLAUDE_NATIVE_CODING_AGENT.wrapper_label and claude_mode in {
        "default",
        "auto",
        "acceptEdits",
        "plan",
        "bypassPermissions",
        "dontAsk",
    }:
        return ["--permission-mode", claude_mode]
    if child_wrapper == CODEX_NATIVE_CODING_AGENT.wrapper_label:
        if codex_mode == "full-access":
            return ["--dangerously-bypass-approvals-and-sandbox"]
        if codex_mode in {"ask-for-approval", "approve-for-me", "read-only"}:
            return [
                "--sandbox",
                "read-only" if codex_mode == "read-only" else "workspace-write",
                "--ask-for-approval",
                "on-request",
                "-c",
                'approvals_reviewer="auto_review"'
                if codex_mode == "approve-for-me"
                else 'approvals_reviewer="user"',
            ]
    return None
