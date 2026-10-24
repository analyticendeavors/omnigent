"""Role presets in the lead notice: which model and effort each helper role gets.

Added 2026-10-23 by omnigent-ae for role routing. The user keeps a list of
presets (Settings > Roles, stored by the omnigent-ae package
``ae_omni_policies.role_prefs``); every turn the lead is told which preset is in
force and what model and effort to give the helpers it starts, so the user no
longer restates it in each prompt.

The preset is resolved server-side in :func:`with_roles` (called from
``ae_team.team_notice``) and carried in the framework notice metadata under
``ae_roles``; :func:`render_roles` turns it into a short block that
``ae_team.render_team_notice`` appends in every mode.

Which preset: the ``roles`` field of the ``ae.team`` label when it names one of
the user's presets (``{"preset": id}``, optionally with a session-only
``custom`` roles and rules pair), ``lead-picks`` to let the lead choose, else the
user's default. The user is the session owner, ``local`` when there is none.
When the omnigent-ae package is not installed, the Balanced starter applies.

Helpers (2026-10-23, when the composer's Auto / Solo / Team button folded into
presets): every preset's rules carry ``helpers``, ``any`` or ``own``. The
collaboration mode the lead is told follows from it in :func:`with_roles`:
Solo when the preset keeps work in house (``own``), else Team when the label
lists sessions, else Solo for a label still saved as mode ``solo``, else Auto.
A label saved as Solo before presets had the rule reads as the ``solo`` preset
when the user has one, else the default with ``helpers`` set to ``own``.

Child sessions (2026-10-24): a session started by a lead is a helper, so its
whole notice is :data:`HELPER_NOTICE` (metadata ``{"ae_helper": True}``), never
the lead's Auto or Team text. A fork copies ``ae.orch`` but is a top-level
session the user drives, so it stays a lead.

The lead line names what the session really runs (its own model and effort,
under ``lead_session``), and says so when the preset asks for another model.
Only a Claude lead hears about Claude's Agent tool and tier aliases. A role
fixed to a model id shows the tier alias only when the id is the current one for
that tier (``current``, from the omnigent-ae package), since a bare alias
resolves to the newest version.
"""

from __future__ import annotations

import json
import logging
import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from omnigent.entities.conversation import Conversation
    from omnigent.stores.conversation_store import ConversationStore

_logger = logging.getLogger(__name__)

TEAM_LABEL = "ae.team"
ORCH_LABEL = "ae.orch"
LEAD_PICKS = "lead-picks"
LOCAL_USER = "local"
ROLES: tuple[str, ...] = ("lead", "planner", "reviewer", "builder", "helper")
LEAD_PICKS_SHOWN = 8
_LABEL_MAX = 16_384
FORK_SOURCE_LABEL = "omnigent.fork.source_id"
_ONE_M = "[1m]"
_ALIASES = ("fable", "opus", "sonnet", "haiku")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]+")

_ROLE_LABELS = {
    "lead": "Lead",
    "planner": "Planner (design, architecture, unknown root cause)",
    "reviewer": "Reviewer (reviews, verifying a finding, fix checks)",
    "builder": "Builder (code once the plan is pinned)",
    "helper": "Helper (polling, PR watching, screenshots, mechanical commits)",
}


def _fixed(model: str, effort: str) -> dict[str, str]:
    return {"mode": "fixed", "model": model, "effort": effort}


# The Balanced starter for servers without the omnigent-ae package, by tier alias
# since no catalog is known here; ae_omni_policies.role_prefs.STARTERS is canonical.
BALANCED: dict[str, Any] = {
    "id": "balanced",
    "title": "Balanced",
    "when_to_use": "Most tasks: design judgment up front, then a pinned plan built "
    "and checked at a lower cost.",
    "roles": {
        "lead": {"mode": "session"},
        "planner": _fixed("opus", "high"),
        "reviewer": _fixed("sonnet", "medium"),
        "builder": _fixed("sonnet", "medium"),
        "helper": _fixed("haiku", "low"),
    },
    "rules": {
        "raise_or_lower": "tell",
        "lead_steps_down": True,
        "auto_raises": 1,
        "helpers": "any",
    },
}
SOLO = "solo"
OWN = "own"
HELPER_KEY = "ae_helper"
HELPER_NOTICE = (
    "You are a helper session started by a lead session. Do the task you were given and "
    "report back to it; do not start other sessions or bring in other agents. Use your own "
    "native subagents only if the task needs them."
)


def _role_prefs() -> Any | None:
    """The omnigent-ae preset store module, or ``None`` when it is not installed."""
    try:
        from ae_omni_policies import role_prefs
    except ImportError:
        return None
    return role_prefs


def _load_prefs(user: str) -> tuple[str, list[dict[str, Any]]]:
    """The user's default preset id and presets; Balanced alone when unavailable."""
    module = _role_prefs()
    if module is not None:
        try:
            state = module.store().get(user).model_dump()
            presets = [p for p in state["presets"] if isinstance(p, dict)]
            if presets:
                return str(state["default_preset"]), presets
        except Exception:  # noqa: BLE001 (a broken prefs file must never block a turn)
            _logger.warning("ae roles: could not read %s's presets", user, exc_info=True)
    return BALANCED["id"], [BALANCED]


def _owner(conv: Conversation, store: ConversationStore) -> str:
    """The session owner (the root's when the session has none), else ``local``."""
    getter = getattr(store, "get_session_owner", None)
    if callable(getter):
        for conversation_id in dict.fromkeys((conv.id, conv.root_conversation_id)):
            if not conversation_id:
                continue
            try:
                owner = getter(conversation_id, owner_only=True)
            except Exception:  # noqa: BLE001 (falls back to the local user)
                _logger.warning("ae roles: owner lookup failed for %s", conversation_id)
                continue
            if isinstance(owner, str) and owner:
                return owner
    return LOCAL_USER


def _label(conv: Conversation) -> dict[str, Any] | None:
    """A well-formed ``ae.team`` label, or ``None``."""
    raw = conv.labels.get(TEAM_LABEL) if isinstance(conv.labels, dict) else None
    if not isinstance(raw, str) or not raw or len(raw) > _LABEL_MAX:
        return None
    try:
        config = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(config, dict) or config.get("version") != 1:
        return None
    return config


def _legacy_solo(conv: Conversation) -> bool:
    """True for a label still saved as mode ``solo`` (written before the Helpers rule)."""
    config = _label(conv)
    return config is not None and config.get("mode") == SOLO


def _label_override(conv: Conversation) -> dict[str, Any] | None:
    """The ``roles`` field of a well-formed ``ae.team`` label, or ``None``."""
    config = _label(conv)
    if config is None:
        return None
    roles = config.get("roles")
    if not isinstance(roles, dict) or not isinstance(roles.get("preset"), str):
        return None
    return roles


def _summary(preset: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": preset.get("id"),
        "title": preset.get("title"),
        "roles": preset.get("roles"),
        "rules": preset.get("rules"),
    }


def helpers_of(roles: object) -> str:
    """``own`` when the resolved preset keeps work with the lead's own subagents, else ``any``."""
    preset = roles.get("preset") if isinstance(roles, dict) else None
    rules = preset.get("rules") if isinstance(preset, dict) else None
    return OWN if isinstance(rules, dict) and rules.get("helpers") == OWN else "any"


def _own_helpers(roles: dict[str, Any]) -> dict[str, Any]:
    """*roles* with the resolved preset's Helpers rule set to ``own``."""
    preset = roles.get("preset")
    if not isinstance(preset, dict):
        return roles
    rules = preset.get("rules") if isinstance(preset.get("rules"), dict) else {}
    return {**roles, "preset": {**preset, "rules": {**rules, "helpers": OWN}}}


def resolve_roles(conv: Conversation, store: ConversationStore) -> dict[str, Any]:
    """The preset in force for *conv*'s next turn, as notice metadata.

    A label still saved as mode ``solo`` keeps work in house: with no ``roles``
    field it reads as the ``solo`` preset (the default when the user has none),
    and the resolved preset's Helpers rule reads as ``own`` either way.

    :returns: ``{"preset": {...}, "custom": bool}``, or ``{"lead_picks": True,
        "presets": [...], "more": n}`` when the session lets the lead choose; either
        with ``current`` (the current catalog id per tier alias).
    """
    roles = _resolve_roles(conv, store)
    roles = _own_helpers(roles) if _legacy_solo(conv) else roles
    return {**roles, "current": _current_ids()}


def _resolve_roles(conv: Conversation, store: ConversationStore) -> dict[str, Any]:
    default_id, presets = _load_prefs(_owner(conv, store))
    by_id = {p.get("id"): p for p in presets}
    override = _label_override(conv)
    chosen_id = override["preset"] if override else None
    if chosen_id is None and _legacy_solo(conv) and SOLO in by_id:
        chosen_id = SOLO
    if chosen_id == LEAD_PICKS:
        shown = presets[:LEAD_PICKS_SHOWN]
        return {
            "lead_picks": True,
            "presets": [
                {**_summary(p), "when_to_use": str(p.get("when_to_use") or "")[:200]}
                for p in shown
            ],
            "more": len(presets) - len(shown),
        }
    if chosen_id in by_id:
        preset = _summary(by_id[chosen_id])
        custom = override.get("custom") if override else None
        if custom is not None:
            module = _role_prefs()
            try:
                if module is None:
                    raise ValueError("role presets are not installed")
                checked = module.validate_custom(custom)
            except ValueError:
                checked = None
            if checked is not None:
                return {"preset": {**preset, **checked}, "custom": True}
            # An invalid customization falls back to the default, like an unknown id.
        else:
            return {"preset": preset, "custom": False}
    fallback = by_id.get(default_id) or presets[0]
    return {"preset": _summary(fallback), "custom": False}


def _is_child(conv: Conversation) -> bool:
    """True for a session with a parent or an ``ae.orch`` label holding a session id.

    A fork (``omnigent.fork.source_id``, no parent) copies its source's labels
    but is a top-level session, so it is never a child.
    """
    if getattr(conv, "parent_conversation_id", None):
        return True
    labels = conv.labels if isinstance(conv.labels, dict) else {}
    if labels.get(FORK_SOURCE_LABEL):
        return False
    orch = labels.get(ORCH_LABEL)
    return isinstance(orch, str) and orch.strip() not in ("", "1")


def with_roles(
    notice: dict[str, object] | None, conv: Conversation, store: ConversationStore
) -> dict[str, object]:
    """*notice* (or a new one) with the resolved roles under ``ae_roles``; never raises.

    A child session is a helper, not a lead: its notice is replaced by the
    helper marker that renders as :data:`HELPER_NOTICE`.
    The ``ae_team`` mode becomes the one the preset and label call for (see
    :func:`effective_mode`).
    """
    if _is_child(conv):
        return {HELPER_KEY: True}
    try:
        roles = resolve_roles(conv, store)
    except Exception:  # noqa: BLE001 (the notice must never break a message)
        _logger.warning("ae roles: could not resolve the preset; using Balanced", exc_info=True)
        roles = {"preset": _summary(BALANCED), "custom": False}
    roles = {**roles, "lead_session": _lead_session(conv)}
    return {**effective_mode(notice, roles), "ae_roles": roles}


def _lead_session(conv: Conversation) -> dict[str, object]:
    """What the session runs (its own model and effort, when set) and whether it is Claude.

    ``claude`` is ``None`` when nothing on the row says which harness runs it.
    """
    model = getattr(conv, "model_override", None)
    effort = getattr(conv, "reasoning_effort", None)
    labels = conv.labels if isinstance(conv.labels, dict) else {}
    hints = [
        hint.lower()
        for hint in (
            getattr(conv, "harness_override", None),
            labels.get("omnigent.wrapper"),
            model,
            getattr(conv, "reported_model", None),
        )
        if isinstance(hint, str) and hint.strip()
    ]
    agent = getattr(conv, "agent_id", None)
    agent = agent.lower() if isinstance(agent, str) else ""
    claude: bool | None = None
    if any(word in hint for hint in hints for word in ("claude", *_ALIASES)):
        claude = True
    elif hints or "codex" in agent:
        claude = False
    elif "claude" in agent:
        claude = True
    return {
        "model": model if isinstance(model, str) else None,
        "effort": effort if isinstance(effort, str) else None,
        "claude": claude,
    }


def _current_ids() -> dict[str, str]:
    """The current catalog id per tier alias, from the omnigent-ae package (else none)."""
    module = _role_prefs()
    if module is None:
        return {}
    current = {alias: getattr(module, alias.upper(), None) for alias in _ALIASES}
    return {alias: value for alias, value in current.items() if isinstance(value, str)}


def effective_mode(notice: dict[str, object] | None, roles: object) -> dict[str, object]:
    """*notice* with its ``ae_team`` mode set from the preset (a copy; never raises).

    Solo when the preset's Helpers rule is ``own`` (its sessions, if any, wait
    unused until another preset is picked); else Team when the label lists
    sessions that still resolve; else Solo for a legacy mode ``solo`` label; else Auto.
    """
    team = notice.get("ae_team") if isinstance(notice, dict) else None
    if not isinstance(team, dict):
        if helpers_of(roles) == OWN:
            # No readable team notice, but the preset keeps work in house.
            return {**(notice or {}), "ae_team": {"mode": SOLO, "members": []}}
        return dict(notice or {})
    mode = team.get("mode")
    if helpers_of(roles) == OWN:
        mode = SOLO
    elif mode == "team" and team.get("members"):
        return dict(notice or {})
    elif mode != SOLO:
        mode = "auto"
    return {**(notice or {}), "ae_team": {"mode": mode, "members": []}}


def solo_opening(metadata: object) -> str:
    """The Solo notice's first clause, naming the preset that keeps work in house."""
    roles = metadata.get("ae_roles") if isinstance(metadata, dict) else None
    preset = roles.get("preset") if isinstance(roles, dict) else None
    title = _text(preset.get("title"), 40) if isinstance(preset, dict) else ""
    if not title:
        return "This session keeps work in house"
    return f'This session\'s preset ("{title}") keeps work in house'


def _text(value: object, limit: int) -> str:
    return _CONTROL.sub(" ", str(value or "")).strip()[:limit]


def _comparable(model: str) -> str:
    """*model* without the 1M context suffix, lower case."""
    model = model.strip().lower()
    return model[: -len(_ONE_M)] if model.endswith(_ONE_M) else model


def _named(model: str, current: object) -> str:
    """The tier alias when *model* is its tier's current id (or the alias), else *model*."""
    plain = _comparable(model)
    if plain in _ALIASES:
        return plain
    ids = current if isinstance(current, dict) else {}
    for alias, value in ids.items():
        target = _comparable(str(value))
        if target and (
            plain == target or (plain.endswith(target) and not plain[-len(target) - 1].isalnum())
        ):
            return str(alias)
    return model


def _with_effort(model: str, effort: str, current: object) -> str:
    named = _named(model, current)
    return f"{named}, {effort}" if effort else named


def _model(setting: object, current: object = None) -> str:
    if not isinstance(setting, dict):
        return "your pick"
    mode = setting.get("mode")
    if mode == "session":
        return "the session model"
    if mode != "fixed":
        return "your pick"
    # The tier alias is what a native subagent takes, but only the current version
    # answers to it; an older version keeps its full id.
    return _with_effort(
        _text(setting.get("model"), 128), _text(setting.get("effort"), 16), current
    )


def _lead_line(lead: object, session: object, current: object) -> str:
    """The lead line: what the session runs, and the preset's model when it differs."""
    session = session if isinstance(session, dict) else {}
    model = _text(session.get("model"), 128)
    effort = _text(session.get("effort"), 16)
    actual = _with_effort(model, effort, current) if model else ""
    lead = lead if isinstance(lead, dict) else {}
    if lead.get("mode") == "fixed":
        asked = _model(lead, current)
        wanted = _comparable(_text(lead.get("model"), 128))
        same_model = bool(model) and _named(_comparable(model), current) == _named(wanted, current)
        same_effort = not effort or effort == _text(lead.get("effort"), 16)
        if not model or (same_model and same_effort):
            return f"- Lead: you, on {asked}."
        return f"- Lead: you, on {actual} (the preset asks for {asked})."
    if lead.get("mode") == "auto":
        now = f" (now {actual})" if actual else ""
        return f"- Lead: you, on the model of your pick{now}."
    if actual:
        return f"- Lead: you, on {actual} (the session model)."
    return "- Lead: you, on the session model."


def _rules_short(rules: object) -> str:
    """The model change rules in a few words, for a lead-picks line."""
    rules = rules if isinstance(rules, dict) else {}
    change = {
        "tell": "tell after",
        "ask": "ask first",
        "off": "no changes",
    }.get(str(rules.get("raise_or_lower")), "ask first")
    raises = rules.get("auto_raises")
    raises = raises if isinstance(raises, int) and not isinstance(raises, bool) else 0
    down = "steps down" if rules.get("lead_steps_down") is True else "no step down"
    helpers = "own subagents only" if rules.get("helpers") == OWN else "any agent or session"
    return f"{change}, {down}, {raises} raise{'' if raises == 1 else 's'}, {helpers}"


def _rules(rules: object) -> str:
    rules = rules if isinstance(rules, dict) else {}
    change = {
        "tell": "Model changes: raise a stuck child or lower yourself: tell the user after.",
        "ask": "Model changes: raise a stuck child or lower yourself: ask the user first.",
        "off": "Model changes: do not raise a child or lower yourself on your own.",
    }.get(str(rules.get("raise_or_lower")), "Model changes: ask the user first.")
    down = "on" if rules.get("lead_steps_down") is True else "off"
    raises = rules.get("auto_raises")
    raises = raises if isinstance(raises, int) and not isinstance(raises, bool) else 0
    past = "." if rules.get("raise_or_lower") == "off" else "; past that, ask first."
    return (
        f"{change} Step down for mechanical work: {down}. "
        f"Automatic raises per child: {raises}{past}"
    )


_TOOLS = (
    "Native subagents (Claude's Agent tool) take a tier alias (opus, sonnet, haiku, fable) "
    "and an effort. For a separate session, name its role in the brief."
)
_TOOLS_OTHER = (
    "Give a native subagent the role's model and effort where your harness supports it. "
    "For a separate session, name its role in the brief."
)


def _tools(roles: dict[str, Any]) -> str:
    """The Agent tool sentence for a Claude (or unknown) lead, else the generic one."""
    session = roles.get("lead_session")
    if isinstance(session, dict) and session.get("claude") is False:
        return _TOOLS_OTHER
    return _TOOLS


def render_roles(roles: object) -> str | None:
    """The lead's roles block (under 12 lines) for ``ae_roles`` metadata, or ``None``."""
    if not isinstance(roles, dict):
        return None
    current = roles.get("current")
    tools = _tools(roles)
    if roles.get("lead_picks") is True:
        presets = [p for p in roles.get("presets") or [] if isinstance(p, dict)]
        if not presets:
            return None
        lines = [
            "Roles preset: lead picks. Pick the preset below that fits this task and say "
            "which in one line, then name a role for each helper you start and give a "
            f"native subagent that role's model and effort. {tools}"
        ]
        for preset in presets[:LEAD_PICKS_SHOWN]:
            setting = preset.get("roles") if isinstance(preset.get("roles"), dict) else {}
            parts = [
                f"{role} {_model(setting.get(role), current)}"
                for role in ROLES
                if role != "lead"
                or not isinstance(setting.get(role), dict)
                or setting[role].get("mode") != "session"
            ]
            when = _text(preset.get("when_to_use"), 200)
            lines.append(
                f"- {_text(preset.get('title'), 40)}: {when + ' ' if when else ''}"
                f"({'; '.join(parts)}; changes: {_rules_short(preset.get('rules'))})."
            )
        more = roles.get("more")
        if isinstance(more, int) and not isinstance(more, bool) and more > 0:
            lines.append(f"({more} more presets are not shown.)")
        return "\n".join(lines)
    preset = roles.get("preset")
    if not isinstance(preset, dict):
        return None
    title = _text(preset.get("title"), 40) or "Balanced"
    if roles.get("custom") is True:
        title += " (customized for this session)"
    setting = preset.get("roles") if isinstance(preset.get("roles"), dict) else {}
    lines = [
        f"Roles preset: {title}. Name a role for each helper you start and give a native "
        f"subagent that role's model and effort. {tools}"
    ]
    lines.append(_lead_line(setting.get("lead"), roles.get("lead_session"), current))
    for role in ROLES[1:]:
        lines.append(f"- {_ROLE_LABELS[role]}: {_model(setting.get(role), current)}.")
    lines.append(_rules(preset.get("rules")))
    return "\n".join(lines)


def append_roles(text: str | None, metadata: Any) -> str | None:
    """*text* with the roles block from *metadata* appended (either may be missing).

    A child session's metadata carries only the helper marker and reads as
    :data:`HELPER_NOTICE` alone.
    """
    if isinstance(metadata, dict) and metadata.get(HELPER_KEY) is True:
        return HELPER_NOTICE
    block = render_roles(metadata.get("ae_roles")) if isinstance(metadata, dict) else None
    if text and block:
        return f"{text}\n\n{block}"
    return text or block
