// Grouping > Family as tree rows (omnigent-ae, 2026-10-24): a "Families"
// section first, each family's lead as the parent row with its sessions
// indented under it on a line in the family's color, then "Standalone"
// with every other session in the current sort. A lead's count pill folds its
// family; the folds are remembered per device. The families themselves:
// `aeFamily.ts`; the rows that draw this: `shell/AeFamilyTree.tsx`.

import { useMemo, useRef, useSyncExternalStore } from "react";
import type { Conversation } from "@/hooks/useConversations";
import { AE_FORK_SOURCE_KEY, type AeFamilies, type AeFamily, aeOrchParent } from "@/lib/aeFamily";
import {
  AE_CLOSED_SHOWN,
  type AeClosedInput,
  type AeClosedSummary,
  NO_CLOSED,
  aeIsClosedMember,
  aeNewestFirst,
} from "@/lib/aeFamilyClosed";
import { aeStatusOf } from "@/lib/aeLabels";

export const AE_FAMILIES_SECTION = "Families";
export const AE_FAMILY_REST_SECTION = "Standalone";
export const AE_FAMILY_SECTIONS = [AE_FAMILIES_SECTION, AE_FAMILY_REST_SECTION] as const;
export const AE_FAMILIES_HINT =
  "No families yet. When a session starts another, both show here as a family.";
/** Pixels of indent per tree step. */
export const AE_FAMILY_TREE_STEP = 18;
/** Deeper sessions line up at this step under their parent. */
export const AE_FAMILY_TREE_MAX_DEPTH = 2;

/** Where a listed row sits in its family's tree, for its lines. */
export interface AeTreeRow {
  family: AeFamily;
  /** 0 for the lead, else 1 to `AE_FAMILY_TREE_MAX_DEPTH`. */
  depth: number;
  /** Per step 1 to depth - 1: whether that step's line runs on past this row. */
  through: boolean[];
  /** Whether a later row at this depth follows, so this row's line runs on down. */
  more: boolean;
  /** Whether this row's children follow it, so a line drops from its icon. */
  stem: boolean;
}

/** A family's lead as the tree shows it: the pill, and a stand-in when it is not a listed row. */
export interface AeTreeLead {
  family: AeFamily;
  /** Sessions under the lead: listed ones, and archived children when closed rows show. */
  count: number;
  /** The archived read stopped at its cap: older archived children are not counted. */
  archivedCapped: boolean;
  /** Set when the family has closed sessions: its pill and tooltip read from it. */
  closed: AeClosedSummary | null;
  folded: boolean;
  /** Folded with a hidden session waiting on a response. */
  needsResponse: boolean;
  /** Folded with a hidden session running. */
  running: boolean;
  /**
   * The lead is an archived or unknown session: a stand-in row (its entry in the
   * list carries the lead's id) draws instead of a session row.
   */
  standIn: null | {
    /** The lead's session when known (archived), else null. */
    lead: Conversation | null;
  };
}

/** A row of a family's closed group, drawn in place of a session row. */
export type AeClosedEntry =
  | { kind: "fold"; row: AeTreeRow; count: number; open: boolean }
  | { kind: "row"; row: AeTreeRow; conversation: Conversation }
  | { kind: "more"; row: AeTreeRow; hidden: number };

export interface AeFamilyTree {
  rows: ReadonlyMap<string, AeTreeRow>;
  /** Closed-group rows by list entry id; they are in no drop list. */
  closed: ReadonlyMap<string, AeClosedEntry>;
  /** Entries that are no session row to select or navigate: stand-ins and closed rows. */
  unlisted: ReadonlySet<string>;
  /** By the lead's id. */
  leads: ReadonlyMap<string, AeTreeLead>;
  /** Ids of the list entries that draw as a stand-in lead, not as a session. */
  standIns: ReadonlySet<string>;
  familyCount: number;
}

export interface AeFamilyTreeOptions {
  /** Folded families, by top session id. */
  folded: ReadonlySet<string>;
  /** Rank families by their lead's place (Manual) rather than their first member's. */
  byLead: boolean;
  /** A session outside the list (archived or pinned), for an unlisted lead. */
  lookup?: (id: string) => Conversation | undefined;
  /** A search is on: a family whose lead did not match lists its sessions in the rest. */
  searching?: boolean;
  /** Archived children and the open closed groups; none means nothing is closed but listed reference rows. */
  closed?: AeClosedInput;
}

function needsResponse(c: Conversation): boolean {
  return (c.pending_elicitations_count ?? 0) > 0;
}

/** Lines for a family's flattened rows, from their depths alone. */
function lines(depths: readonly number[], at: number) {
  const runsOn = (step: number) => {
    for (let j = at + 1; j < depths.length; j += 1) {
      if (depths[j] < step) return false;
      if (depths[j] === step) return true;
    }
    return false;
  };
  const depth = depths[at];
  const through: boolean[] = [];
  for (let step = 1; step < depth; step += 1) through.push(runsOn(step));
  return { through, more: depth > 0 && runsOn(depth), stem: depths[at + 1] === depth + 1 };
}

/**
 * *ordered* (the list in its current sort) as Grouping > Family shows it: each
 * family's rows (lead, then its sessions as a tree, each step in list order),
 * families ranked by their first member (or their lead under Manual), then the
 * rest in list order. A folded family keeps only its lead.
 */
export function aeFamilyTree(
  ordered: readonly Conversation[],
  families: AeFamilies,
  { folded, byLead, lookup, searching = false, closed: closedIn = NO_CLOSED }: AeFamilyTreeOptions,
): {
  sessions: Conversation[];
  groupTitles: Map<string, string>;
  groupOrder: string[];
  tree: AeFamilyTree;
} {
  const position = new Map(ordered.map((c, index) => [c.id, index] as const));
  const membersOf = new Map<string, Conversation[]>();
  const rest: Conversation[] = [];
  for (const c of ordered) {
    const family = families.byRow.get(c.id)?.family;
    if (!family || (searching && !position.has(family.root))) {
      rest.push(c);
      continue;
    }
    const members = membersOf.get(family.root);
    if (members) members.push(c);
    else membersOf.set(family.root, [c]);
  }
  const rank = (root: string, members: Conversation[]) =>
    byLead && position.has(root) ? position.get(root)! : position.get(members[0].id)!;
  const ranked = [...membersOf].sort(([a, am], [b, bm]) => rank(a, am) - rank(b, bm));

  const rows = new Map<string, AeTreeRow>();
  const leads = new Map<string, AeTreeLead>();
  const closedEntries = new Map<string, AeClosedEntry>();
  const standIns = new Set<string>();
  const familyRows: Conversation[] = [];
  for (const [root, members] of ranked) {
    const family = families.byRoot.get(root)!;
    const listed = members.find((c) => c.id === root) ?? null;
    const others = members.filter((c) => c.id !== root);
    // Reference sessions and the lead's archived children are closed, not rows.
    const openOthers = others.filter((c) => !aeIsClosedMember(c));
    const listedIds = new Set(members.map((c) => c.id));
    const archived = (closedIn.archived.get(root) ?? []).filter((c) => !listedIds.has(c.id));
    const closedRows = aeNewestFirst([...others.filter(aeIsClosedMember), ...archived]);
    const ids = new Set(openOthers.map((c) => c.id));
    // Each session under the listed session it forked from or was started by
    // (a fork copies its source's ae.orch, so the fork label wins), else under
    // the lead; a session a cycle never reaches goes under the lead too.
    const childrenOf = new Map<string, Conversation[]>();
    for (const c of openOthers) {
      const fork = c.labels?.[AE_FORK_SOURCE_KEY]?.trim();
      const parent = fork && ids.has(fork) ? fork : aeOrchParent(c.labels);
      const key = parent && parent !== c.id && ids.has(parent) ? parent : root;
      const list = childrenOf.get(key);
      if (list) list.push(c);
      else childrenOf.set(key, [c]);
    }
    const flat: { c: Conversation; depth: number }[] = [];
    const seen = new Set<string>();
    const walk = (id: string, depth: number) => {
      for (const c of childrenOf.get(id) ?? []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        flat.push({ c, depth: Math.min(depth, AE_FAMILY_TREE_MAX_DEPTH) });
        walk(c.id, depth + 1);
      }
    };
    walk(root, 1);
    for (const c of openOthers) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      flat.push({ c, depth: 1 });
      walk(c.id, 2);
    }

    // The lead's entry: its listed row, a pinned or filtered-out session as a
    // real row, or a stand-in for an archived or unknown one.
    const known = listed ? null : (lookup?.(root) ?? null);
    const real = listed ?? (known && known.archived !== true ? known : null);
    const entry = real ?? known ?? unknownLead(root);
    if (!real) standIns.add(root);

    const total = others.length + archived.length;
    const isFolded = folded.has(root) && total > 0;
    const hidden = isFolded ? others : [];
    const review = openOthers.filter((c) => aeStatusOf(c.labels) === "review").length;
    leads.set(root, {
      family,
      count: total,
      archivedCapped: closedIn.capped === true,
      closed:
        closedRows.length === 0
          ? null
          : {
              total,
              open: openOthers.length,
              closed: closedRows.length,
              archived: archived.length + others.filter((c) => c.archived === true).length,
              working: openOthers.length - review,
              review,
            },
      folded: isFolded,
      needsResponse: hidden.some(needsResponse),
      running: hidden.some((c) => c.status === "running"),
      standIn: real ? null : { lead: known },
    });
    const shown = isFolded ? [] : flat;
    // The closed group: a fold row, then (when opened) up to a few rows and "Show N more".
    const group: { id: string; c: Conversation; make: (row: AeTreeRow) => AeClosedEntry }[] = [];
    if (!isFolded && closedRows.length > 0) {
      const isOpen = closedIn.open.has(root);
      const shownClosed = !isOpen
        ? []
        : closedIn.all.has(root)
          ? closedRows
          : closedRows.slice(0, AE_CLOSED_SHOWN);
      const foldId = `ae-closed:${root}:fold`;
      group.push({
        id: foldId,
        c: unknownLead(foldId),
        make: (row) => ({ kind: "fold", row, count: closedRows.length, open: isOpen }),
      });
      for (const c of shownClosed) {
        group.push({ id: c.id, c, make: (row) => ({ kind: "row", row, conversation: c }) });
      }
      if (shownClosed.length < closedRows.length && isOpen) {
        const moreId = `ae-closed:${root}:more`;
        const left = closedRows.length - shownClosed.length;
        group.push({
          id: moreId,
          c: unknownLead(moreId),
          make: (row) => ({ kind: "more", row, hidden: left }),
        });
      }
    }
    const depths = [0, ...shown.map((item) => item.depth), ...group.map(() => 1)];
    rows.set(root, { family, depth: 0, ...lines(depths, 0) });
    familyRows.push(entry);
    shown.forEach((item, index) => {
      rows.set(item.c.id, { family, depth: item.depth, ...lines(depths, index + 1) });
      familyRows.push(item.c);
    });
    group.forEach((item, index) => {
      const row = { family, depth: 1, ...lines(depths, shown.length + index + 1) };
      closedEntries.set(item.id, item.make(row));
      familyRows.push(item.c);
    });
  }

  const groupTitles = new Map<string, string>();
  for (const c of familyRows) groupTitles.set(c.id, AE_FAMILIES_SECTION);
  for (const c of rest) groupTitles.set(c.id, AE_FAMILY_REST_SECTION);
  return {
    sessions: [...familyRows, ...rest],
    groupTitles,
    groupOrder: [...AE_FAMILY_SECTIONS],
    tree: {
      rows,
      closed: closedEntries,
      unlisted:
        closedEntries.size === 0 ? standIns : new Set([...standIns, ...closedEntries.keys()]),
      leads,
      standIns,
      familyCount: ranked.length,
    },
  };
}

/** The list entry for a lead nothing is known about; the stand-in row draws in its place. */
function unknownLead(id: string): Conversation {
  return {
    id,
    object: "conversation",
    title: null,
    created_at: 0,
    updated_at: 0,
    labels: {},
    permission_level: null,
    status: "idle",
  } as unknown as Conversation;
}

/**
 * The grouped sections with "Families" always first in the tree view, empty
 * when no family shows, so its hint says how one forms.
 */
export function aeWithFamiliesSection<T extends { title: string; conversations: Conversation[] }>(
  groups: T[],
  tree: AeFamilyTree | null | undefined,
): T[] {
  if (!tree || groups[0]?.title === AE_FAMILIES_SECTION) return groups;
  return [{ title: AE_FAMILIES_SECTION, conversations: [] } as unknown as T, ...groups];
}

// ── folded families, per device ─────────────────────────────────────────

const FOLDS_KEY = "omnigent:ae-family-folds";
const FOLDS_KEPT = 64;
let folds: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function readFolds(): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(FOLDS_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function snapshot(): ReadonlySet<string> {
  if (folds === null) folds = typeof window === "undefined" ? new Set() : readFolds();
  return folds;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The families folded on this device, by top session id. */
export function useAeFamilyFolds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Fold or unfold a family (flip it by default), and remember it on this device. */
export function toggleAeFamilyFold(root: string, fold?: boolean): void {
  const next = new Set(snapshot());
  if (fold ?? !next.has(root)) next.add(root);
  else next.delete(root);
  folds = new Set([...next].slice(-FOLDS_KEPT));
  try {
    window.localStorage.setItem(FOLDS_KEY, JSON.stringify([...folds]));
  } catch {
    // A view nicety: a fold that does not survive a reload is harmless.
  }
  for (const listener of listeners) listener();
}

/** Forget the cached folds, so the next read comes from storage (tests). */
export function resetAeFamilyFoldsCache(): void {
  folds = null;
}

/**
 * The folds with the open session's family unfolded while that session is one of
 * its hidden sessions: for this visit only, until the user toggles any fold.
 */
export function useAeEffectiveFolds(
  remembered: ReadonlySet<string>,
  activeId: string | null,
  activeRoot: string | null,
): ReadonlySet<string> {
  const visit = useRef<{ id: string | null; folds: ReadonlySet<string> } | null>(null);
  if (visit.current?.id !== activeId) visit.current = { id: activeId, folds: remembered };
  const open =
    activeRoot !== null &&
    activeRoot !== activeId &&
    visit.current.folds === remembered &&
    remembered.has(activeRoot);
  return useMemo(() => {
    if (!open) return remembered;
    const next = new Set(remembered);
    next.delete(activeRoot);
    return next;
  }, [open, remembered, activeRoot]);
}

function treeSignature(tree: AeFamilyTree): string {
  const parts = [`${tree.familyCount}`];
  for (const [id, lead] of tree.leads) {
    const { family, standIn } = lead;
    parts.push(
      `L${id}:${family.color}:${lead.count}:${lead.folded ? 1 : 0}${lead.needsResponse ? 1 : 0}${lead.running ? 1 : 0}`,
      lead.closed ? Object.values(lead.closed).join(",") : "-",
      lead.archivedCapped ? "cap" : "",
      standIn ? `${standIn.lead?.title ?? ""}:${standIn.lead ? 1 : 0}` : "-",
    );
  }
  for (const [id, row] of tree.rows) {
    parts.push(
      `R${id}:${row.family.root}:${row.depth}:${row.through.map(Number).join("")}:${+row.more}${+row.stem}`,
    );
  }
  // A closed row's own text and status, never its time: a time bump re-renders nothing.
  for (const [id, entry] of tree.closed) {
    const { row } = entry;
    const c = entry.kind === "row" ? entry.conversation : null;
    const detail =
      entry.kind === "fold"
        ? `${entry.count}:${+entry.open}`
        : entry.kind === "more"
          ? `${entry.hidden}`
          : `${c?.title ?? ""}:${c?.labels?.["ae.status"] ?? ""}:${+(c?.archived === true)}:${c?.pending_elicitations_count ?? 0}`;
    parts.push(
      `C${id}:${entry.kind}:${row.family.root}:${row.through.map(Number).join("")}:${+row.more}:${detail}`,
    );
  }
  parts.push([...tree.standIns].join(","));
  return parts.join("\n");
}

/**
 * The same tree object until its roots, members, depths, folds, pill state or
 * colors change, so a list update that only bumps a time re-renders no row.
 */
export function useAeStableTree(tree: AeFamilyTree | null): AeFamilyTree | null {
  const kept = useRef<{ key: string; tree: AeFamilyTree | null }>({ key: "", tree: null });
  const key = tree ? treeSignature(tree) : "";
  if (key !== kept.current.key || (tree === null) !== (kept.current.tree === null)) {
    kept.current = { key, tree };
  }
  return kept.current.tree;
}
