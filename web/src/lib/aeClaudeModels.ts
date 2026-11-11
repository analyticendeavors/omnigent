// Claude version labels and older Claude models for the model pickers (omnigent-ae,
// 2026-10-19). A subscription catalog lists only each family's newest model, so the
// older ids it still serves come from AE_CLAUDE_KNOWN_MODELS, each checked to answer.
// 2026-11-10: a known id newer than the catalog's newest row of its family now takes that row's place (Fable 5.2).
// 2026-11-10: a known id newer than an alias row ("opus") gets its own row in front of it; the alias row is untouched.
// 2026-11-10: ids the box's new-model watch saw answer on the plan join the known list at run time.

import { useMemo, useSyncExternalStore } from "react";
import type { NativeModelOption } from "@/lib/types";

/** Full Claude ids a Claude subscription serves, newest first within each family. */
export const AE_CLAUDE_KNOWN_MODELS: readonly string[] = [
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-5-5",
  "claude-haiku-4-5",
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-fable-5",
];

export interface AeClaudeVersion {
  /** Lowercase family, e.g. `opus`. */
  family: string;
  major: number;
  minor: number;
  /** The minor as written, or null when the id has none ("claude-opus-5"). */
  minorText: string | null;
}

// Major and minor are one or two digits, so a date suffix such as -20250514 is
// never read as a version. Matches ids ("claude-opus-4-8"), alias ids
// ("opus-4-10") and labels ("Sonnet 4.6").
const CLAUDE_VERSION =
  /(?:^|[-_.])(fable|opus|sonnet|haiku|mythos)[-_ ](\d{1,2})(?:[-_.](\d{1,2}))?(?=$|[-_[\s])/i;

const BARE_CLAUDE_LABEL = /^(fable|opus|sonnet|haiku|mythos)(?:[\s_-]\d+(?:[.\-_]\d+)?)?$/i;

/** The family and version in a Claude id or label, or null when it has none. */
export function aeClaudeVersion(value: string): AeClaudeVersion | null {
  const match = CLAUDE_VERSION.exec(value);
  return match
    ? {
        family: match[1].toLowerCase(),
        major: Number(match[2]),
        minor: Number(match[3] ?? 0),
        minorText: match[3] ?? null,
      }
    : null;
}

/** A Claude id as people read it: "claude-fable-5-1" -> "Fable 5.1"; null when unparseable. */
export function aeClaudeVersionLabel(model: string): string | null {
  const version = aeClaudeVersion(model.trim().replace(/\[[^\]]*\]$/, ""));
  if (!version) return null;
  const family = version.family[0].toUpperCase() + version.family.slice(1);
  return `${family} ${version.major}${version.minorText !== null ? `.${version.minorText}` : ""}`;
}

function compareVersions(a: AeClaudeVersion, b: AeClaudeVersion): number {
  return a.major - b.major || a.minor - b.minor;
}

function rowVersion(row: { id: string; model?: string }): AeClaudeVersion | null {
  return aeClaudeVersion(row.model ?? "") ?? aeClaudeVersion(row.id);
}

function newestByFamily<T>(rows: readonly T[], versionOf: (row: T) => AeClaudeVersion | null) {
  const newest = new Map<string, AeClaudeVersion>();
  for (const row of rows) {
    const version = versionOf(row);
    if (!version) continue;
    const current = newest.get(version.family);
    if (!current || compareVersions(version, current) > 0) newest.set(version.family, version);
  }
  return newest;
}

// Ids the box's new-model watch saw answer on the plan (GET /v1/ae/model-watch), kept outside React
// so the pure merge below reads them and the pickers' memos rerun when they arrive.
const WATCHED_ID = /^claude-(?:fable|opus|sonnet|haiku|mythos)-\d{1,2}(?:-\d{1,2})?$/;
let watched: readonly string[] = [];
let knownCache: { source: readonly string[]; list: readonly string[] } | null = null;
const watchListeners = new Set<() => void>();

/** Replaces the watched ids; anything that is not a bare Claude id is dropped. A same set is a no-op. */
export function aeSetWatchedModels(ids: readonly unknown[]): void {
  const next = [
    ...new Set(ids.filter((id): id is string => typeof id === "string" && WATCHED_ID.test(id))),
  ].sort();
  if (next.length === watched.length && next.every((id, index) => id === watched[index])) return;
  watched = next;
  knownCache = null;
  for (const listener of watchListeners) listener();
}

/** The ids the watch holds right now (a new array only when they change). */
export function aeWatchedModels(): readonly string[] {
  return watched;
}

function subscribeWatched(listener: () => void): () => void {
  watchListeners.add(listener);
  return () => {
    watchListeners.delete(listener);
  };
}

/** Rerenders the caller when the watched ids change; returns them. */
export function useAeWatchedModels(): readonly string[] {
  return useSyncExternalStore(subscribeWatched, aeWatchedModels, aeWatchedModels);
}

/**
 * The static known ids plus the watched ones, newest first within each family, families in the
 * order they first appear. With nothing watched this is `AE_CLAUDE_KNOWN_MODELS` unchanged.
 */
export function aeKnownModels(): readonly string[] {
  if (knownCache?.source === watched) return knownCache.list;
  const ids = [...new Set([...AE_CLAUDE_KNOWN_MODELS, ...watched])];
  const order: string[] = [];
  for (const id of ids) {
    const family = aeClaudeVersion(id)?.family;
    if (family && !order.includes(family)) order.push(family);
  }
  const rank = (id: string) => {
    const family = aeClaudeVersion(id)?.family;
    return family ? order.indexOf(family) : order.length;
  };
  const list = ids
    .map((id, index) => ({ id, index, version: aeClaudeVersion(id) }))
    .sort(
      (a, b) =>
        rank(a.id) - rank(b.id) ||
        (b.version?.major ?? 0) - (a.version?.major ?? 0) ||
        (b.version?.minor ?? 0) - (a.version?.minor ?? 0) ||
        a.index - b.index,
    )
    .map((entry) => entry.id);
  knownCache = { source: watched, list };
  return list;
}

const CONTEXT_SUFFIX = /\[1m\]$/i;

function isSubscription(row: NativeModelOption): boolean {
  return row.source?.kind === "subscription";
}

/**
 * Rewrites the subscription row holding a family's newest version to the newest
 * known id of that family, when a known id is newer. The `[1m]` suffix stays where
 * the row had it; a bare family label is relabeled by the caller afterwards. An alias
 * row ("opus") is left alone and gets a new row for the newer id in front of it.
 */
function promoteKnown(rows: NativeModelOption[], known: readonly string[]): NativeModelOption[] {
  const newest = newestByFamily(rows.filter(isSubscription), rowVersion);
  const promoted = new Map<string, { version: AeClaudeVersion; id: string }>();
  for (const id of known) {
    const version = aeClaudeVersion(id);
    const latest = version && newest.get(version.family);
    if (!version || !latest || compareVersions(version, latest) <= 0) continue;
    const held = promoted.get(version.family);
    if (!held || compareVersions(version, held.version) > 0)
      promoted.set(version.family, { version, id });
  }
  if (promoted.size === 0) return rows;
  const out: NativeModelOption[] = [];
  const aliasInserts = new Map<number, NativeModelOption>();
  rows.forEach((row, index) => {
    const version = isSubscription(row) ? rowVersion(row) : null;
    const target = version && promoted.get(version.family);
    const current = version && newest.get(version.family);
    if (!version || !target || !current || compareVersions(version, current) !== 0) {
      out.push(row);
      return;
    }
    const base = target.id.replace(CONTEXT_SUFFIX, "");
    const wide = CONTEXT_SUFFIX.test(row.id) || CONTEXT_SUFFIX.test(row.model ?? "");
    const withSuffix = (value: string) => (CONTEXT_SUFFIX.test(value) ? `${base}[1m]` : base);
    const label = aeClaudeVersionLabel(base) ?? base;
    if (!aeClaudeVersion(row.id)) {
      // An alias id ("opus") resolves to whatever the CLI maps it to, so rewriting its model
      // would label the row with a version it does not start. It stays as it is; a new row with
      // the newer id goes in front of it.
      const id = wide ? `${base}[1m]` : base;
      // A copy of the alias row, so the effort options come along; isDefault does not, because
      // the composer sends no model override for a default row and that would start the alias.
      const { isDefault: _isDefault, ...rest } = row;
      aliasInserts.set(index, {
        ...rest,
        id,
        model: id,
        displayName: wide ? `${label} (1M context)` : label,
      });
      out.push(row);
      return;
    }
    const named =
      BARE_CLAUDE_LABEL.test(row.displayName ?? row.id) ||
      /^\w+( \d+(\.\d+)?)? \(1M context\)$/i.test(row.displayName ?? "");
    const next: NativeModelOption = { ...row, id: withSuffix(row.id) };
    if (row.model !== undefined) next.model = withSuffix(row.model);
    if (named) next.displayName = wide ? `${label} (1M context)` : label;
    out.push(next);
  });
  if (aliasInserts.size === 0) return out;
  // Insert each new row before its alias row, unless a subscription row with that id already exists (a
  // full-id row rewritten in place, or an earlier insert for the same width).
  const taken = new Set(out.filter(isSubscription).map((row) => row.id));
  const result: NativeModelOption[] = [];
  out.forEach((row, index) => {
    const insert = aliasInserts.get(index);
    if (insert && !taken.has(insert.id)) {
      taken.add(insert.id);
      result.push(insert);
    }
    result.push(row);
  });
  return result;
}

/**
 * Subscription rows relabeled with their version ("Opus 5.5"), plus one row per
 * older known model of each family the subscription lists. A known id newer than a
 * family's newest subscription row replaces that row (and its `[1m]` sibling).
 * Rows from other sources pass through unchanged; with no subscription row, the
 * same array. `extraKnown` adds ids (from a server route) to the known list.
 */
export function aeMergeKnownClaudeModels(
  catalog: NativeModelOption[],
  extraKnown: readonly string[] = [],
): NativeModelOption[] {
  const known = [...new Set([...extraKnown, ...aeKnownModels()])];
  const rows = promoteKnown(catalog, known);
  const subscriptionRows = rows.filter(isSubscription);
  const newest = newestByFamily(subscriptionRows, rowVersion);
  if (newest.size === 0) return catalog;
  const relabeled = rows.map((row) => {
    const label = isSubscription(row) && aeClaudeVersionLabel(row.model ?? row.id);
    // Only a bare family name is relabeled; "Opus 5.5 (1M context)" already says more.
    if (!label || !BARE_CLAUDE_LABEL.test(row.displayName ?? row.id)) return row;
    const wide = CONTEXT_SUFFIX.test(row.id) || CONTEXT_SUFFIX.test(row.model ?? "");
    return { ...row, displayName: wide ? `${label} (1M context)` : label };
  });
  const listed = subscriptionRows
    .filter((row) => !CONTEXT_SUFFIX.test(row.model ?? row.id))
    .map(rowVersion);
  const older: NativeModelOption[] = [];
  for (const id of known) {
    const version = aeClaudeVersion(id);
    const latest = version && newest.get(version.family);
    if (!version || !latest || compareVersions(version, latest) >= 0) continue;
    if (rows.some((row) => row.id === id)) continue;
    if (
      listed.some((other) => other?.family === version.family && !compareVersions(other, version))
    )
      continue;
    const source = subscriptionRows.find(
      (row) => rowVersion(row)?.family === version.family,
    )?.source;
    older.push({ id, model: id, displayName: aeClaudeVersionLabel(id) ?? id, source });
  }
  // A watched id (the box saw it answer) whose family the catalog does not list at all would never
  // show; it gets one subscription row of its own. The static list never adds a family.
  const fresh = new Map<string, { version: AeClaudeVersion; id: string }>();
  for (const id of new Set([...extraKnown, ...watched])) {
    const version = WATCHED_ID.test(id) ? aeClaudeVersion(id) : null;
    if (!version || newest.has(version.family)) continue;
    const held = fresh.get(version.family);
    if (!held || compareVersions(version, held.version) > 0)
      fresh.set(version.family, { version, id });
  }
  const source = subscriptionRows[0]?.source;
  const added: NativeModelOption[] = [...fresh.values()]
    .filter(({ id }) => !rows.some((row) => row.id === id))
    .map(({ id }) => ({ id, model: id, displayName: aeClaudeVersionLabel(id) ?? id, source }));
  return [...relabeled, ...older, ...added];
}

/** {@link aeMergeKnownClaudeModels} with the built-in known list. */
export function aeWithClaudeVersions(
  rows: NativeModelOption[],
  extraKnown: readonly string[] = [],
): NativeModelOption[] {
  return aeMergeKnownClaudeModels(rows, extraKnown);
}

/** {@link aeWithClaudeVersions} for a picker, memoized; `rows` unchanged when not Claude. */
export function useAeClaudeVersions<T extends NativeModelOption[] | undefined>(
  rows: T,
  claude: boolean,
): T {
  const watchedIds = useAeWatchedModels();
  return useMemo(
    () => (claude && rows ? (aeWithClaudeVersions(rows, watchedIds) as T) : rows),
    [rows, claude, watchedIds],
  );
}

/**
 * Rows split into the newest version of each Claude family and the older ones,
 * the one definition of "previous" both pickers use. `newest` maps family to its
 * newest version; rows without a version stay with the newest.
 */
export function aeSplitPreviousBy<T>(
  rows: readonly T[],
  versionOf: (row: T) => AeClaudeVersion | null,
): { latest: T[]; previous: T[]; newest: Map<string, AeClaudeVersion> } {
  const newest = newestByFamily(rows, versionOf);
  const latest: T[] = [];
  const previous: T[] = [];
  for (const row of rows) {
    const version = versionOf(row);
    const top = version && newest.get(version.family);
    if (version && top && compareVersions(version, top) < 0) previous.push(row);
    else latest.push(row);
  }
  return { latest, previous, newest };
}

/** {@link aeSplitPreviousBy} over model rows, versioned by `model`, else `id`. */
export function aeSplitPrevious<T extends { id: string; model?: string }>(rows: readonly T[]) {
  return aeSplitPreviousBy(rows, rowVersion);
}
