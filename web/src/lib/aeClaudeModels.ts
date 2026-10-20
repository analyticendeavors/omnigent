// Claude version labels and older Claude models for the model pickers (omnigent-ae,
// 2026-10-19). A subscription catalog lists only each family's newest model, so the
// older ids it still serves come from AE_CLAUDE_KNOWN_MODELS, each checked to answer.

import { useMemo } from "react";
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
  /(?:^|[-_.])(fable|opus|sonnet|haiku)[-_ ](\d{1,2})(?:[-_.](\d{1,2}))?(?=$|[-_[\s])/i;

const BARE_CLAUDE_LABEL = /^(fable|opus|sonnet|haiku)(?:[\s_-]\d+(?:[.\-_]\d+)?)?$/i;

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

const CONTEXT_SUFFIX = /\[1m\]$/i;

function isSubscription(row: NativeModelOption): boolean {
  return row.source?.kind === "subscription";
}

/**
 * Subscription rows relabeled with their version ("Opus 5.5"), plus one row per
 * older known model of each family the subscription lists. Rows from other
 * sources pass through unchanged; with no subscription row, the same array.
 */
export function aeWithClaudeVersions(rows: NativeModelOption[]): NativeModelOption[] {
  const subscriptionRows = rows.filter(isSubscription);
  const newest = newestByFamily(subscriptionRows, rowVersion);
  if (newest.size === 0) return rows;
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
  for (const id of AE_CLAUDE_KNOWN_MODELS) {
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
  return [...relabeled, ...older];
}

/** {@link aeWithClaudeVersions} for a picker, memoized; `rows` unchanged when not Claude. */
export function useAeClaudeVersions<T extends NativeModelOption[] | undefined>(
  rows: T,
  claude: boolean,
): T {
  return useMemo(() => (claude && rows ? (aeWithClaudeVersions(rows) as T) : rows), [rows, claude]);
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
