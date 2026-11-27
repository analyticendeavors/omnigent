// The plain-English line for a notification toast about a new approval (2026-11-27).
// The toast has only the conversation list row, so the line comes from the Inbox's snapshot
// of that session's pending prompts when one is already in the query cache for this exact
// row state (same pending count and updated_at, the Inbox's own cache key). A stale
// snapshot would name the wrong prompt, so a miss keeps the generic toast body. No fetch.

import type { QueryClient } from "@tanstack/react-query";
import type { Conversation } from "@/hooks/useConversations";
import { summarizeApproval } from "./aeApprovalSummary";
import { parseEvent } from "./sse";
import type { Session } from "./types";

export function cachedApprovalSummaryText(
  queryClient: QueryClient,
  row: Pick<Conversation, "id" | "pending_elicitations_count" | "updated_at">,
): string | null {
  const snapshot = queryClient.getQueryData<Session>([
    "inbox-elicitations",
    row.id,
    row.pending_elicitations_count,
    row.updated_at,
  ]);
  const pending = snapshot?.pendingElicitations ?? [];
  for (let i = pending.length - 1; i >= 0; i--) {
    const evt = parseEvent("response.elicitation_request", pending[i]);
    if (evt === null || evt.type !== "elicitation_request") continue;
    return summarizeApproval(evt)?.text ?? null;
  }
  return null;
}
