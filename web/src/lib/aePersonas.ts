// Reviewer personas (omnigent-ae, 2026-11-01, patch 0277): a named reviewer brief a
// preset's reviewer slot can point at. The server (ae_omni_policies personas.py) owns the
// five built-in ones (read-only, sent as `builtin_personas`) and stores the user's own
// (`personas`, at most 20). This file parses, lists and edits them, and works out what a
// slot that names one runs on.

import { AE_ROLE_EFFORTS, type AeRoleEffort } from "@/lib/aeRoleBase";
import type { AeReviewerSetting, AeReviewerSlot } from "@/lib/aeReviewers";
import { aeReviewerList, aeWriteReviewers } from "@/lib/aeReviewers";

export const AE_PERSONAS_MAX = 20;
export const AE_PERSONA_NAME_MAX = 40;
export const AE_PERSONA_PURPOSE_MAX = 200;
export const AE_PERSONA_TRIGGER_MAX = 200;
export const AE_PERSONA_INSTRUCTIONS_MAX = 1000;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Bidi overrides and isolates, zero-width and other invisible characters (the server refuses them). */
const HIDDEN = new Set([
  0x00ad,
  0x034f,
  0x061c,
  0x180e,
  0x2028,
  0x2029,
  0x2060,
  0x2061,
  0x2062,
  0x2063,
  0x2064,
  0xfeff,
  ...Array.from({ length: 5 }, (_, n) => 0x200b + n), // zero-width space to left-to-right mark
  0x200f,
  ...Array.from({ length: 5 }, (_, n) => 0x202a + n), // embeddings and overrides
  ...Array.from({ length: 4 }, (_, n) => 0x2066 + n), // isolates
]);

/**
 * Plain words for the first character the server refuses in `text`, or null: a control or C1
 * control character, a line or paragraph separator, or an invisible or direction-changing
 * character. `keep` lists characters allowed (instructions keep newline and tab).
 */
export function aeBadCharacter(text: string, keep = ""): string | null {
  for (const char of text) {
    if (keep.includes(char)) continue;
    const code = char.codePointAt(0) ?? 0;
    const hex = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    if (HIDDEN.has(code)) return `an invisible or direction-changing character (${hex})`;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return `a control character (${hex})`;
  }
  return null;
}

export type AePersonaWhen = "always" | "risky";

export const AE_PERSONA_WHEN_OPTIONS: { value: AePersonaWhen; label: string }[] = [
  { value: "always", label: "Always" },
  { value: "risky", label: "Only if the diff is risky" },
];

export interface AePersona {
  id: string;
  name: string;
  purpose: string;
  /** Absent: the slot's model, else the lead's pick. */
  model?: string;
  effort?: AeRoleEffort;
  when: AePersonaWhen;
  /** What makes a diff worth this reviewer, for `when: "risky"`; absent: the instructions say. */
  trigger?: string;
  /** Multi-line text the lead copies into the reviewer's brief. */
  instructions: string;
}

/** A persona with where it comes from, as the lists and the slot select show it. */
export interface AePersonaEntry extends AePersona {
  builtin: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** One persona from a server body, or null when it is malformed. */
export function aeParsePersona(value: unknown): AePersona | null {
  if (!isObject(value)) return null;
  const { id, name, purpose, model, effort, when, trigger, instructions } = value;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  if (typeof name !== "string" || typeof purpose !== "string") return null;
  if (typeof instructions !== "string") return null;
  if (model != null && (typeof model !== "string" || !model)) return null;
  if (effort != null && !(AE_ROLE_EFFORTS as readonly unknown[]).includes(effort)) return null;
  if (when != null && when !== "always" && when !== "risky") return null;
  if (trigger != null && typeof trigger !== "string") return null;
  return {
    id,
    name,
    purpose,
    ...(typeof model === "string" ? { model } : {}),
    ...(effort != null ? { effort: effort as AeRoleEffort } : {}),
    when: when === "risky" ? "risky" : "always",
    ...(typeof trigger === "string" && trigger ? { trigger } : {}),
    instructions,
  };
}

/**
 * The well-formed personas of `value`, or null when it is not an array. A malformed entry is
 * skipped on its own, so one bad persona never hides the rest (review fix, patch 0278).
 */
export function aeParsePersonas(value: unknown): AePersona[] | null {
  if (!Array.isArray(value)) return null;
  return value.map(aeParsePersona).filter((p): p is AePersona => p !== null);
}

/** The built-in personas first, then the user's own. */
export function aeAllPersonas(
  builtin: readonly AePersona[],
  mine: readonly AePersona[] | undefined,
): AePersonaEntry[] {
  return [
    ...builtin.map((p) => ({ ...p, builtin: true })),
    ...(mine ?? []).map((p) => ({ ...p, builtin: false })),
  ];
}

/** The persona a slot names, or null when it names none or the persona is gone. */
export function aePersonaOf(
  slot: AeReviewerSlot,
  personas: readonly AePersonaEntry[],
): AePersonaEntry | null {
  const id = slot.mode === "auto" ? undefined : slot.persona;
  return id ? (personas.find((p) => p.id === id) ?? null) : null;
}

/**
 * The slot as the model and effort pickers should show it: a Claude slot that leaves them
 * out takes its persona's; with neither it reads as Auto (the lead's pick). Another agent's
 * slot keeps its own (a persona's model is a Claude one).
 */
export function aeEffectiveSlot(
  slot: AeReviewerSlot,
  personas: readonly AePersonaEntry[],
): AeReviewerSlot {
  if (slot.mode !== "fixed") return slot;
  const persona = aePersonaOf(slot, personas);
  const model = slot.model ?? persona?.model;
  if (!model) return { mode: "auto" };
  return { mode: "fixed", model, effort: slot.effort ?? persona?.effort ?? "medium" };
}

/** Whether reviewer 1 may not use this persona: it runs only when the diff is risky. */
export function aePersonaBarredFromFirst(persona: AePersona): boolean {
  return persona.when === "risky";
}

interface PresetLike {
  id?: string;
  title: string;
  roles: { reviewer: AeReviewerSetting };
}

const namesPersona = (setting: AeReviewerSetting, personaId: string): boolean =>
  aeReviewerList(setting).some((slot) => slot.mode !== "auto" && slot.persona === personaId);

/**
 * The presets (by title) whose reviewer slots name this persona, in the saved list or in an
 * unsaved draft of one (`drafts`, keyed by preset id). Each preset is named once.
 */
export function aePersonaUsers(
  presets: readonly PresetLike[],
  personaId: string,
  drafts: Readonly<Record<string, { roles: { reviewer: AeReviewerSetting } }>> = {},
): string[] {
  return presets
    .filter(
      (preset) =>
        namesPersona(
          (preset.id !== undefined ? drafts[preset.id]?.roles.reviewer : undefined) ??
            preset.roles.reviewer,
          personaId,
        ) || namesPersona(preset.roles.reviewer, personaId),
    )
    .map((preset) => preset.title);
}

/**
 * `setting` with every slot that names `persona` turned into a plain reviewer: the persona's
 * model and effort are written into a slot that had none of its own, so deleting the persona
 * leaves a valid reviewer that runs the same way. A persona with no model gives Sonnet
 * (medium); another agent's slot only loses the persona (a persona's model is a Claude one).
 */
export function aeRetirePersona(setting: AeReviewerSetting, persona: AePersona): AeReviewerSetting {
  if (!namesPersona(setting, persona.id)) return setting;
  const slots = aeReviewerList(setting).map((slot): AeReviewerSlot => {
    if (slot.mode === "auto" || slot.persona !== persona.id) return slot;
    const { persona: _gone, ...rest } = slot;
    if (rest.mode === "agent") return rest;
    return {
      mode: "fixed",
      model: rest.model ?? persona.model ?? "claude-sonnet-5-5",
      effort: rest.effort ?? persona.effort ?? "medium",
    };
  });
  return aeWriteReviewers(slots);
}

/** A new persona id from a name, not in `inUse` (which includes the built-in ids). */
export function aePersonaId(name: string, inUse: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "persona";
  const start = ID_PATTERN.test(base) ? base : `p-${base}`.slice(0, 32);
  if (!inUse.includes(start)) return start;
  for (let n = 2; ; n += 1) {
    const candidate = `${start}-${n}`;
    if (!inUse.includes(candidate)) return candidate;
  }
}

/** A copy of `persona` as a new user persona: a new id, the name marked, never built-in. */
export function aeDuplicatePersona(persona: AePersona, inUse: readonly string[]): AePersona {
  const name = `${persona.name} copy`.slice(0, AE_PERSONA_NAME_MAX);
  return { ...persona, id: aePersonaId(name, inUse), name };
}

/** What is wrong with a persona draft, in the words the form shows; empty when it saves. */
export function aePersonaProblems(draft: Omit<AePersona, "id">): string[] {
  const problems: string[] = [];
  // A text that is too long or holds a refused character says which, in plain words.
  const check = (label: string, text: string, max: number, keep = "") => {
    const bad = aeBadCharacter(text, keep);
    if (bad) problems.push(`The ${label} cannot contain ${bad}. Remove it.`);
    else if (text.length > max) problems.push(`The ${label} is up to ${max} characters.`);
  };
  if (!draft.name.trim()) problems.push("Give it a name.");
  else check("name", draft.name, AE_PERSONA_NAME_MAX);
  if (!draft.purpose.trim()) problems.push("Say what it is for.");
  else check("purpose", draft.purpose, AE_PERSONA_PURPOSE_MAX);
  if (!draft.instructions.trim()) problems.push("Write its instructions.");
  else check("instructions", draft.instructions, AE_PERSONA_INSTRUCTIONS_MAX, "\n\t");
  if (draft.trigger !== undefined) {
    if (!draft.trigger.trim()) problems.push("Leave the trigger empty or write one.");
    else check("trigger", draft.trigger, AE_PERSONA_TRIGGER_MAX);
  }
  return problems;
}

/** `\r\n` and `\r` as `\n`, which is what the server accepts in instructions. */
export function aeNormalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
