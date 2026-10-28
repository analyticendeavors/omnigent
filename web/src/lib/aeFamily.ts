// Session families (omnigent-ae, 2026-10-23): a session and the sessions it
// started. The orchestrator's `create_session` records the starting session's
// id as `ae.orch` (`1` when it passed none). The lead holds one slot for the
// whole family (`familySlotKey`, mirroring `ae_omni_policies.sessions.family_key`),
// and the sidebar marks its rows with one color. A fork also joins its source's
// family in the sidebar, but keeps its own slot: a fork is often new work.

import type { Conversation } from "@/hooks/useConversations";

export const AE_ORCH_KEY = "ae.orch";
/** What `ae.orch` holds when the starting session gave no id. */
export const AE_ORCH_UNKNOWN = "1";
/** Upstream's fork lineage label (`FORK_SOURCE_LABEL_KEY`). */
export const AE_FORK_SOURCE_KEY = "omnigent.fork.source_id";

// A lead's children rarely start their own, and a cycle must end.
const MAX_DEPTH = 8;

type Labels = Record<string, string> | null | undefined;
type FamilyRow = Pick<Conversation, "id" | "labels">;

function value(labels: Labels, key: string): string | null {
  const raw = labels?.[key];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || null;
}

/** The session that started this one, or `null` when `ae.orch` names none. */
export function aeOrchParent(labels: Labels): string | null {
  const orch = value(labels, AE_ORCH_KEY);
  return orch && orch !== AE_ORCH_UNKNOWN ? orch : null;
}

/**
 * Whether a row is a helper another session started: `ae.orch` names a parent that is
 * not the row itself and whose chain (as far as `byId` reaches) does not lead back to
 * it. A self-parent or a cycle has no lead above it and counts as a lead
 * (mirrors `ae_omni_policies.sessions.is_helper`).
 */
export function aeIsHelper(row: FamilyRow, byId?: ReadonlyMap<string, FamilyRow>): boolean {
  const first = aeOrchParent(row.labels);
  if (first === null) return false;
  let parent: string = first;
  const seen = new Set([row.id]);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (seen.has(parent)) return parent !== row.id;
    seen.add(parent);
    const above: FamilyRow | undefined = byId?.get(parent);
    const next: string | null = above ? aeOrchParent(above.labels) : null;
    if (next === null) return true; // a lead, or a parent out of sight, sits above it
    parent = next;
  }
  return true;
}

/** The session this one descends from in the sidebar: its starter, else its fork source. */
export function aeFamilyParent(labels: Labels): string | null {
  return aeOrchParent(labels) ?? value(labels, AE_FORK_SOURCE_KEY);
}

function topOf(
  row: FamilyRow,
  byId: ReadonlyMap<string, FamilyRow>,
  parentOf: (labels: Labels) => string | null,
  /** A cycle's members all resolve to its lowest id, so each shows in one family. */
  canonicalCycle = false,
): string {
  let key = row.id;
  const chain = [key];
  let parent = parentOf(row.labels);
  for (let depth = 0; depth < MAX_DEPTH && parent; depth += 1) {
    const at = chain.indexOf(parent);
    if (at !== -1) return canonicalCycle ? chain.slice(at).reduce((a, b) => (b < a ? b : a)) : key;
    key = parent;
    chain.push(key);
    const next = byId.get(key);
    parent = next ? parentOf(next.labels) : null;
  }
  return key;
}

/** The slot a row counts against: its `ae.orch` chain's top, else its own id. */
export function familySlotKey(row: FamilyRow, byId: ReadonlyMap<string, FamilyRow>): string {
  return topOf(row, byId, aeOrchParent);
}

/**
 * The sessions above a row on its `ae.orch` chain, nearest first, as far as the
 * loaded rows reach: the server may know a family's top when the list does not.
 */
export function familySlotChain(row: FamilyRow, byId: ReadonlyMap<string, FamilyRow>): string[] {
  const chain: string[] = [];
  let parent = aeOrchParent(row.labels);
  while (parent && chain.length < MAX_DEPTH && !chain.includes(parent) && parent !== row.id) {
    chain.push(parent);
    const next = byId.get(parent);
    parent = next ? aeOrchParent(next.labels) : null;
  }
  return chain;
}

/** One family as the sidebar shows it. */
export interface AeFamily {
  /** The top session's id; it may not be loaded. */
  root: string;
  /** Index into `AE_FAMILY_COLORS`. */
  color: number;
  /** The loaded rows, the top session first when loaded. */
  members: Conversation[];
  /** The top session's title, or `null` when it is not loaded. */
  leadTitle: string | null;
}

/** Where a row sits in its family, for the row's dot. */
export interface AeFamilyRole {
  family: AeFamily;
  isLead: boolean;
  /** Joined as a fork of `parentTitle`'s session rather than started by it. */
  forked: boolean;
  /** The title of the session this row came from, when it is loaded. */
  parentTitle: string | null;
}

export interface AeFamilies {
  byRoot: ReadonlyMap<string, AeFamily>;
  byRow: ReadonlyMap<string, AeFamilyRole>;
}

export const NO_FAMILIES: AeFamilies = { byRoot: new Map(), byRow: new Map() };

/**
 * Eight hues that read on the light and dark sidebars. A family keeps its hue
 * once it has one (`assignFamilyColors`), so a list update never repaints it.
 */
export const AE_FAMILY_COLORS = [
  "#e8a65d",
  "#c792ea",
  "#5fc4b8",
  "#6aa7ff",
  "#e889c0",
  "#7fd18b",
  "#ef6b6b",
  "#b5a46a",
] as const;

const COLORS_KEY = "omnigent:ae-family-colors";
const COLORS_KEPT = 64;

// The stored text and what it parsed to: a list update parses only a changed entry.
let parsedFrom: { raw: string | null; colors: Record<string, number> } | null = null;

function readColors(): Record<string, number> {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(COLORS_KEY);
  } catch {
    return {};
  }
  if (parsedFrom?.raw !== raw) parsedFrom = { raw, colors: parseColors(raw) };
  return parsedFrom.colors;
}

function parseColors(raw: string | null): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const kept: Record<string, number> = {};
    for (const [root, index] of Object.entries(parsed)) {
      if (Number.isInteger(index) && index >= 0 && index < AE_FAMILY_COLORS.length) {
        kept[root] = index;
      }
    }
    return kept;
  } catch {
    return {};
  }
}

function writeColors(colors: Record<string, number>): void {
  try {
    window.localStorage.setItem(COLORS_KEY, JSON.stringify(colors));
  } catch {
    // A view nicety; a family repainting after a reload is harmless.
  }
}

/**
 * A color per root: a stored one while no other listed family has it, else the
 * first one free, else one by position. Remembers the result for the next list.
 */
export function assignFamilyColors(roots: readonly string[]): Map<string, number> {
  const stored = typeof window === "undefined" ? {} : readColors();
  const assigned = new Map<string, number>();
  const taken = new Set<number>();
  for (const root of roots) {
    const own = stored[root];
    if (own !== undefined && !taken.has(own)) {
      assigned.set(root, own);
      taken.add(own);
    }
  }
  roots.forEach((root, position) => {
    if (assigned.has(root)) return;
    const free = AE_FAMILY_COLORS.findIndex((_, index) => !taken.has(index));
    const index = free === -1 ? position % AE_FAMILY_COLORS.length : free;
    assigned.set(root, index);
    taken.add(index);
  });
  if (typeof window !== "undefined") {
    const next: Record<string, number> = Object.fromEntries(assigned);
    for (const [root, index] of Object.entries(stored)) {
      if (Object.keys(next).length >= COLORS_KEPT) break;
      if (!(root in next)) next[root] = index;
    }
    const changed = Object.entries(next).some(([root, index]) => stored[root] !== index);
    if (changed) writeColors(next);
  }
  return assigned;
}

/**
 * The families among *rows*, in the order their first member appears. A family
 * needs two loaded members to show: a lone row has nothing to be marked against.
 * With *orphans* (the family tree view), a lone row started by an unlisted
 * session shows too, under that lead, rather than falling into the rest.
 */
export function aeFamilies(rows: readonly Conversation[], orphans = false): AeFamilies {
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const grouped = new Map<string, Conversation[]>();
  for (const row of rows) {
    const root = topOf(row, byId, aeFamilyParent, true);
    const members = grouped.get(root);
    if (members) members.push(row);
    else grouped.set(root, [row]);
  }
  // Tree view: an unlisted top session makes a family only through `ae.orch`
  // (a fork of an unloaded source stays in the rest).
  const shown = [...grouped].filter(([root, members]) =>
    orphans && !byId.has(root)
      ? members.some((row) => aeOrchParent(row.labels) === root)
      : members.length > 1,
  );
  if (shown.length === 0) return NO_FAMILIES;
  const colors = assignFamilyColors(shown.map(([root]) => root));
  const byRoot = new Map<string, AeFamily>();
  const byRow = new Map<string, AeFamilyRole>();
  for (const [root, members] of shown) {
    const lead = byId.get(root);
    const family: AeFamily = {
      root,
      color: colors.get(root) ?? 0,
      members: lead ? [lead, ...members.filter((row) => row.id !== root)] : members,
      leadTitle: lead ? (lead.title ?? null) : null,
    };
    byRoot.set(root, family);
    for (const row of members) {
      // A fork copies its source's ae.orch, so the fork label decides the wording.
      const source = value(row.labels, AE_FORK_SOURCE_KEY);
      const parent = source ?? aeOrchParent(row.labels);
      byRow.set(row.id, {
        family,
        isLead: row.id === root,
        forked: source !== null,
        parentTitle: parent ? (byId.get(parent)?.title ?? null) : null,
      });
    }
  }
  return { byRoot, byRow };
}

/**
 * The sessions a lead started, and the ones those started, among *rows*: `ae.orch`
 * only, nearest first, never a fork (it copies its source's `ae.orch`) and never an
 * archived row. Mirrors `ae_omni_policies.sessions.children_of`; the server also
 * checks owners, so this is the count a switch asks about, not a promise.
 */
export function aeFamilyChildren(rows: readonly Conversation[], id: string): Conversation[] {
  const found: Conversation[] = [];
  const seen = new Set([id]);
  let level = [id];
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth += 1) {
    const parents = new Set(level);
    level = [];
    for (const row of rows) {
      if (seen.has(row.id) || row.archived === true) continue;
      if (value(row.labels, AE_FORK_SOURCE_KEY) !== null) continue;
      const parent = aeOrchParent(row.labels);
      if (parent === null || !parents.has(parent)) continue;
      seen.add(row.id);
      found.push(row);
      level.push(row.id);
    }
  }
  return found;
}

/** The dot's hover text: who started the row, or how many the lead started. */
export function aeFamilyHint(role: AeFamilyRole): string {
  const others = role.family.members.length - 1;
  if (role.isLead) return `Leads ${others} session${others === 1 ? "" : "s"}`;
  const from = role.parentTitle ?? "a session not listed here";
  return role.forked ? `Forked from ${from}` : `Started by ${from}`;
}
