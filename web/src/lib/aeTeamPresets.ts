// One composer control for "who works on this" (omnigent-ae, 2026-10-23).
// The Auto / Solo / Team button folded into roles presets: a preset's Helpers
// rule replaces Solo ("own" keeps work with the lead and its native
// subagents), and Team became the chat's list of added sessions (the ae.team
// label's members). This file holds the pieces the pill menu, the "Who works
// on this?" dialog and their tests share: reading a label saved before the
// fold (migrated on read, written in the new shape on the next save) and
// adding or removing one session.

import {
  AE_RESERVED_PRESET_ID,
  type AeHelpers,
  type AeRolesState,
  aeHelpersOf,
} from "@/lib/aeRoles";
import {
  AE_TEAM_LABEL_KEY,
  type AeSessionPresetChoice,
  type AeSessionRoles,
  aeResolveSessionPreset,
} from "@/lib/aeSessionRoles";
import { AE_TEAM_LIMIT, type AeTeamMember, readAeTeam, saveAeTeam } from "@/lib/aeTeam";
import { getSessionSlim } from "@/lib/sessionsApi";

/** Shown where collaboration changes wait for the running turn (the dialog and the pill menu). */
export const AE_WORKING_HINT = "You can save collaboration changes after this turn finishes.";

/** The Solo starter's id (ae_omni_policies role_prefs.SOLO_PRESET). */
export const AE_SOLO_PRESET_ID = "solo";

/** True for an ae.team label still saved as mode "solo" (written before the fold). */
export function aeIsLegacySolo(labels?: Record<string, string>): boolean {
  const raw = labels?.[AE_TEAM_LABEL_KEY];
  if (!raw || raw.length > 16_384) return false;
  try {
    const value: unknown = JSON.parse(raw);
    return (
      !!value &&
      typeof value === "object" &&
      (value as { version?: unknown }).version === 1 &&
      (value as { mode?: unknown }).mode === "solo"
    );
  } catch {
    return false;
  }
}

/**
 * The session's roles choice with a label still saved as Solo read the new
 * way: no roles becomes the Solo preset (or, when the user has none, the
 * default customized to "Own subagents only"); a chosen preset whose Helpers
 * rule is "any" gets a session-only customization to "own". Any other label
 * is returned as is. Read only: callers write it on the next save.
 */
export function aeMigratedSessionRoles(
  labels: Record<string, string> | undefined,
  roles: AeSessionRoles | null,
  state: Pick<AeRolesState, "default_preset" | "presets">,
): AeSessionRoles | null {
  if (!aeIsLegacySolo(labels) || roles?.raw) return roles;
  // A "solo" preset the user edited to Helpers "any" still reads as Solo: it
  // gets the same session-only "own" customization as any other preset.
  const named = !roles && state.presets.some((p) => p.id === AE_SOLO_PRESET_ID);
  const choice = aeResolveSessionPreset(named ? { preset: AE_SOLO_PRESET_ID } : roles, state);
  if (choice?.kind !== "preset") return roles;
  if (aeHelpersOf(choice.preset.rules) === "own") return roles ?? { preset: choice.preset.id };
  return {
    preset: choice.preset.id,
    custom: { roles: choice.preset.roles, rules: { ...choice.preset.rules, helpers: "own" } },
  };
}

/**
 * Whether the sessions list is greyed out: the preset's Helpers rule is "own",
 * or the label is still a legacy Solo one (the server tells the lead Solo
 * whatever the preset says, including Lead picks) and nothing has replaced it.
 */
export function aeSessionsLocked(
  choice: AeSessionPresetChoice | null,
  legacySolo: boolean,
): boolean {
  return legacySolo || aeChoiceHelpers(choice) === "own";
}

/** The Helpers rule in force for a session; "Lead picks" leaves it to the lead ("any"). */
export function aeChoiceHelpers(choice: AeSessionPresetChoice | null): AeHelpers {
  return choice?.kind === "preset" ? aeHelpersOf(choice.preset.rules) : "any";
}

/** The line shown where the sessions list is greyed out by an "Own subagents only" preset. */
export function aeSessionsLockedHint(choice: AeSessionPresetChoice | null): string {
  const title = choice?.kind === "preset" ? choice.preset.title : "This preset";
  return `${title} uses own subagents only. Pick another preset to add sessions.`;
}

/** Whether a choice id is the reserved "Lead picks" one (for callers that only hold ids). */
export function aeIsLeadPicks(id: string | null): boolean {
  return id === AE_RESERVED_PRESET_ID;
}

/**
 * The members after adding (`on`) or removing one agent's session; a member
 * is one per agent, as the dialog's list keeps them.
 */
export function aeToggleMember(
  members: readonly AeTeamMember[],
  member: AeTeamMember,
  on: boolean,
): AeTeamMember[] {
  const rest = members.filter((m) => m.agentId !== member.agentId);
  if (!on) return rest;
  const existing = members.find((m) => m.agentId === member.agentId);
  return existing ? [...members] : [...rest, member];
}

/**
 * Add or remove one session on the freshest label and save it the way the
 * dialog does (a new agent gets a child session; the roles field is kept).
 * Resolves to the saved session.
 */
export async function aeSaveTeamMember(sessionId: string, member: AeTeamMember, on: boolean) {
  const parent = await getSessionSlim(sessionId);
  const saved = readAeTeam(parent.labels);
  const members = aeToggleMember(saved.members, member, on);
  if (members.length > AE_TEAM_LIMIT) {
    throw new Error(`A chat can have up to ${AE_TEAM_LIMIT} sessions. Remove one first.`);
  }
  const { roles: _fresh, ...rest } = saved;
  return saveAeTeam(sessionId, { ...rest, mode: members.length ? "team" : "auto", members });
}
