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
    "rules": {"raise_or_lower": "tell", "lead_steps_down": True, "auto_raises": 1},
}


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


def _label_override(conv: Conversation) -> dict[str, Any] | None:
    """The ``roles`` field of a well-formed ``ae.team`` label, or ``None``."""
    raw = conv.labels.get(TEAM_LABEL) if isinstance(conv.labels, dict) else None
    if not isinstance(raw, str) or not raw or len(raw) > _LABEL_MAX:
        return None
    try:
        config = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(config, dict) or config.get("version") != 1:
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


def resolve_roles(conv: Conversation, store: ConversationStore) -> dict[str, Any]:
    """The preset in force for *conv*'s next turn, as notice metadata.

    :returns: ``{"preset": {...}, "custom": bool}``, or ``{"lead_picks": True,
        "presets": [...], "more": n}`` when the session lets the lead choose.
    """
    default_id, presets = _load_prefs(_owner(conv, store))
    by_id = {p.get("id"): p for p in presets}
    override = _label_override(conv)
    chosen_id = override["preset"] if override else None
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
    """True for a session with a parent or an ``ae.orch`` label holding a session id."""
    if getattr(conv, "parent_conversation_id", None):
        return True
    labels = conv.labels if isinstance(conv.labels, dict) else {}
    orch = labels.get(ORCH_LABEL)
    return isinstance(orch, str) and orch.strip() not in ("", "1")


def with_roles(
    notice: dict[str, object] | None, conv: Conversation, store: ConversationStore
) -> dict[str, object]:
    """*notice* (or a new one) with the resolved roles under ``ae_roles``; never raises.

    A child session is a helper, not a lead, so its notice is returned as is.
    """
    if _is_child(conv):
        return notice
    try:
        roles = resolve_roles(conv, store)
    except Exception:  # noqa: BLE001 (the notice must never break a message)
        _logger.warning("ae roles: could not resolve the preset; using Balanced", exc_info=True)
        roles = {"preset": _summary(BALANCED), "custom": False}
    return {**(notice or {}), "ae_roles": roles}


def _text(value: object, limit: int) -> str:
    return _CONTROL.sub(" ", str(value or "")).strip()[:limit]


def _model(setting: object) -> str:
    if not isinstance(setting, dict):
        return "your pick"
    mode = setting.get("mode")
    if mode == "session":
        return "the session model"
    if mode != "fixed":
        return "your pick"
    model = _text(setting.get("model"), 128)
    effort = _text(setting.get("effort"), 16)
    alias = next((a for a in _ALIASES if a in model.lower()), None)
    named = f"{alias} / {model}" if alias and alias != model.lower() else model
    return f"{named}, {effort}" if effort else named


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
    return f"{change}, {down}, {raises} raise{'' if raises == 1 else 's'}"


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
    return (
        f"{change} Step down for mechanical work: {down}. "
        f"Automatic raises per child: {raises}; past that, ask first."
    )


_TOOLS = (
    "The Agent tool takes tier aliases (opus, sonnet, haiku, fable); sessions take catalog ids."
)


def render_roles(roles: object) -> str | None:
    """The lead's roles block (under 12 lines) for ``ae_roles`` metadata, or ``None``."""
    if not isinstance(roles, dict):
        return None
    if roles.get("lead_picks") is True:
        presets = [p for p in roles.get("presets") or [] if isinstance(p, dict)]
        if not presets:
            return None
        lines = [
            "Roles preset: lead picks. Pick the preset below that fits this task and say "
            "which in one line, then name a role for each helper you start and give it "
            f"that role's model and effort. {_TOOLS}"
        ]
        for preset in presets[:LEAD_PICKS_SHOWN]:
            setting = preset.get("roles") if isinstance(preset.get("roles"), dict) else {}
            parts = [
                f"{role} {_model(setting.get(role))}"
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
        f"Roles preset: {title}. Name a role for each helper you start and give it that "
        f"role's model and effort. {_TOOLS}"
    ]
    lead = setting.get("lead")
    if isinstance(lead, dict) and lead.get("mode") == "fixed":
        lines.append(f"- Lead: you, on {_model(lead)}.")
    elif isinstance(lead, dict) and lead.get("mode") == "auto":
        lines.append("- Lead: you, on the model of your pick.")
    else:
        lines.append("- Lead: you, on the session model.")
    for role in ROLES[1:]:
        lines.append(f"- {_ROLE_LABELS[role]}: {_model(setting.get(role))}.")
    lines.append(_rules(preset.get("rules")))
    return "\n".join(lines)


def append_roles(text: str | None, metadata: Any) -> str | None:
    """*text* with the roles block from *metadata* appended (either may be missing)."""
    block = render_roles(metadata.get("ae_roles")) if isinstance(metadata, dict) else None
    if text and block:
        return f"{text}\n\n{block}"
    return text or block
