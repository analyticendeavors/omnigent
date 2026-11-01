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
are named as skipped. The planner, builder and helper settings may also be a Codex
slot (2026-10-26, :func:`worker_text`); the same rule skips it.

A Claude or agent slot may name a reviewer persona (``"persona": id``, 2026-11-01;
``ae_omni_policies.personas`` owns the built-in ones and the user's own). A persona has a
name, a purpose, an optional model and effort (the slot's own override them), a ``when`` of
``always`` or ``risky`` and instructions. The slot's line gains the persona's name and
purpose, and for a risky persona the trigger that decides whether it runs; the full
instructions of only the personas the preset uses follow once, to be copied word for word
into that reviewer's brief. Slot 1 takes the fix checks, so it always runs whatever its
persona says. A persona that no longer exists reads as a plain reviewer with a one-line
note. A slot without a persona renders exactly as before.

:func:`attach_personas` looks the personas up when the notice metadata is resolved, so the
rendering functions here take plain data.

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
CODEX_AGENT_ID = "16a06503889b0c3034496821afd41b9e"
CODEX_AGENT_NAME = "codex-native-ui"
_LABEL = "Reviewer (reviews, verifying a finding, fix checks)"
_LABEL_MANY = "Reviewers (final review of a build)"

INSTRUCTIONS_MAX = 1000
_LINE_MAX = 240
_NO_TRIGGER = "the diff is relevant to this persona (see its instructions); otherwise skip it"

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


def _is_codex(slot: dict[str, object]) -> bool:
    return (
        _text(slot.get("agent"), 128) == CODEX_AGENT_ID
        or _text(slot.get("agent_name"), 64) == CODEX_AGENT_NAME
    )


def _agent_name(slot: dict[str, object]) -> str:
    return _text(slot.get("name"), 40) or "the agent"


WORKERS = ("planner", "builder", "helper")


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
        if not isinstance(setting, dict):
            return preset
        assert isinstance(preset, dict)
        changed = {
            role: settled(setting[role]) for role in ("reviewer", *WORKERS) if role in setting
        }
        return {**preset, "roles": {**setting, **changed}} if changed else preset

    resolved = dict(roles)
    if isinstance(roles.get("preset"), dict):
        resolved["preset"] = preset_of(roles["preset"])
    if isinstance(roles.get("presets"), list):
        resolved["presets"] = [preset_of(p) for p in roles["presets"]]
    return resolved


def _agent(slot: dict[str, object], *, brief: bool = False, role: str = "reviewer") -> str:
    """An agent slot: who it is and how to start it, with only the arguments it fixes."""
    agent = _text(slot.get("agent"), 128)
    model = _text(slot.get("model"), 128)
    effort = _text(slot.get("effort"), 16)
    codex = _is_codex(slot)
    # A Codex reviewer started by create_session joins the lead's family (capped, listed,
    # raisable); one started by sys_session_create is a bare child outside it.
    args = [f'role "{role}"', 'harness "codex"'] if codex else [f"agent_id {agent}"]
    if model:
        args.append(f"model {model}")
    if effort:
        args.append(f"{'effort' if codex else 'reasoning_effort'} {effort}")
    defaults = [word for word, value in (("model", model), ("effort", effort)) if not value]
    default = f"; its default {' and '.join(defaults)}" if defaults else ""
    if codex:
        if role == "reviewer":
            title = ", a title naming the review round, and workspace the repo under review"
        else:
            title = ", a title naming the task, and workspace the task's repo"
        if brief:
            return f"{_agent_name(slot)} (fresh session: create_session {', '.join(args)}{title})"
        return (
            f"{_agent_name(slot)} agent (a fresh session each "
            f"{'review' if role == 'reviewer' else 'task'}: create_session with "
            f"{', '.join(args)}{title}{default})"
        )
    if brief:
        return f"{_agent_name(slot)} (fresh child session: sys_session_create {', '.join(args)})"
    return (
        f"{_agent_name(slot)} agent (a fresh child session each "
        f"{'review' if role == 'reviewer' else 'task'}: "
        f"sys_session_create with {', '.join(args)}{default})"
    )


def _claude(slot: dict[str, object], model_text: ModelText, current: object) -> str:
    return f"{model_text(slot, current)} (native subagent)"


def _persona_of(slot: dict[str, object]) -> dict[str, object] | None:
    found = slot.get("_persona")
    return found if isinstance(found, dict) else None


def _is_risky(slot: dict[str, object]) -> bool:
    return slot.get("_risky") is True


def _scope(slot: dict[str, object]) -> str:
    """What a slot's persona adds to its listing; empty for a slot without one."""
    persona = _persona_of(slot)
    if persona is None:
        missing = slot.get("_missing")
        if missing:
            return f"persona {_text(missing, 40)} not found, so a plain review"
        return ""
    name = _text(persona.get("name"), 40) or "Persona"
    purpose = _text(persona.get("purpose"), _LINE_MAX)
    out = f"{name}: {purpose}" if purpose else name
    if _is_risky(slot):
        trigger = _text(persona.get("trigger"), _LINE_MAX)
        out += (
            f", run only when the diff touches {trigger}"
            if trigger
            else f", run only when {_NO_TRIGGER}"
        )
    return out


def _slot_text(slot: dict[str, object], model_text: ModelText, current: object) -> str:
    base = _agent(slot) if _is_agent(slot) else _claude(slot, model_text, current)
    scope = _scope(slot)
    return f"{base}, {scope}" if scope else base


def _prepared(found: list[dict[str, object]], personas: object) -> list[dict[str, object]]:
    """*found* with each slot's persona applied: its model and effort filled in where the
    slot leaves them out, and private ``_persona``, ``_risky`` and ``_missing`` keys the
    renderers read. A slot without a persona is returned as it is."""
    known = personas if isinstance(personas, dict) else {}
    out: list[dict[str, object]] = []
    for index, slot in enumerate(found):
        pid = slot.get("persona")
        if not isinstance(pid, str) or not pid:
            out.append(slot)
            continue
        persona = known.get(pid)
        if not isinstance(persona, dict):
            kept = slot if slot.get("model") or slot.get("mode") != "fixed" else {"mode": "auto"}
            out.append({**kept, "_missing": pid})
            continue
        merged = dict(slot)
        if merged.get("mode") == "fixed":
            # A persona's model is a Claude one, so another agent's slot keeps its own.
            for key in ("model", "effort"):
                if not merged.get(key) and persona.get(key):
                    merged[key] = persona[key]
            if not merged.get("model"):
                merged = {"mode": "auto"}
            elif not merged.get("effort"):
                merged["effort"] = "medium"
        merged["_persona"] = persona
        # Reviewer 1 takes the fix checks, so it runs whatever its persona says.
        merged["_risky"] = persona.get("when") == "risky" and index > 0
        out.append(merged)
    return out


def _persona_block(usable: list[dict[str, object]]) -> list[str]:
    """The instructions of the personas these slots use, once each, as quoted lines.

    Every instruction line starts with ``> `` so text a user wrote cannot pass for a line of
    the notice; control characters are dropped and the length is capped again here.
    """
    lines: list[str] = []
    seen: set[int] = set()
    for slot in usable:
        persona = _persona_of(slot)
        if persona is None or id(persona) in seen:
            continue
        seen.add(id(persona))
        name = _text(persona.get("name"), 40) or "Persona"
        raw = str(persona.get("instructions") or "")[:INSTRUCTIONS_MAX]
        body = [_text(part, INSTRUCTIONS_MAX) for part in raw.splitlines()]
        body = [part for part in body if part]
        if not body:
            continue
        lines.append(
            f"  {name} reviewer instructions (copy these word for word into that reviewer's "
            "brief):"
        )
        lines += [f"  > {part}" for part in body]
    return lines


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


def worker_text(
    role: str,
    setting: object,
    rules: object,
    current: object,
    model_text: ModelText,
    *,
    brief: bool = False,
) -> str:
    """A planner, builder or helper setting as notice text (Claude model, or a Codex session).

    A Codex slot says how to start it with this *role*; under the Helpers rule ``own`` it
    is named as skipped, since the lead cannot start child sessions then.
    """
    if not isinstance(setting, dict) or not _is_agent(setting):
        return model_text(setting, current)
    if isinstance(rules, dict) and rules.get("helpers") == OWN:
        return (
            f"{_agent_name(setting)} skipped: this preset keeps work with your own "
            "subagents, so use a native subagent of your pick"
        )
    return _agent(setting, brief=brief, role=role)


def reviewer_lines(
    setting: object,
    rules: object,
    current: object,
    model_text: ModelText,
    personas: object = None,
) -> list[str]:
    """The notice lines for *setting*: one line for one reviewer, three for two or more.

    :param setting: The preset's ``roles.reviewer`` value.
    :param rules: The preset's rules (``review_merge``, ``reviewer_unavailable``, ``helpers``).
    :param current: The current catalog id per tier alias.
    :param model_text: Renders a Claude setting as the rest of the notice does.
    :param personas: The personas the slots name, by id (see :func:`attach_personas`).
    """
    rules = rules if isinstance(rules, dict) else {}
    usable, skip_note = _split(_prepared(slots(setting), personas), rules)
    if len(usable) < 2:
        if not usable:
            one = "your pick"
        elif _is_agent(usable[0]):
            one = f"{_agent(usable[0])}; a review never goes to an existing session"
        else:
            one = model_text(usable[0], current)
        if usable and _scope(usable[0]):
            one += f", {_scope(usable[0])}"
        note = f" ({skip_note})" if skip_note else ""
        return [f"- {_LABEL}: {one}{note}.", *_persona_block(usable)]
    listed = " ".join(
        f"{index}. {_slot_text(slot, model_text, current)}."
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
    risky = [index for index, slot in enumerate(usable, start=1) if _is_risky(slot)]
    skipped_when = (
        f" Reviewer{'s' if len(risky) > 1 else ''} {' and '.join(map(str, risky))} "
        f"{'run' if len(risky) > 1 else 'runs'} only when the diff is risky as listed; "
        "when it is not, skip "
        f"{'them' if len(risky) > 1 else 'it'}, say so in one line, and merge the rest as usual."
        if risky
        else ""
    )
    return [
        f"- {_LABEL_MANY}: {listed}",
        "  These reviewers replace the /dual-review offer; run them when the work is done, "
        "without asking. Give every reviewer the same diff and brief, run them at once, never "
        "show one reviewer's findings to another. Never hand a review to an existing "
        "session, including one added to this chat: this overrides reusing sessions or "
        "handing work to the team, for reviews only. Then merge into one verdict: dedupe, "
        "mark agreements, settle each disagreement with a one-line reason, rank by severity, "
        f"{lists}.",
        f"  Fix checks and verifying one finding: reviewer 1 only. {unavailable}{skipped_when}",
        *_persona_block(usable),
    ]


def reviewers_short(
    setting: object,
    rules: object,
    current: object,
    model_text: ModelText,
    personas: object = None,
) -> str:
    """A lead-picks part: ``reviewer sonnet, medium``, or with agents how to start them.

    A preset with two or more reviewers or an agent reviewer carries what the lead
    needs after picking it: how to start each agent (the resolved id), the merge and
    unavailable rules when they differ from the defaults, and skipped agents under
    the Helpers rule. The lead's pick is not written to the session label, so the
    next turn's notice lists the picks again rather than this preset in full.
    """
    rules = rules if isinstance(rules, dict) else {}
    found = _prepared(slots(setting), personas)
    if not found:
        return f"reviewer {model_text(setting, current)}"
    if not any(_is_agent(slot) or "persona" in slot for slot in found) and len(found) < 2:
        return f"reviewer {model_text(found[0], current)}"
    usable, skip_note = _split(found, rules)
    names = [
        (_agent(slot, brief=True) if _is_agent(slot) else model_text(slot, current))
        + _persona_tag(slot)
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


def _persona_tag(slot: dict[str, object]) -> str:
    """`` (Security, only if risky)`` for a lead-picks part: the name, never the instructions."""
    persona = _persona_of(slot)
    if persona is None:
        return ""
    name = _text(persona.get("name"), 40) or "persona"
    return f" ({name}, only if risky)" if _is_risky(slot) else f" ({name})"


def persona_ids(roles: object) -> list[str]:
    """The persona ids named by the preset(s) in notice metadata, in order, each once."""
    if not isinstance(roles, dict):
        return []
    presets = [roles["preset"]] if isinstance(roles.get("preset"), dict) else []
    if isinstance(roles.get("presets"), list):
        presets += [p for p in roles["presets"] if isinstance(p, dict)]
    found: list[str] = []
    for preset in presets:
        setting = preset.get("roles") if isinstance(preset.get("roles"), dict) else {}
        for slot in slots(setting.get("reviewer")):
            pid = slot.get("persona")
            if isinstance(pid, str) and pid and pid not in found:
                found.append(pid)
    return found


def attach_personas(
    roles: dict[str, Any], lookup: Callable[[str], dict[str, Any] | None]
) -> dict[str, Any]:
    """*roles* (resolved notice metadata) with ``personas``: id to persona for each one used.

    Only the personas the preset (or, on a lead-picks session, the shown presets) names are
    attached, so the notice never carries the rest. An id *lookup* does not know is left out
    and reads as a plain reviewer. Never raises.
    """
    found: dict[str, Any] = {}
    for pid in persona_ids(roles):
        try:
            persona = lookup(pid)
        except Exception:  # noqa: BLE001 (an unreadable store leaves the reviewer plain)
            persona = None
        if isinstance(persona, dict):
            found[pid] = persona
    return {**roles, "personas": found} if found else roles


def persona_lookup(user: str) -> Callable[[str], dict[str, Any] | None]:
    """A function that finds a persona (a built-in, else *user*'s own) as plain data.

    Answers ``None`` for an unknown id, and for everything when ``ae_omni_policies`` is not
    installed or the user's presets cannot be read.
    """

    def lookup(persona_id: str) -> dict[str, Any] | None:
        try:
            from ae_omni_policies import role_prefs
        except ImportError:
            return None
        found = role_prefs.find_persona(role_prefs.store().get(user), persona_id)
        return found.model_dump(exclude_none=True) if found is not None else None

    return lookup


def picks_personas_block(presets: list[dict[str, Any]], personas: object) -> list[str]:
    """The instructions of the personas the lead-picks presets use, for the lead to copy once
    it has chosen a preset; empty when none use one."""
    chosen: list[dict[str, object]] = []
    for preset in presets:
        setting = preset.get("roles") if isinstance(preset.get("roles"), dict) else {}
        chosen += [
            s for s in _prepared(slots(setting.get("reviewer")), personas) if _persona_of(s)
        ]
    block = _persona_block(chosen)
    if not block:
        return []
    return ["Reviewer personas the presets above use (once you pick one):", *block]


def several(setting: object) -> bool:
    """Whether *setting* names two or more reviewers."""
    return len(slots(setting)) > 1


def explained(setting: object) -> bool:
    """Whether a lead-picks line for *setting* needs :data:`MANY_PICKS` to make sense."""
    return several(setting) or any(_is_agent(slot) or "persona" in slot for slot in slots(setting))


MANY_PICKS = (
    "Reviewers named with an agent or with several: run all of them at the final review "
    "without asking (they replace the /dual-review offer), each alone on the same diff "
    "(never show one's findings to another), then merge into one verdict: dedupe, mark "
    "agreements, settle disagreements, rank by severity; unless the line says otherwise, "
    "keep each list under it and, for a reviewer that cannot start, skip it and say so. "
    "Agents run as a fresh session each review, never an existing one; fix checks go "
    "to reviewer 1. A reviewer with a persona in brackets reviews as that persona; one "
    "marked only if risky runs only when the diff meets that persona's trigger, otherwise "
    "skip it and merge the rest as usual. The persona instructions follow the list."
)
