"""The role preset in the lead notice: resolution from label and prefs, and its wording."""

from __future__ import annotations

import copy
import json
from typing import Any
from unittest.mock import Mock

import pytest

from omnigent.entities.conversation import Conversation
from omnigent.inner import ae_roles
from omnigent.inner.ae_roles import render_roles, resolve_roles
from omnigent.inner.ae_team import TEAM_LABEL, render_team_notice, team_notice

BALANCED: dict[str, Any] = {
    **ae_roles.BALANCED,
    "roles": {
        "lead": {"mode": "session"},
        "planner": {"mode": "fixed", "model": "claude-opus-5-5", "effort": "high"},
        "reviewer": {"mode": "fixed", "model": "claude-sonnet-5-5", "effort": "medium"},
        "builder": {"mode": "fixed", "model": "claude-sonnet-5-5", "effort": "medium"},
        "helper": {"mode": "fixed", "model": "claude-haiku-5-5", "effort": "low"},
    },
}
YOLO: dict[str, Any] = {
    "id": "yolo",
    "title": "YOLO",
    "when_to_use": "Hard problems.",
    "roles": {
        role: {"mode": "fixed", "model": "claude-fable-5-1", "effort": "max"}
        for role in ae_roles.ROLES
    },
    "rules": {"raise_or_lower": "off", "lead_steps_down": False, "auto_raises": 0},
}


CURRENT = {
    "fable": "claude-fable-5-1",
    "opus": "claude-opus-5-5",
    "sonnet": "claude-sonnet-5-5",
    "haiku": "claude-haiku-5-5",
}


def conversation(labels: dict[str, str] | None = None, **kwargs: Any) -> Conversation:
    return Conversation(
        id="conv",
        root_conversation_id="conv",
        created_at=0,
        updated_at=0,
        labels=labels or {},
        **kwargs,
    )


def team_label(**fields: Any) -> dict[str, str]:
    return {TEAM_LABEL: json.dumps({"version": 1, "mode": "auto", **fields})}


@pytest.fixture()
def prefs(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Pin the presets each user reads; records which user was asked."""
    held: dict[str, Any] = {"default": "balanced", "presets": [BALANCED, YOLO], "asked": []}

    def load(user: str) -> tuple[str, list[dict[str, Any]]]:
        held["asked"].append(user)
        return held["default"], copy.deepcopy(held["presets"])

    monkeypatch.setattr(ae_roles, "_load_prefs", load)
    return held


def owner_store(owner: object = None) -> Mock:
    store = Mock()
    store.get_session_owner.return_value = owner
    return store


def test_no_label_uses_the_owners_default(prefs: dict[str, Any]) -> None:
    prefs["default"] = "yolo"
    roles = resolve_roles(conversation(), owner_store("reid@example.com"))
    assert prefs["asked"] == ["reid@example.com"]
    assert roles == {
        "preset": {
            "id": "yolo",
            "title": "YOLO",
            "roles": YOLO["roles"],
            "rules": YOLO["rules"],
        },
        "custom": False,
        "current": ae_roles._current_ids(),
    }


def test_no_owner_falls_back_to_local(prefs: dict[str, Any]) -> None:
    resolve_roles(conversation(), owner_store(None))
    store = Mock()
    store.get_session_owner.side_effect = RuntimeError("db down")
    resolve_roles(conversation(), store)
    resolve_roles(conversation(), owner_store(Mock()))
    assert prefs["asked"] == ["local", "local", "local"]


def test_a_child_without_a_grant_reads_the_roots_owner(prefs: dict[str, Any]) -> None:
    store = Mock()
    store.get_session_owner.side_effect = lambda cid, **_: {"root": "steve@example.com"}.get(cid)
    conv = Conversation(id="child", root_conversation_id="root", created_at=0, updated_at=0)
    resolve_roles(conv, store)
    assert prefs["asked"] == ["steve@example.com"]


def test_label_names_a_preset(prefs: dict[str, Any]) -> None:
    roles = resolve_roles(conversation(team_label(roles={"preset": "yolo"})), owner_store())
    assert roles["preset"]["id"] == "yolo"
    assert roles["custom"] is False


@pytest.mark.parametrize(
    "labels",
    [
        team_label(roles={"preset": "gone"}),
        team_label(roles={"preset": 42}),
        team_label(roles="yolo"),
        {TEAM_LABEL: json.dumps({"version": 2, "roles": {"preset": "yolo"}})},
        {TEAM_LABEL: "{not json"},
        {TEAM_LABEL: "x" * 20_000},
    ],
)
def test_bad_or_unknown_overrides_use_the_default(
    prefs: dict[str, Any], labels: dict[str, str]
) -> None:
    roles = resolve_roles(conversation(labels), owner_store())
    assert roles["preset"]["id"] == "balanced"


def test_a_malformed_label_still_gets_the_roles_block(prefs: dict[str, Any]) -> None:
    notice = team_notice(conversation({TEAM_LABEL: "{not json"}), owner_store())
    assert notice is not None and "ae_team" not in notice
    text = render_team_notice(notice) or ""
    assert text.startswith("Roles preset: Balanced.")


def test_custom_override_needs_the_package(
    prefs: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    custom = {"roles": YOLO["roles"], "rules": YOLO["rules"]}
    labels = team_label(roles={"preset": "balanced", "custom": custom})
    module = Mock()
    module.validate_custom.side_effect = lambda raw: raw
    monkeypatch.setattr(ae_roles, "_role_prefs", lambda: module)
    roles = resolve_roles(conversation(labels), owner_store())
    assert roles["custom"] is True
    assert roles["preset"]["title"] == "Balanced"
    assert roles["preset"]["roles"] == YOLO["roles"]
    module.validate_custom.side_effect = ValueError("bad")
    assert resolve_roles(conversation(labels), owner_store())["custom"] is False
    monkeypatch.setattr(ae_roles, "_role_prefs", lambda: None)
    assert resolve_roles(conversation(labels), owner_store())["custom"] is False


def test_lead_picks_lists_the_users_presets(prefs: dict[str, Any]) -> None:
    prefs["presets"] = [{**BALANCED, "id": f"p{n}", "title": f"Preset {n}"} for n in range(10)]
    labels = team_label(roles={"preset": "lead-picks"})
    roles = resolve_roles(conversation(labels), owner_store())
    assert roles["lead_picks"] is True
    assert len(roles["presets"]) == 8
    assert roles["more"] == 2
    text = render_roles(roles) or ""
    lines = text.splitlines()
    assert len(lines) == 10
    assert lines[0].startswith("Roles preset: lead picks. Pick the preset")
    assert lines[1].startswith("- Preset 0: Most tasks:")
    assert "planner opus, high" in lines[1]
    assert "claude-" not in text
    assert "lead" not in lines[1].split("(", 1)[1]
    assert lines[-1] == "(2 more presets are not shown.)"
    assert lines[1].endswith("; changes: tell after, steps down, 1 raise, any agent or session).")
    assert len(lines) <= 10


def test_lead_picks_line_shows_each_presets_change_rules(prefs: dict[str, Any]) -> None:
    prefs["presets"] = [BALANCED, YOLO]
    labels = team_label(roles={"preset": "lead-picks"})
    lines = (render_roles(resolve_roles(conversation(labels), owner_store())) or "").splitlines()
    assert "changes: tell after, steps down, 1 raise" in lines[1]
    assert "changes: no changes, no step down, 0 raises, any agent or session" in lines[2]


SOLO: dict[str, Any] = {
    **copy.deepcopy(BALANCED),
    "id": "solo",
    "title": "Solo",
    "rules": {**BALANCED["rules"], "helpers": "own"},
}


def team_store(*child_ids: str) -> Mock:
    """A store whose direct children of ``conv`` are *child_ids*."""
    store = owner_store()

    def child(session_id: str) -> Conversation | None:
        if session_id not in child_ids:
            return None
        return Conversation(
            id=session_id,
            root_conversation_id="conv",
            parent_conversation_id="conv",
            agent_id="codex",
            created_at=0,
            updated_at=0,
        )

    store.get_conversation.side_effect = child
    return store


def test_lead_picks_line_shows_own_subagents_only(prefs: dict[str, Any]) -> None:
    prefs["presets"] = [BALANCED, SOLO]
    labels = team_label(roles={"preset": "lead-picks"})
    lines = (render_roles(resolve_roles(conversation(labels), owner_store())) or "").splitlines()
    assert lines[2].endswith("1 raise, own subagents only).")


def test_a_preset_with_own_helpers_tells_the_lead_solo(prefs: dict[str, Any]) -> None:
    prefs["presets"] = [BALANCED, SOLO]
    notice = team_notice(conversation(team_label(roles={"preset": "solo"})), owner_store())
    assert notice["ae_team"] == {"mode": "solo", "members": []}
    text = render_team_notice(notice) or ""
    assert text.startswith(
        'This session\'s preset ("Solo") keeps work in house: use this lead agent and its '
        "native in-harness subagents when helpful."
    )
    assert "\n\nRoles preset: Solo." in text


def test_own_helpers_win_over_added_sessions(prefs: dict[str, Any]) -> None:
    prefs["presets"] = [BALANCED, SOLO]
    labels = {
        TEAM_LABEL: json.dumps(
            {
                "version": 1,
                "mode": "team",
                "members": [{"sessionId": "kid"}],
                "roles": {"preset": "solo"},
            }
        )
    }
    notice = team_notice(conversation(labels), team_store("kid"))
    assert notice["ae_team"] == {"mode": "solo", "members": []}


def test_own_helpers_tell_solo_when_the_team_notice_is_unreadable() -> None:
    own = {"preset": {"id": "solo", "title": "Solo", "rules": {"helpers": "own"}}}
    assert ae_roles.effective_mode(None, own)["ae_team"] == {"mode": "solo", "members": []}
    any_ = {"preset": {"id": "yolo", "title": "Yolo", "rules": {"helpers": "any"}}}
    assert ae_roles.effective_mode(None, any_) == {}


def test_added_sessions_tell_the_lead_team(prefs: dict[str, Any]) -> None:
    labels = {
        TEAM_LABEL: json.dumps({"version": 1, "mode": "team", "members": [{"sessionId": "kid"}]})
    }
    notice = team_notice(conversation(labels), team_store("kid"))
    assert notice["ae_team"] == {
        "mode": "team",
        "members": [{"session_id": "kid", "agent_id": "codex"}],
    }
    text = render_team_notice(notice) or ""
    assert text.startswith(
        "The user added these child sessions to this chat. You are the lead and give the user "
        "one integrated answer; hand work to these sessions first."
    )
    assert '"session_id": "kid"' in text


def test_any_helpers_and_no_sessions_is_auto(prefs: dict[str, Any]) -> None:
    notice = team_notice(conversation(team_label(roles={"preset": "yolo"})), owner_store())
    assert notice["ae_team"] == {"mode": "auto", "members": []}


def test_a_legacy_solo_label_reads_as_the_solo_preset(prefs: dict[str, Any]) -> None:
    prefs["presets"] = [BALANCED, SOLO]
    labels = {TEAM_LABEL: '{"version":1,"mode":"solo","members":[]}'}
    notice = team_notice(conversation(labels), owner_store())
    assert notice["ae_roles"]["preset"]["id"] == "solo"
    assert notice["ae_team"]["mode"] == "solo"


def test_a_legacy_solo_label_without_a_solo_preset_keeps_work_in_house(
    prefs: dict[str, Any],
) -> None:
    labels = {TEAM_LABEL: '{"version":1,"mode":"solo","members":[]}'}
    notice = team_notice(conversation(labels), owner_store())
    assert notice["ae_roles"]["preset"]["id"] == "balanced"
    assert notice["ae_roles"]["preset"]["rules"]["helpers"] == "own"
    assert notice["ae_team"]["mode"] == "solo"
    assert (render_team_notice(notice) or "").startswith(
        'This session\'s preset ("Balanced") keeps work in house'
    )


def test_a_legacy_solo_label_with_a_preset_keeps_that_preset(prefs: dict[str, Any]) -> None:
    prefs["presets"] = [BALANCED, SOLO, YOLO]
    labels = {TEAM_LABEL: json.dumps({"version": 1, "mode": "solo", "roles": {"preset": "yolo"}})}
    notice = team_notice(conversation(labels), owner_store())
    assert notice["ae_roles"]["preset"]["id"] == "yolo"
    assert notice["ae_roles"]["preset"]["rules"]["helpers"] == "own"
    assert notice["ae_team"]["mode"] == "solo"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"parent_conversation_id": "lead"},
        {"labels": {"ae.orch": "sess_123"}},
    ],
)
def test_a_child_session_gets_only_the_helper_line(
    prefs: dict[str, Any], kwargs: dict[str, Any]
) -> None:
    labels = {TEAM_LABEL: json.dumps({"version": 1, "mode": "team", "members": []})}
    kwargs = {**kwargs, "labels": {**kwargs.get("labels", {}), **labels}}
    notice = team_notice(conversation(**kwargs), owner_store())
    assert notice == {"ae_helper": True}
    assert render_team_notice(notice) == ae_roles.HELPER_NOTICE
    assert "lead session" in ae_roles.HELPER_NOTICE
    assert "do not start other sessions" in ae_roles.HELPER_NOTICE


@pytest.mark.parametrize("orch", ["1", "", " "])
def test_a_lead_with_a_flag_orch_label_keeps_the_block(prefs: dict[str, Any], orch: str) -> None:
    notice = team_notice(conversation(labels={"ae.orch": orch}), owner_store()) or {}
    assert "ae_roles" in notice


def test_balanced_wording_matches_the_contract(prefs: dict[str, Any]) -> None:
    text = render_team_notice(team_notice(conversation(), owner_store())) or ""
    block = text.split("\n\n", 1)[1]
    assert text.startswith("Auto collaboration is enabled")
    assert block.splitlines() == [
        "Roles preset: Balanced. Name a role for each helper you start and give a native "
        "subagent that role's model and effort. Native subagents (Claude's Agent tool) take "
        "a tier alias (opus, sonnet, haiku, fable) and an effort. For a separate session, "
        "name its role in the brief.",
        "- Lead: you, on the session model.",
        "- Planner (design, architecture, unknown root cause): opus, high.",
        "- Reviewer (reviews, verifying a finding, fix checks): sonnet, medium.",
        "- Builder (code once the plan is pinned): sonnet, medium.",
        "- Helper (polling, PR watching, screenshots, mechanical commits): haiku, low.",
        "Model changes: raise a stuck child or lower yourself: tell the user after. Step down "
        "for mechanical work: on. Automatic raises per child: 1; past that, ask first.",
    ]


@pytest.mark.parametrize("mode", ["solo", "team"])
def test_every_mode_carries_the_block(prefs: dict[str, Any], mode: str) -> None:
    labels = {TEAM_LABEL: json.dumps({"version": 1, "mode": mode, "members": []})}
    text = render_team_notice(team_notice(conversation(labels), owner_store())) or ""
    assert "\n\nRoles preset: Balanced." in text


def test_auto_roles_and_a_fixed_lead_render(prefs: dict[str, Any]) -> None:
    preset = copy.deepcopy(YOLO)
    preset["roles"]["builder"] = {"mode": "auto"}
    text = render_roles({"preset": preset, "custom": True, "current": CURRENT}) or ""
    lines = text.splitlines()
    assert lines[0].startswith("Roles preset: YOLO (customized for this session).")
    assert lines[1] == "- Lead: you, on fable, max."
    assert lines[4] == "- Builder (code once the plan is pinned): your pick."
    assert lines[-1].startswith("Model changes: do not raise a child or lower yourself")
    assert lines[-1].endswith("Step down for mechanical work: off. Automatic raises per child: 0.")
    assert "past that" not in text
    assert len(lines) < 12


def test_a_model_without_a_tier_alias_keeps_its_id() -> None:
    preset = copy.deepcopy(BALANCED)
    preset["roles"]["builder"] = {"mode": "fixed", "model": "gpt-5.5-codex", "effort": "high"}
    text = render_roles({"preset": preset, "custom": False}) or ""
    assert "- Builder (code once the plan is pinned): gpt-5.5-codex, high." in text


def test_rendering_survives_junk_metadata() -> None:
    assert render_roles(None) is None
    assert render_roles({"preset": "x"}) is None
    assert render_roles({"lead_picks": True, "presets": []}) is None
    text = render_roles({"preset": {"title": "a\nb", "roles": "x", "rules": 3}}) or ""
    assert text.startswith("Roles preset: a b.")
    assert "your pick" in text


def test_resolution_failure_falls_back_to_balanced(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_: object) -> None:
        raise RuntimeError("broken")

    monkeypatch.setattr(ae_roles, "resolve_roles", boom)
    notice = team_notice(conversation(), owner_store())
    assert notice["ae_roles"]["preset"]["id"] == "balanced"


def test_real_preset_store_is_read_when_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    role_prefs = pytest.importorskip("ae_omni_policies.role_prefs")
    store = role_prefs.RolePrefsStore(None)
    body = role_prefs.never_saved().model_dump()
    store.put(
        "reid@example.com", role_prefs.RolesPut.model_validate({**body, "default_preset": "yolo"})
    )
    monkeypatch.setattr(role_prefs, "store", lambda: store)
    roles = resolve_roles(conversation(), owner_store("reid@example.com"))
    assert roles["preset"]["id"] == "yolo"
    assert resolve_roles(conversation(), owner_store("steve@example.com"))["preset"]["id"] == (
        "balanced"
    )
    custom = {"roles": YOLO["roles"], "rules": YOLO["rules"]}
    labels = team_label(roles={"preset": "balanced", "custom": custom})
    assert resolve_roles(conversation(labels), owner_store("reid@example.com"))["custom"] is True


def test_without_the_package_balanced_uses_tier_aliases(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ae_roles, "_role_prefs", lambda: None)
    text = render_team_notice(team_notice(conversation(), owner_store())) or ""
    assert "- Planner (design, architecture, unknown root cause): opus, high." in text
    assert "- Helper (polling, PR watching, screenshots, mechanical commits): haiku, low." in text


def test_a_fork_with_a_copied_orch_label_is_a_lead(prefs: dict[str, Any]) -> None:
    """A fork copies ae.orch but is a top-level session; a fork with a parent is a child."""
    labels = {"ae.orch": "sess_123", ae_roles.FORK_SOURCE_LABEL: "conv_src"}
    notice = team_notice(conversation(labels), owner_store()) or {}
    assert "ae_roles" in notice and "ae_helper" not in notice
    child = team_notice(conversation(labels, parent_conversation_id="lead"), owner_store())
    assert child == {"ae_helper": True}


def _lead_line(conv: Conversation) -> str:
    text = render_roles(team_notice(conv, owner_store()).get("ae_roles")) or ""
    return next(line for line in text.splitlines() if line.startswith("- Lead:"))


def test_the_lead_line_names_what_the_session_runs(
    prefs: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(ae_roles, "_current_ids", lambda: dict(CURRENT))
    yolo = team_label(roles={"preset": "yolo"})
    assert _lead_line(conversation(yolo)) == "- Lead: you, on fable, max."
    on_opus = conversation(yolo, model_override="claude-opus-5-5", reasoning_effort="high")
    assert _lead_line(on_opus) == "- Lead: you, on opus, high (the preset asks for fable, max)."
    on_fable = conversation(yolo, model_override="claude-fable-5-1[1m]", reasoning_effort="max")
    assert _lead_line(on_fable) == "- Lead: you, on fable, max."
    balanced = conversation(model_override="claude-opus-5-5", reasoning_effort="high")
    assert _lead_line(balanced) == "- Lead: you, on opus, high (the session model)."
    assert _lead_line(conversation()) == "- Lead: you, on the session model."


def test_only_a_claude_lead_hears_about_the_agent_tool(prefs: dict[str, Any]) -> None:
    def first_line(conv: Conversation) -> str:
        text = render_roles(team_notice(conv, owner_store()).get("ae_roles")) or ""
        return text.splitlines()[0]

    codex = first_line(conversation(model_override="gpt-5.6-sol", reasoning_effort="high"))
    assert "Claude's Agent tool" not in codex and "tier alias" not in codex
    assert codex.endswith(ae_roles._TOOLS_OTHER)
    claude = first_line(conversation(harness_override="claude-native"))
    assert claude.endswith(ae_roles._TOOLS)
    # Nothing on the row names a harness: the Claude wording stays, as before.
    assert first_line(conversation()).endswith(ae_roles._TOOLS)


def test_an_older_model_version_keeps_its_full_id() -> None:
    preset = copy.deepcopy(BALANCED)
    preset["roles"]["planner"] = {"mode": "fixed", "model": "claude-opus-4-8", "effort": "high"}
    preset["roles"]["reviewer"] = {
        "mode": "fixed",
        "model": "claude-sonnet-5-5[1m]",
        "effort": "medium",
    }
    preset["roles"]["builder"] = {
        "mode": "fixed",
        "model": "system.ai.claude-fable-5-1",
        "effort": "high",
    }
    text = render_roles({"preset": preset, "custom": False, "current": CURRENT}) or ""
    assert "- Planner (design, architecture, unknown root cause): claude-opus-4-8, high." in text
    assert "- Reviewer (reviews, verifying a finding, fix checks): sonnet, medium." in text
    assert "- Builder (code once the plan is pinned): fable, high." in text
    # Without the current ids a fixed id is shown as is.
    bare = render_roles({"preset": preset, "custom": False}) or ""
    assert "claude-sonnet-5-5[1m], medium" in bare
