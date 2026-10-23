// Per-session roles preset (omnigent-ae, 2026-10-23): the optional `roles`
// field of the `ae.team` label. {"preset": id} uses that preset,
// {"preset": "lead-picks"} lets the lead choose, and {"preset": id, "custom":
// {roles, rules}} customizes it for this session only. Absent means "your
// default", so a later change of default still reaches the session. The
// "Who works on this?" dialog, the composer pill, Alt 1 to 9 and START ON all
// read and write the field through these helpers, which keep every other
// field of the label as it is.

import {
  AE_PRESET_SHORTCUTS,
  AE_RESERVED_PRESET_ID,
  type AeRolePreset,
  type AeRoleRules,
  type AeRolesState,
  type AeRoleTable,
  aeParseRolesState,
} from "@/lib/aeRoles";
import { getSessionSlim, updateSession } from "@/lib/sessionsApi";

export const AE_TEAM_LABEL_KEY = "ae.team";

export interface AeSessionRoles {
  preset: string;
  custom?: { roles: AeRoleTable; rules: AeRoleRules };
  /**
   * The `roles` object exactly as stored, kept only when its `custom` block is
   * one this client cannot read (a newer shape). Every writer puts it back
   * as it was, so an older client never drops what a newer one saved.
   */
  raw?: Record<string, unknown>;
}

/** What goes in the label for `roles`: the stored object when it was unreadable, else the parsed one. */
export function aeRolesWire(roles: AeSessionRoles): Record<string, unknown> {
  if (roles.raw) return roles.raw;
  const { raw: _raw, ...wire } = roles;
  return wire;
}

/** Whether two `roles` choices write the same label value. */
export function aeSameSessionRoles(a: AeSessionRoles | null, b: AeSessionRoles | null): boolean {
  return JSON.stringify(a ? aeRolesWire(a) : null) === JSON.stringify(b ? aeRolesWire(b) : null);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * A well-formed `roles` value, or null. A `custom` block is checked by
 * parsing it as a preset's roles and rules (the server checks it again).
 */
export function aeParseSessionRoles(value: unknown): AeSessionRoles | null {
  if (!isObject(value) || typeof value.preset !== "string" || !value.preset) return null;
  if (value.custom === undefined) return { preset: value.preset };
  if (!isObject(value.custom)) return { preset: value.preset, raw: value };
  const probe = aeParseRolesState({
    revision: 0,
    default_preset: "x",
    presets: [
      {
        id: "x",
        title: "x",
        icon: "x",
        color: "slate",
        roles: value.custom.roles,
        rules: value.custom.rules,
      },
    ],
  });
  const parsed = probe?.presets[0];
  if (!parsed) return { preset: value.preset, raw: value };
  return { preset: value.preset, custom: { roles: parsed.roles, rules: parsed.rules } };
}

function parseLabel(raw: string | undefined): Record<string, unknown> | null {
  if (!raw || raw.length > 16_384) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isObject(value) && value.version === 1 ? value : null;
  } catch {
    return null;
  }
}

/** The session's `roles` choice; null means "your default". */
export function readAeSessionRoles(labels?: Record<string, string>): AeSessionRoles | null {
  return aeParseSessionRoles(parseLabel(labels?.[AE_TEAM_LABEL_KEY])?.roles);
}

/**
 * The `ae.team` label text with `roles` set (or removed for null), every other
 * field kept. A missing or unreadable label starts as Auto with no members,
 * which is what the session already runs as.
 */
export function aeTeamLabelWithRoles(
  labels: Record<string, string> | undefined,
  roles: AeSessionRoles | null,
): string {
  const base = parseLabel(labels?.[AE_TEAM_LABEL_KEY]) ?? {
    version: 1,
    mode: "auto",
    members: [],
  };
  const { roles: _old, ...rest } = base;
  return JSON.stringify(roles ? { ...rest, roles: aeRolesWire(roles) } : rest);
}

/** Write the session's `roles` choice on its freshest labels; resolves to the saved session. */
export async function saveAeSessionRoles(sessionId: string, roles: AeSessionRoles | null) {
  const session = await getSessionSlim(sessionId);
  return updateSession(sessionId, {
    labels: { [AE_TEAM_LABEL_KEY]: aeTeamLabelWithRoles(session.labels, roles) },
  });
}

const writeTails = new Map<string, { tail: Promise<unknown>; latest: number }>();
/** Returned by `aeLatestWins` for a write a later one replaced before it started. */
export const AE_SUPERSEDED = Symbol("superseded");

/**
 * Run `write` after every earlier write for `key` finished, one at a time. A
 * write still waiting when a later one is queued is skipped (resolves
 * AE_SUPERSEDED): the latest pick wins and the earlier one never lands.
 */
export function aeLatestWins<T>(
  key: string,
  write: () => Promise<T>,
): Promise<T | typeof AE_SUPERSEDED> {
  const entry = writeTails.get(key) ?? { tail: Promise.resolve(), latest: 0 };
  const mine = ++entry.latest;
  const run = entry.tail.then<T | typeof AE_SUPERSEDED>(() =>
    entry.latest === mine ? write() : AE_SUPERSEDED,
  );
  entry.tail = run.catch(() => undefined);
  writeTails.set(key, entry);
  void entry.tail.then(() => {
    if (writeTails.get(key) === entry && entry.latest === mine) writeTails.delete(key);
  });
  return run;
}

/** What a session runs on, for the pill and the dialog. */
export type AeSessionPresetChoice =
  | { kind: "lead-picks" }
  | { kind: "preset"; preset: AeRolePreset; isDefault: boolean; edited: boolean };

/** Resolve a `roles` choice the way the server does: unknown or absent is the default. */
export function aeResolveSessionPreset(
  roles: AeSessionRoles | null,
  state: Pick<AeRolesState, "default_preset" | "presets">,
): AeSessionPresetChoice | null {
  if (roles?.preset === AE_RESERVED_PRESET_ID) return { kind: "lead-picks" };
  const chosen = roles ? state.presets.find((p) => p.id === roles.preset) : undefined;
  const preset =
    chosen ?? state.presets.find((p) => p.id === state.default_preset) ?? state.presets[0];
  if (!preset) return null;
  const edited = !!chosen && !!roles?.custom;
  const shown = edited && roles?.custom ? { ...preset, ...roles.custom } : preset;
  return { kind: "preset", preset: shown, isDefault: preset.id === state.default_preset, edited };
}

/**
 * The `roles` value that picks `id` (a preset id or "lead-picks"). The default
 * writes nothing, so a later change of default still applies.
 */
export function aeRolesForPick(id: string, defaultId: string): AeSessionRoles | null {
  return id === defaultId ? null : { preset: id };
}

/** Stable id of a choice for comparisons: "lead-picks" or the preset id. */
export function aeChoiceId(choice: AeSessionPresetChoice | null): string | null {
  if (!choice) return null;
  return choice.kind === "lead-picks" ? AE_RESERVED_PRESET_ID : choice.preset.id;
}

// ---------------------------------------------------------------------------
// Recent presets, per device

export const AE_RECENT_PRESETS_KEY = "omnigent:ae-recent-presets";
const RECENT_MAX = 3;

export function aeReadRecentPresets(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(AE_RECENT_PRESETS_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string").slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

export function aeRememberPreset(id: string) {
  // "Lead picks" is one tap in the menu already; it never takes a recent slot.
  if (id === AE_RESERVED_PRESET_ID) return;
  try {
    const next = [id, ...aeReadRecentPresets().filter((v) => v !== id)].slice(0, RECENT_MAX);
    window.localStorage.setItem(AE_RECENT_PRESETS_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: recents are a convenience only.
  }
}

// ---------------------------------------------------------------------------
// Alt 1 to Alt 9

interface DigitEvent {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** 0-based list position for Alt+Digit1..Digit9 with no other modifier, else null. */
export function aePresetDigit(event: DigitEvent): number | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const match = /^Digit([1-9])$/.exec(event.code);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return index < AE_PRESET_SHORTCUTS ? index : null;
}
