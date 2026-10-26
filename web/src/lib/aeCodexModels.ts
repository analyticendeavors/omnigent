// Codex model names for the reviewer rows (omnigent-ae, 2026-10-26). The host
// lists every Codex model it knows, old generations too. A reviewer row offers
// the three latest, worked out from the names: the family is the last word
// ("Sol" in "GPT-6-Sol") and the generation is the number ("6", or "5.6").
// Pure logic; the components live in pages/settings.

import { AE_AGENT_EFFORTS, type AeAgentEffort } from "@/lib/aeRoleBase";
import type { NativeModelOption } from "@/lib/types";

export const AE_CODEX_LATEST_COUNT = 3;
/** The family a new Codex reviewer opens on (the workhorse model). */
export const AE_CODEX_NEW_REVIEWER_FAMILY = "sol";
/** The families the host names its models by. With two or more of them in a list, only they count for "latest". */
export const AE_CODEX_NAMED_FAMILIES: readonly string[] = ["astra", "sol", "luna", "terra"];

export interface AeCodexName {
  /** Lowercase words after the generation: `sol`, or `codex-max` for "GPT-5.6-Codex-Max". */
  family: string;
  /** The generation's parts: "5.6" is [5, 6]. */
  generation: number[];
}

const NAME = /(\d+(?:\.\d+)*)[\s-]+([A-Za-z]+(?:[\s-]+[A-Za-z]+)*)\s*$/;

/** The family and generation in a Codex display name, or null when either is missing. */
export function aeCodexName(label: string | null | undefined): AeCodexName | null {
  const match = NAME.exec(label?.trim() ?? "");
  if (!match) return null;
  return {
    family: match[2]
      .toLowerCase()
      .split(/[\s-]+/)
      .join("-"),
    generation: match[1].split(".").map(Number),
  };
}

/** Negative when `a` is the older generation. */
export function aeCompareGeneration(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** What the host calls a model in its list. */
export function aeCodexLabel(row: Pick<NativeModelOption, "id" | "displayName">): string {
  return row.displayName?.trim() || row.id;
}

export function aeCodexRowName(row: NativeModelOption): AeCodexName | null {
  return aeCodexName(row.displayName) ?? aeCodexName(row.id);
}

interface Newest {
  row: NativeModelOption;
  generation: number[];
  order: number;
}

/** The newest row of each family, keyed by family; `only` limits which families count. */
function newestByFamily(rows: readonly NativeModelOption[], only?: readonly string[]) {
  const newest = new Map<string, Newest>();
  rows.forEach((row, order) => {
    const name = aeCodexRowName(row);
    if (!name || (only && !only.includes(name.family))) return;
    const current = newest.get(name.family);
    if (!current || aeCompareGeneration(name.generation, current.generation) > 0)
      newest.set(name.family, { row, generation: name.generation, order });
  });
  return newest;
}

const byNewest = (a: Newest, b: Newest) =>
  aeCompareGeneration(b.generation, a.generation) || a.order - b.order;

/** Whether a list names models by the host's families, so only those count for "latest". */
function namedOnly(rows: readonly NativeModelOption[]): readonly string[] | undefined {
  return newestByFamily(rows, AE_CODEX_NAMED_FAMILIES).size >= 2
    ? AE_CODEX_NAMED_FAMILIES
    : undefined;
}

/**
 * The newest version of each family, the families with the newest versions
 * overall first (catalog order breaks a tie), cut to `limit`. With two or more
 * of the host's named families in the list, only those count. When no name
 * parses, every model is listed as the host gave it.
 */
export function aeLatestCodexModels(
  rows: readonly NativeModelOption[],
  limit = AE_CODEX_LATEST_COUNT,
): NativeModelOption[] {
  const newest = newestByFamily(rows, namedOnly(rows));
  if (newest.size === 0) return [...rows];
  return [...newest.values()]
    .sort(byNewest)
    .slice(0, limit)
    .map((entry) => entry.row);
}

/** Every other model the host lists (older generations stay out), so nothing it offers is unreachable. */
export function aeCodexOtherModels(rows: readonly NativeModelOption[]): NativeModelOption[] {
  const only = namedOnly(rows);
  const older = new Set(
    rows.filter((row) => {
      const name = aeCodexRowName(row);
      return !!name && (!only || only.includes(name.family));
    }),
  );
  const latest = new Set(aeLatestCodexModels(rows));
  return rows.filter((row) => !latest.has(row) && !older.has(row));
}

/** The model a new Codex reviewer starts on: the newest Sol in the whole list, else the newest model. */
export function aeNewCodexReviewerModel(
  rows: readonly NativeModelOption[],
): NativeModelOption | null {
  const sol = newestByFamily(rows).get(AE_CODEX_NEW_REVIEWER_FAMILY);
  if (sol) return sol.row;
  return aeLatestCodexModels(rows)[0] ?? null;
}

/** The efforts a model offers, in bar order (ultra last); empty when it lists none. */
export function aeCodexEfforts(row: NativeModelOption | null | undefined): AeAgentEffort[] {
  const listed = new Set(
    (row?.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort),
  );
  return AE_AGENT_EFFORTS.filter((effort) => listed.has(effort));
}

/** The model's own default effort when it offers it, else Medium, else its first level. */
export function aeCodexDefaultEffort(row: NativeModelOption | null | undefined): AeAgentEffort {
  const efforts = aeCodexEfforts(row);
  const own = row?.defaultReasoningEffort;
  const stored = efforts.find((effort) => effort === own);
  if (stored) return stored;
  if (efforts.length === 0 || efforts.includes("medium")) return "medium";
  return efforts[0];
}
