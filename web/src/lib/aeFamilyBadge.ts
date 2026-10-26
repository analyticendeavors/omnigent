// The marks on a family's child row (omnigent-ae, 2026-10-25): a one-letter role
// badge before the title and a small up arrow after it for a raised helper. The
// row component: shell/AeFamilyTree.tsx.

import type { AeAgentRoleId } from "@/lib/aeAgentRole";
import {
  type AeModelPoint,
  aeLabelCount,
  aeModelPointText,
  parseAeModelStart,
} from "@/lib/aeModelChange";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";

/**
 * The letter and the colors of each role's badge. Opaque fills only: every pair is
 * at least 4.5:1 for the 10px letter in light and dark. A lead row has no badge (it is
 * the row itself), but a nested child labeled ae.role=lead keeps its L.
 */
export const AE_FAMILY_BADGES: Readonly<
  Partial<Record<AeAgentRoleId, { letter: string; className: string }>>
> = {
  lead: {
    letter: "L",
    className: "bg-blue-700 text-white dark:bg-blue-300 dark:text-blue-950",
  },
  planner: {
    letter: "P",
    className: "bg-violet-600 text-white dark:bg-violet-400 dark:text-violet-950",
  },
  reviewer: {
    letter: "R",
    className: "bg-cyan-700 text-white dark:bg-cyan-400 dark:text-cyan-950",
  },
  builder: { letter: "B", className: "bg-amber-500 text-amber-950 dark:bg-amber-400" },
  helper: {
    letter: "H",
    className: "bg-emerald-700 text-white dark:bg-emerald-300 dark:text-emerald-950",
  },
};

/** "Reviewer · Codex medium"; just the role when the model is not known. */
export function aeFamilyBadgeLabel(roleName: string, at: AeModelPoint | null): string {
  const model = at && (at.model || at.effort) ? aeModelPointText(at) : "";
  return model ? `${roleName} · ${model}` : roleName;
}

/** The raise arrow's text: where the helper started and how many raises it used. */
export function aeRaiseArrowTitle(
  labels: Readonly<Record<string, string>> | null | undefined,
  capReached: boolean,
): string {
  const raises = aeLabelCount(labels?.["ae.raises"]) ?? 0;
  const cap = aeLabelCount(labels?.["ae.raise_cap"]);
  const count = `${raises} of ${cap ?? "?"}`;
  if (capReached) return `Raise limit reached (${count})`;
  const started = parseAeModelStart(labels?.["ae.model_start"]);
  return started ? `Raised from ${aeModelPointText(started)} (${count})` : `Raised (${count})`;
}

/** Tabler `arrow-up` (outline, @tabler/icons 3.46.0), inlined. */
export const AE_ARROW_UP_ICON: AeTablerIconNode = [
  ["path", { d: "M12 5l0 14" }],
  ["path", { d: "M18 11l-6 -6" }],
  ["path", { d: "M6 11l6 -6" }],
];

/**
 * The time label's column on every sidebar row (Sidebar.tsx applies it to all of
 * them, not only a family's), so the times line up. A minimum width, so "12mo" or
 * "99y" at text-sm grows the column instead of clipping.
 */
export const AE_TIME_COLUMN = "min-w-[34px] shrink-0 justify-end text-right tabular-nums";
