// The reviewer model picker's "Older models" fold (omnigent-ae, 2026-10-26).
// Each platform lists its latest models, and everything else sits in one closed
// fold under them. The split is worked out from the names, never a fixed list:
// Claude keeps the newest version of each family, Codex keeps what
// aeLatestCodexModels keeps. Pure logic; the picker lives in pages/settings.

import { aeClaudeVersion, aeSplitPreviousBy } from "@/lib/aeClaudeModels";
import { aeLatestCodexModels } from "@/lib/aeCodexModels";
import type { NativeModelOption } from "@/lib/types";

export interface AeModelFoldSplit<T> {
  /** Shown in the open list, in the catalog's order. */
  latest: T[];
  /** Behind the "Older models" row, in the catalog's order. */
  older: T[];
}

/** Claude choices: the newest version of each family is latest; ids with no version stay with it. */
export function aeClaudeFoldSplit<T extends { value: string; label?: string }>(
  items: readonly T[],
): AeModelFoldSplit<T> {
  const { latest, previous } = aeSplitPreviousBy(
    items,
    (item) => aeClaudeVersion(item.value) ?? aeClaudeVersion(item.label ?? ""),
  );
  return { latest, older: previous };
}

/**
 * Codex rows: the latest the host's names give, and every other row it lists.
 * In a mixed catalog a name that does not parse goes under Older models. When
 * no name parses there is no version data to fold by, so every row stays in the
 * top group (deliberate: an alias is not "older" than another alias).
 */
export function aeCodexFoldSplit(
  rows: readonly NativeModelOption[],
): AeModelFoldSplit<NativeModelOption> {
  const top = new Set(aeLatestCodexModels(rows));
  return { latest: rows.filter((row) => top.has(row)), older: rows.filter((row) => !top.has(row)) };
}

/** The label a fold row announces: "Older models, collapsed, 7". */
export function aeFoldRowLabel(count: number, open: boolean): string {
  return `Older models, ${open ? "expanded" : "collapsed"}, ${count}`;
}
