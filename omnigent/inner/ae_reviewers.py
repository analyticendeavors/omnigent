"""Several reviewers per role preset in the lead notice.

Added 2026-10-24 by omnigent-ae (multiple reviewers per preset). A preset's
``roles.reviewer`` is one role setting, as before, or ``{"mode": "multi",
"reviewers": [slot, ...]}`` with 1 to 3 slots (``ae_omni_policies.role_prefs``
owns the shape). A slot is a Claude model and effort run as a native subagent,
``auto`` (slot 1 only), or another agent (``{"mode": "agent", "agent": id,
"name": ..., "model": ..., "effort": ...}``) run as a fresh child session each
review, so no reviewer carries what it saw last round.

With two or more reviewers the lead runs them all at the final review without
asking, on the same diff, never showing one reviewer's findings to another, and
merges them into one verdict. That replaces the separate /dual-review offer in
chats on such a preset; the notice says so plainly. Fix checks and verifying a
single finding stay with reviewer 1. The preset's rules pick how results are
shown (``review_merge``) and what happens when a reviewer cannot start
(``reviewer_unavailable``). A preset whose Helpers rule keeps work with the
lead's own subagents (``own``) cannot start child sessions, so its agent slots
are named as skipped.

:func:`ae_roles.render_roles` calls :func:`reviewer_lines` for the preset in
force and :func:`reviewers_short` for each lead-picks line.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from omnigent.inner.ae_text import OWN
from omnigent.inner.ae_text import text as _text

MAX_REVIEWERS = 3
MULTI = "multi"
AGENT = "agent"
_LABEL = "Reviewer (reviews, verifying a finding, fix checks)"
_LABEL_MANY = "Reviewers (final review of a build)"

ModelText = Callable[[object, object], str]


def slots(setting: object) -> list[dict[str, object]]:
    """The reviewer slots of a ``roles.reviewer`` value: one for a plain setting, up to three."""
    if not isinstance(setting, dict):
        return []
    if setting.get("mode") != MULTI:
        return [setting]
    raw = setting.get("reviewers")
    if not isinstance(raw, list):
        return []
    return [slot for slot in raw if isinstance(slot, dict)][:MAX_REVIEWERS]


def _is_agent(slot: dict[str, object]) -> bool:
    return slot.get("mode") == AGENT and bool(_text(slot.get("agent"), 128))


def _agent_name(slot: dict[str, object]) -> str:
    return _text(slot.get("name"), 40) or "the agent"


def resolve_agents(roles: dict[str, Any], lookup: Callable[[str], str | None]) -> dict[str, Any]:
    """*roles* (resolved notice metadata) with each agent slot's id looked up by its name.

    An install seeded before the id scheme keeps a random id for a built-in agent
    row, so a slot that carries ``agent_name`` gets the live id from *lookup*; a
    name that is unknown keeps the stored id. Returns copies; never raises.
    """

    def settled(setting: object) -> object:
        if not isinstance(setting, dict) or setting.get("mode") != MULTI:
            return fixed_slot(setting)
        raw = setting.get("reviewers")
        if not isinstance(raw, list):
            return setting
        return {**setting, "reviewers": [fixed_slot(slot) for slot in raw]}

    def fixed_slot(slot: object) -> object:
        if not isinstance(slot, dict) or slot.get("mode") != AGENT:
            return slot
        name = _text(slot.get("agent_name"), 64)
        if not name:
            return slot
        try:
            live = lookup(name)
        except Exception:  # noqa: BLE001 (an unreadable agent list keeps the stored id)
            live = None
        return {**slot, "agent": live} if isinstance(live, str) and live else slot

    def preset_of(preset: object) -> object:
        setting = preset.get("roles") if isinstance(preset, dict) else None
        if not isinstance(setting, dict) or "reviewer" not in setting:
            return preset
        assert isinstance(preset, dict)
        return {**preset, "roles": {**setting, "reviewer": settled(setting["reviewer"])}}

    resolved = dict(roles)
    if isinstance(roles.get("preset"), dict):
        resolved["preset"] = preset_of(roles["preset"])
    if isinstance(roles.get("presets"), list):
        resolved["presets"] = [preset_of(p) for p in roles["presets"]]
    return resolved


def _agent(slot: dict[str, object], *, brief: bool = False) -> str:
    """An agent slot: who it is and how to start it, with only the arguments it fixes."""
    agent = _text(slot.get("agent"), 128)
    model = _text(slot.get("model"), 128)
    effort = _text(slot.get("effort"), 16)
    args = [f"agent_id {agent}"]
    if model:
        args.append(f"model {model}")
    if effort:
        args.append(f"reasoning_effort {effort}")
    defaults = [word for word, value in (("model", model), ("effort", effort)) if not value]
    default = f"; its default {' and '.join(defaults)}" if defaults else ""
    if brief:
        return f"{_agent_name(slot)} (fresh child session: sys_session_create {', '.join(args)})"
    return (
        f"{_agent_name(slot)} agent (a fresh child session each review: "
        f"sys_session_create with {', '.join(args)}{default})"
    )


def _claude(slot: dict[str, object], model_text: ModelText, current: object) -> str:
    return f"{model_text(slot, current)} (native subagent)"


def _split(
    found: list[dict[str, object]], rules: dict[str, object]
) -> tuple[list[dict[str, object]], str]:
    """The slots that can run under the Helpers rule, and a note naming the skipped agents."""
    own = rules.get("helpers") == OWN
    skipped = [_agent_name(slot) for slot in found if own and _is_agent(slot)]
    usable = [slot for slot in found if not (own and _is_agent(slot))]
    note = (
        f"{' and '.join(skipped)} skipped: this preset keeps work with your own subagents"
        if skipped
        else ""
    )
    return usable, note


def reviewer_lines(
    setting: object, rules: object, current: object, model_text: ModelText
) -> list[str]:
    """The notice lines for *setting*: one line for one reviewer, three for two or more.

    :param setting: The preset's ``roles.reviewer`` value.
    :param rules: The preset's rules (``review_merge``, ``reviewer_unavailable``, ``helpers``).
    :param current: The current catalog id per tier alias.
    :param model_text: Renders a Claude setting as the rest of the notice does.
    """
    rules = rules if isinstance(rules, dict) else {}
    usable, skip_note = _split(slots(setting), rules)
    if len(usable) < 2:
        if not usable:
            one = "your pick"
        elif _is_agent(usable[0]):
            one = f"{_agent(usable[0])}; a review never goes to an existing child session"
        else:
            one = model_text(usable[0], current)
        note = f" ({skip_note})" if skip_note else ""
        return [f"- {_LABEL}: {one}{note}."]
    listed = " ".join(
        f"{index}. {_agent(slot) if _is_agent(slot) else _claude(slot, model_text, current)}."
        for index, slot in enumerate(usable, start=1)
    )
    lists = (
        "show each reviewer's list first"
        if rules.get("review_merge") == "separate"
        else "keep each reviewer's list under it"
    )
    unavailable = (
        "A reviewer that cannot start: ask the user before reviewing."
        if rules.get("reviewer_unavailable") == "ask"
        else "A reviewer that cannot start: skip it, review with the rest and say so."
    )
    if skip_note:
        unavailable += f" {skip_note[0].upper()}{skip_note[1:]}."
    return [
        f"- {_LABEL_MANY}: {listed}",
        "  These reviewers replace the /dual-review offer; run them when the work is done, "
        "without asking. Give every reviewer the same diff and brief, run them at once, never "
        "show one reviewer's findings to another. Never hand a review to an existing child "
        "session, including one added to this chat: this overrides reusing sessions or "
        "handing work to the team, for reviews only. Then merge into one verdict: dedupe, "
        "mark agreements, settle each disagreement with a one-line reason, rank by severity, "
        f"{lists}.",
        f"  Fix checks and verifying one finding: reviewer 1 only. {unavailable}",
    ]


def reviewers_short(setting: object, rules: object, current: object, model_text: ModelText) -> str:
    """A lead-picks part: ``reviewer sonnet, medium``, or with agents how to start them.

    A preset with two or more reviewers or an agent reviewer carries what the lead
    needs after picking it: how to start each agent (the resolved id), the merge and
    unavailable rules when they differ from the defaults, and skipped agents under
    the Helpers rule. The lead's pick is not written to the session label, so the
    next turn's notice lists the picks again rather than this preset in full.
    """
    rules = rules if isinstance(rules, dict) else {}
    found = slots(setting)
    if not found:
        return f"reviewer {model_text(setting, current)}"
    if not any(_is_agent(slot) for slot in found) and len(found) < 2:
        return f"reviewer {model_text(found[0], current)}"
    usable, skip_note = _split(found, rules)
    names = [
        _agent(slot, brief=True) if _is_agent(slot) else model_text(slot, current)
        for slot in usable
    ]
    text = f"reviewer{'s' if len(names) > 1 else ''} {' + '.join(names) or 'your pick'}"
    if len(usable) > 1:
        if rules.get("review_merge") == "separate":
            text += "; show each reviewer's list first"
        if rules.get("reviewer_unavailable") == "ask":
            text += "; ask first if one cannot start"
    if skip_note:
        text += f"; {skip_note}"
    return text


def several(setting: object) -> bool:
    """Whether *setting* names two or more reviewers."""
    return len(slots(setting)) > 1


def explained(setting: object) -> bool:
    """Whether a lead-picks line for *setting* needs :data:`MANY_PICKS` to make sense."""
    return several(setting) or any(_is_agent(slot) for slot in slots(setting))


MANY_PICKS = (
    "Reviewers named with an agent or with several: run all of them at the final review "
    "without asking (they replace the /dual-review offer), each alone on the same diff "
    "(never show one's findings to another), then merge into one verdict: dedupe, mark "
    "agreements, settle disagreements, rank by severity; unless the line says otherwise, "
    "keep each list under it and, for a reviewer that cannot start, skip it and say so. "
    "Agents run as a fresh child session each review, never an existing one; fix checks go "
    "to reviewer 1."
)
