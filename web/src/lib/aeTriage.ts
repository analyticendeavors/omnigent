// The sidebar's Triage grouping (omnigent-ae, 2026-10-19): one group per shown
// `ae.status`, in the order a person works through them, with the sessions
// that carry no status between the active and the resting ones.

import type { Conversation } from "@/hooks/useConversations";
import { type AeStatus, aeDisplayStatus } from "@/lib/aeLabels";

export const AE_TRIAGE_GROUPS = [
  "Blocked",
  "Working",
  "Review",
  "No status",
  "Parked",
  "Reference",
] as const;
export type AeTriageGroup = (typeof AE_TRIAGE_GROUPS)[number];

/** Each group's status; `null` for "No status". */
export const AE_TRIAGE_STATUS: Record<AeTriageGroup, AeStatus | null> = {
  Blocked: "blocked",
  Working: "working",
  Review: "review",
  "No status": null,
  Parked: "parked",
  Reference: "reference",
};

// The group each status falls in; the titles are the status words the row
// icons show (`AE_STATUS_WORDS`).
const GROUP_OF = Object.fromEntries(
  AE_TRIAGE_GROUPS.flatMap((group) => {
    const status = AE_TRIAGE_STATUS[group];
    return status ? [[status, group]] : [];
  }),
) as Record<AeStatus, AeTriageGroup>;

/** What a row's Triage group reads. */
export type AeTriageRow = Pick<Conversation, "id" | "labels" | "pending_elicitations_count">;

/**
 * A row's group, from the status the row shows (blocked included). A `frozen`
 * map pins the first answer while the pointer is in the list, so a status
 * change under the cursor does not move the row to another group.
 */
export function aeTriageGroupOf(
  conversation: AeTriageRow,
  frozen: Map<string, AeTriageGroup> | null,
): AeTriageGroup {
  const held = frozen?.get(conversation.id);
  if (held) return held;
  const status = aeDisplayStatus(conversation);
  const group: AeTriageGroup = status ? GROUP_OF[status] : "No status";
  frozen?.set(conversation.id, group);
  return group;
}

/** Rows in the Triage groups' order, each group keeping the order the rows came in. */
export function aeSortByTriage<T extends AeTriageRow>(
  rows: T[],
  frozen: Map<string, AeTriageGroup> | null,
): T[] {
  const rank = new Map(
    rows.map((row) => [row.id, AE_TRIAGE_GROUPS.indexOf(aeTriageGroupOf(row, frozen))]),
  );
  return [...rows].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/** Rows per group title, from the list's id-to-title map. */
export function aeGroupCounts(
  groupTitles: ReadonlyMap<string, string> | null,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of groupTitles?.values() ?? []) counts.set(title, (counts.get(title) ?? 0) + 1);
  return counts;
}
