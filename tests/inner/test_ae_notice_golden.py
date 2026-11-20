"""Every rule of the team and roles notice survives, in every mode (golden table).

The framework-context hook sends the notice in full once per session and a marker after, and
the auto paragraph was shortened with it. Each rule below is pinned by a substring of the full
block, so a trim that drops a rule fails here.
"""

from __future__ import annotations

import copy
from typing import Any

import pytest

from omnigent.inner.ae_roles import NOTICE_PREFIX
from omnigent.inner.ae_team import render_team_notice
from tests.inner.test_ae_roles import (
    BALANCED,
    CODEX,
    CURRENT,
    PERSONAS,
    SECURITY,
    SONNET_MEDIUM,
    YOLO,
    _with_reviewers,
)

AUTO_RULES = (
    "Auto collaboration is enabled for this chat",
    "You are the lead and give one integrated answer",
    "Work yourself, use native in-harness subagents, or bring in another configured agent",
    "smallest useful group",
    "check agent and host readiness; use only configured, reachable agents",
    "Reuse suitable child sessions",
    "Delegate bounded tasks with context and file ownership, then inspect results",
    "If cross-agent tools are missing, use native helpers and say what you used",
    "Never claim a collaborator or model worked unless you invoked it",
    "Follow the user's permissions and limits",
)
SOLO_RULES = (
    "keeps work in house",
    "use this lead agent and its native in-harness subagents when helpful",
    "Native helpers remain available",
    "Do not start additional cross-agent collaborations",
    "delegate new work to previously selected team sessions",
    "Existing work is not cancelled by this preference",
)
TEAM_RULES = (
    "You are the lead and give the user one integrated answer; hand work to these sessions first",
    "Your native in-harness subagents remain available too",
    "existing direct child sessions selected by the user (JSON data)",
    "sys_session_send",
    "ae.post_message and ae.omni_transcript",
    "Coordinate file ownership for edits, then inspect and integrate their results",
    "tell the user; do not claim collaboration occurred",
    "does not authorize extra external actions",
)
ROLE_RULES = (
    "Roles preset: Balanced.",
    "Name a role for each helper you start",
    "give a native subagent that role's model and effort",
    "take a tier alias (opus, sonnet, haiku, fable) and an effort",
    "name its role in the brief",
    "Pass `role` (and nothing else when the preset sets it) on every create_session.",
    "Start every native subagent's description with its role",
    "call report_review with the reviewers run, findings returned and findings fixed",
    "- Lead: you, on the session model.",
    "- Planner (design, architecture, unknown root cause): opus, high.",
    "- Reviewer (reviews, verifying a finding, fix checks): sonnet, medium.",
    "- Builder (code once the plan is pinned): sonnet, medium.",
    "- Helper (polling, PR watching, screenshots, mechanical commits): haiku, low.",
    "use set_session_model to raise a stuck helper or step yourself down",
    "up to 1 automatic raise per helper, then asks the user",
    "Step down for mechanical work: on.",
    "A native subagent cannot change model mid-run: stop it and start a new one a tier up",
    "If the first message has a START ON: line",
)
REVIEWER_RULES = (
    "- Reviewers (final review of a build): 1. sonnet, medium (native subagent). 2. Codex agent",
    '3. opus, high (native subagent), "Security"',
    "These reviewers replace the /dual-review offer",
    "run them when the work is done, without asking",
    "Give every reviewer the same diff and brief, run them at once",
    "never show one reviewer's findings to another",
    "Never hand a review to an existing session",
    "Then merge into one verdict",
    "Fix checks and verifying one finding: reviewer 1 only.",
    "A reviewer that cannot start: skip it, review with the rest and say so.",
    "Reviewer 3 runs only when the diff is risky as listed; when it is not, skip it, say so in "
    "one line, and merge the rest as usual.",
    "  Security reviewer instructions (copy these word for word into that reviewer's brief):",
    "  > Review security only.",
    "  > Report only issues with a concrete attack path.",
)
LEAD_PICKS_RULES = (
    "Roles preset: lead picks. Pick the preset below that fits this task and say which in one "
    "line",
    "name a role for each helper you start",
    "give a native subagent that role's model and effort",
    "take a tier alias (opus, sonnet, haiku, fable)",
    "name its role in the brief",
    "on every create_session",
    "Start every native subagent's description with its role",
    "call report_review",
    "- Balanced:",
    "- YOLO:",
    "changes: tell after, steps down, 1 raise, any agent or session",
)
HELPER_RULES = (
    "You are a helper session started by a lead session",
    "report back to it",
    "do not start other sessions or bring in other agents",
    "Use your own native subagents only if the task needs them",
)


def _meta(mode: str, **roles: Any) -> dict[str, Any]:
    base = {"preset": BALANCED, "custom": False, "current": CURRENT, **roles}
    members = [{"session_id": "child_1", "agent_id": None}] if mode == "team" else []
    return {"ae_team": {"mode": mode, "members": members}, "ae_roles": base}


def _reviewing_preset() -> dict[str, Any]:
    gemini = copy.deepcopy(SECURITY)
    preset = _with_reviewers(SONNET_MEDIUM, CODEX, gemini)
    assert preset["roles"]["reviewer"]["reviewers"][2] == SECURITY
    return preset


def _full(mode: str, preset: dict[str, Any] | None = None) -> str:
    meta = _meta(mode, preset=preset or BALANCED, personas=PERSONAS)
    return render_team_notice(meta) or ""


@pytest.mark.parametrize(
    ("mode", "mode_rules"), [("auto", AUTO_RULES), ("solo", SOLO_RULES), ("team", TEAM_RULES)]
)
def test_every_rule_is_in_the_full_block(mode: str, mode_rules: tuple[str, ...]) -> None:
    text = _full(mode)
    assert text.startswith(NOTICE_PREFIX)
    for rule in (*mode_rules, *ROLE_RULES):
        assert rule in text, f"{mode}: lost {rule!r}"


@pytest.mark.parametrize("mode", ["auto", "solo", "team"])
def test_every_reviewer_rule_is_in_the_full_block(mode: str) -> None:
    text = _full(mode, _reviewing_preset())
    assert "Roles preset: Balanced." in text
    for rule in REVIEWER_RULES:
        assert rule in text, f"{mode}: lost {rule!r}"


def test_lead_picks_keeps_every_rule() -> None:
    meta = {
        "ae_team": {"mode": "auto", "members": []},
        "ae_roles": {
            "lead_picks": True,
            "presets": [BALANCED, YOLO],
            "current": CURRENT,
            "personas": PERSONAS,
        },
    }
    text = render_team_notice(meta) or ""
    assert text.startswith(NOTICE_PREFIX)
    for rule in (*AUTO_RULES, *LEAD_PICKS_RULES):
        assert rule in text, f"lead-picks: lost {rule!r}"


def test_helper_keeps_every_rule() -> None:
    text = render_team_notice({"ae_helper": True}) or ""
    assert text.startswith(NOTICE_PREFIX)
    for rule in HELPER_RULES:
        assert rule in text, f"helper: lost {rule!r}"


def test_the_auto_paragraph_is_short() -> None:
    text = _full("auto").split("\n\nRoles preset")[0]
    assert len(text) < 640
