// The `ae.*` session label vocabulary, mirrored from the AE layer's
// `packages/ae_omni_policies/src/ae_omni_policies/labels.py` (omnigent-ae) so
// the UI and the policies agree on every key and value. `docs/LABELS.md` in
// omnigent-ae documents the semantics for people.
//
// Status is a label, never a title glyph: the sidebar renders `ae.status` as an
// icon (`AeStatusIcon`) and counts the working rows for the slots pill
// (`AeSlotsPill`). Policies cannot delete a label (`set_labels` is an upsert),
// so a key is cleared by writing `""`, and every reader here treats an empty
// or blank value as unset.

import type { Conversation } from "@/hooks/useConversations";

export const AE_NAMESPACE = "ae.";

export const AE_STATUS_KEY = "ae.status";
export const AE_STARTED_KEY = "ae.started";
export const AE_GATE_KEY = "ae.gate";
export const AE_FORK_KEY = "ae.fork";
export const AE_NEXT_KEY = "ae.next";
export const AE_ABSORBED_KEY = "ae.absorbed";
export const AE_UNFILED_KEY = "ae.unfiled";
export const AE_FORK_SUSPECT_KEY = "ae.fork_suspect";
export const AE_TRIAGE_KEY = "ae.triage";
export const AE_TASK_KEY = "ae.task";
export const AE_OVERFLOW_KEY = "ae.overflow";

/** The `ae.status` values, in the order the Parking Lot page lists them. */
export const AE_STATUS_VALUES = ["working", "blocked", "review", "parked", "reference"] as const;
export type AeStatus = (typeof AE_STATUS_VALUES)[number];

/** Three slots (branch-discipline rules, "Slots: 3"); `SLOT_LIMIT` in labels.py. */
export const AE_SLOT_LIMIT = 3;

/** Where the slots pill links: the Parking Lot page (an extension, Phase 3). */
export const AE_PARKING_LOT_PATH = "/extensions/analyticendeavors.parking-lot/lot";

/** Every route of the Dashboard extension (both its pages render the Dashboard). */
export const AE_DASHBOARD_PREFIX = "/extensions/analyticendeavors.parking-lot/";

/**
 * The legacy session-title glyphs from the branch-discipline rules, one per
 * status. Imported Claude Code sessions carry them; nothing here ever writes
 * one back, and the sidebar strips a leading one for display only.
 */
export const AE_LEGACY_GLYPHS: Record<AeStatus, string> = {
  working: "\u{1F7E1}", // 🟡
  blocked: "\u{1F534}", // 🔴
  review: "✅", // ✅
  parked: "\u{1F4CC}", // 📌
  reference: "\u{1F5C2}", // 🗂 (usually followed by U+FE0F)
};

// A leading legacy glyph, an optional emoji presentation selector (U+FE0F),
// then the whitespace that separated it from the name.
const LEADING_GLYPH = new RegExp(
  `^(?:${Object.values(AE_LEGACY_GLYPHS).join("|")})\\uFE0F?\\s*`,
  "u",
);

/**
 * Drop a leading legacy status glyph from a title, for display only.
 * `"🟡 Fix the build"` reads `"Fix the build"`; a title with no glyph, or a
 * glyph anywhere but the front, comes back unchanged.
 */
export function stripLeadingGlyph(title: string): string {
  return title.replace(LEADING_GLYPH, "");
}

/**
 * Read one `ae.*` label. `null` when the key is missing, empty or blank
 * (mirrors `labels.py` `label()`).
 */
export function aeLabel(
  labels: Record<string, string> | null | undefined,
  key: string,
): string | null {
  const value = labels?.[key];
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isAeStatus(value: string): value is AeStatus {
  return (AE_STATUS_VALUES as readonly string[]).includes(value);
}

/** The session's stored `ae.status`, or `null` when unset or not a known value. */
export function aeStatusOf(labels: Record<string, string> | null | undefined): AeStatus | null {
  const value = aeLabel(labels, AE_STATUS_KEY);
  return value !== null && isAeStatus(value) ? value : null;
}

/**
 * The status the UI shows for a row. Blocked is derived, not stored
 * (`docs/LABELS.md`, decided 2026-09-23): a working session with an approval
 * prompt outstanding is waiting on the human and reads as blocked. The stored
 * value `blocked` still shows as blocked when the page or the MCP tool set it.
 */
export function aeDisplayStatus(
  conversation: Pick<Conversation, "labels" | "pending_elicitations_count">,
): AeStatus | null {
  const status = aeStatusOf(conversation.labels);
  if (status === "working" && (conversation.pending_elicitations_count ?? 0) > 0) {
    return "blocked";
  }
  return status;
}

/**
 * Whether a row holds a slot: `ae.status=working`, not archived, and not a
 * sub-agent (sub-agents run inside their parent's slot). Mirrors the slot
 * cap's count in `ae_omni_policies.slot_cap`.
 */
export function isAeSlot(
  conversation: Pick<Conversation, "labels" | "archived" | "parent_session_id">,
): boolean {
  return (
    aeStatusOf(conversation.labels) === "working" &&
    !conversation.archived &&
    (conversation.parent_session_id ?? null) === null
  );
}

/**
 * The `ae.*` labels of a row and nothing else, for the extension host's
 * session summaries (patch P2): an extension page sees the AE vocabulary and
 * never another label key. Values are strings already; anything else is
 * dropped rather than coerced.
 */
export function pickAeLabels(labels: unknown): Record<string, string> {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return {};
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels as Record<string, unknown>)) {
    if (key.startsWith(AE_NAMESPACE) && typeof value === "string") picked[key] = value;
  }
  return picked;
}

/** Count the slots held across rows, each session counted once by id. */
export function countAeSlots(
  conversations: Iterable<Pick<Conversation, "id" | "labels" | "archived" | "parent_session_id">>,
): number {
  const counted = new Set<string>();
  let count = 0;
  for (const conversation of conversations) {
    if (counted.has(conversation.id)) continue;
    counted.add(conversation.id);
    if (isAeSlot(conversation)) count += 1;
  }
  return count;
}
