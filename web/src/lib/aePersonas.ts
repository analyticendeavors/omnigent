// Reviewer personas (omnigent-ae, 2026-11-01, patch 0277): a named reviewer brief a
// preset's reviewer slot can point at. The server (ae_omni_policies personas.py) owns the
// five built-in ones (read-only, sent as `builtin_personas`) and stores the user's own
// (`personas`, at most 20). This file parses, lists and edits them, and works out what a
// slot that names one runs on.

import { AE_ROLE_EFFORTS, type AeRoleEffort } from "@/lib/aeRoleBase";
import type { AeReviewerSetting, AeReviewerSlot } from "@/lib/aeReviewers";
import { aeReviewerList } from "@/lib/aeReviewers";

export const AE_PERSONAS_MAX = 20;
export const AE_PERSONA_NAME_MAX = 40;
export const AE_PERSONA_PURPOSE_MAX = 200;
export const AE_PERSONA_TRIGGER_MAX = 200;
export const AE_PERSONA_INSTRUCTIONS_MAX = 1000;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Whether `text` holds a control character, a C1 control or a Unicode line or paragraph
 * separator (the server refuses them); a newline is allowed when `newline` is set.
 */
function hasControl(text: string, newline = false): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (newline && code === 0x0a) continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029)
      return true;
  }
  return false;
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

/** A list of personas, or null when `value` is not an array of well-formed ones. */
export function aeParsePersonas(value: unknown): AePersona[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.map(aeParsePersona);
  return list.every((p): p is AePersona => p !== null) ? list : null;
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

/** The presets (by title) whose reviewer slots name this persona. */
export function aePersonaUsers(
  presets: readonly { title: string; roles: { reviewer: AeReviewerSetting } }[],
  personaId: string,
): string[] {
  return presets
    .filter((preset) =>
      aeReviewerList(preset.roles.reviewer).some(
        (slot) => slot.mode !== "auto" && slot.persona === personaId,
      ),
    )
    .map((preset) => preset.title);
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
  const name = draft.name.trim();
  if (!name) problems.push("Give it a name.");
  else if (draft.name.length > AE_PERSONA_NAME_MAX || hasControl(draft.name))
    problems.push(`The name is one line of up to ${AE_PERSONA_NAME_MAX} characters.`);
  if (!draft.purpose.trim()) problems.push("Say what it is for.");
  else if (draft.purpose.length > AE_PERSONA_PURPOSE_MAX || hasControl(draft.purpose))
    problems.push(`The purpose is one line of up to ${AE_PERSONA_PURPOSE_MAX} characters.`);
  if (!draft.instructions.trim()) problems.push("Write its instructions.");
  else if (
    draft.instructions.length > AE_PERSONA_INSTRUCTIONS_MAX ||
    hasControl(draft.instructions, true)
  )
    problems.push(`The instructions are up to ${AE_PERSONA_INSTRUCTIONS_MAX} characters.`);
  if (draft.trigger !== undefined) {
    if (!draft.trigger.trim()) problems.push("Leave the trigger empty or write one.");
    else if (draft.trigger.length > AE_PERSONA_TRIGGER_MAX || hasControl(draft.trigger))
      problems.push(`The trigger is one line of up to ${AE_PERSONA_TRIGGER_MAX} characters.`);
  }
  return problems;
}

/** `\r\n` and `\r` as `\n`, which is what the server accepts in instructions. */
export function aeNormalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
