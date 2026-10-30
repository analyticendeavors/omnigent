// The Compact card's model (omnigent-ae, 2026-10-29): the server sweep
// (lead_handoff.py) labels a top-level Claude chat `ae.handoff=suggest` once its
// context passes the owner's "Suggest compacting at" size, with the size in
// `ae.handoff_at`. The dock and the rail both read it from the cached session row.
// Pure, so the rules are unit-tested (aeCompactSuggestion.test.ts).

import { authenticatedFetch } from "@/lib/identity";
import { ApiError, apiErrorFromResponse } from "@/lib/sessionsApi";

export const AE_HANDOFF_KEY = "ae.handoff";
export const AE_HANDOFF_AT_KEY = "ae.handoff_at";
const AE_STATUS_LABEL = "ae.status";
const CONTEXT_KEY = "omnigent.last_context_tokens";
const CLAUDE_WRAPPER = "claude-code-native-ui";

export interface AeCompactSuggestion {
  tokens: number;
}

function positive(raw: string | undefined): number | null {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The cached facts about a session that the card needs (aeRailSessionData.ts). */
export interface AeCompactRow {
  labels: Record<string, string>;
  parentId?: string | null;
  archived?: boolean;
  kind?: string | null;
}

function held(labels: Record<string, string>, key: string): string | null {
  const value = labels[key]?.trim();
  return value ? value : null;
}

/**
 * The same chats the server's sweep may label (`lead_handoff.is_lead`): a top-level Claude chat the
 * user opened, working or blocked. A stale `suggest` label on a family child, a reviewer, a fork,
 * a side chat, a chat on another harness or a native sub-agent must not offer to compact it.
 */
export function aeCompactEligible(row: AeCompactRow): boolean {
  const { labels } = row;
  if (row.parentId || row.archived) return false;
  if (row.kind && row.kind !== "default") return false;
  // `ae.orch` set to "1" names no parent; any other value is a family child.
  const orch = held(labels, "ae.orch");
  if (orch && orch !== "1") return false;
  if (held(labels, "omnigent.fork.source_id") || held(labels, "omnigent.side_chat")) return false;
  const role = held(labels, "ae.role");
  if (role && role !== "lead") return false;
  if (held(labels, "omnigent.wrapper") !== CLAUDE_WRAPPER) return false;
  const status = held(labels, AE_STATUS_LABEL);
  return status === "working" || status === "blocked";
}

/** The suggestion the row carries, or `null` (see `aeCompactEligible`). */
export function aeCompactSuggestion(
  row: AeCompactRow | null | undefined,
): AeCompactSuggestion | null {
  if (!row || row.labels[AE_HANDOFF_KEY] !== "suggest" || !aeCompactEligible(row)) return null;
  const { labels } = row;
  return { tokens: positive(labels[AE_HANDOFF_AT_KEY]) ?? positive(labels[CONTEXT_KEY]) ?? 0 };
}

/** "370k": the size in thousands, rounded. */
export function aeCompactTokens(tokens: number): string {
  return tokens > 0 ? `${Math.round(tokens / 1000)}k` : "a lot of";
}

/** The line the card and the rail share. */
export function aeCompactText(tokens: number): string {
  return `This chat is at ${aeCompactTokens(tokens)} tokens. Every reply re-reads all of it.`;
}

/** "Not now" and Compact: no new suggestion until the context grew another 100k tokens. */
export async function postAeHandoffSnooze(sessionId: string): Promise<void> {
  const res = await authenticatedFetch(
    `/v1/ae/sessions/${encodeURIComponent(sessionId)}/handoff/snooze`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
}

/**
 * Whether a failed snooze is worth telling the user about. A 409 means the chat handed off, left
 * work or has no context reading: the label is changing and the card goes by itself.
 */
export function aeSnoozeFailureIsQuiet(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 409;
}
