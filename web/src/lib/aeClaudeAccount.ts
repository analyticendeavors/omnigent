// Switching a Claude chat's login in place, or every open chat's (omnigent-ae,
// 2026-10-27). A chat stays on the login it started with; `PUT
// /v1/ae/sessions/{id}/claude-account` stores a new one and restarts the chat's
// Claude terminal on it, `POST /v1/ae/claude-account/move-all` does that for
// every open chat the caller owns (packages/ae_omni_policies/.../claude_account.py).

import type { QueryClient } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";

/** The login a fork or an in-place switch stored on the session (server-internal label). */
export const AE_SERVER_ACCOUNT_LABEL = "omnigent.claude_native.account";
/** The login the chat's terminal last launched on; "" is the default login. */
export const AE_LIVE_ACCOUNT_LABEL = "ae.claude_account";

export const AE_THIS_CHAT_HEADING = "This chat";
export const AE_NEW_CHATS_HEADING = "New chats";
export const AE_THIS_CHAT_HINT =
  "Restarts this chat on that login and resumes it. Its next reply re-reads the conversation, which costs extra tokens on that subscription.";
export const AE_THIS_CHAT_BUSY_HINT =
  "Claude is replying. Wait for the reply, or stop it, then switch.";

export const AE_MOVE_ALL_CAUTION =
  "Each moved chat restarts on the new login and resumes its conversation; its next reply re-reads the conversation, which costs extra tokens on that subscription. Chats that are mid-reply are skipped.";

export interface AeChildOutcome {
  id: string;
  title: string;
  /** Why the child did not switch; absent on a moved child. */
  reason?: string;
}

/** What the server did with the chat's family children (`include_children` on the switch). */
export interface AeChildrenAnswer {
  moved: AeChildOutcome[];
  skipped: AeChildOutcome[];
  pending: AeChildOutcome[];
  /** Set when the cascade itself failed after the chat switched; no child was attempted. */
  error?: string;
}

export interface AeSwitchAnswer {
  account: string;
  /** False when no runner is bound (the next launch uses the login) or the restart is unconfirmed. */
  relaunched: boolean;
  pending?: boolean;
  /** Present only when the switch asked for the children too. */
  children?: AeChildrenAnswer;
}

export interface AeMoveAllAnswer {
  moved: string[];
  skipped: { id: string; title: string; reason: string }[];
  /** Still switching when the server answered; they finish on their own. */
  pending: { id: string; title: string; reason: string }[];
}

/** Re-read a chat's labels and its Usage numbers after its login changed. */
export function aeRefreshChatAccount(queryClient: QueryClient, sessionId: string | null): void {
  void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
  if (sessionId) void queryClient.invalidateQueries({ queryKey: ["ae-limits", sessionId] });
}

/** The login a chat is on: the stored pick, else the last launch's, else unknown (`undefined`). */
export function aeChatAccount(
  labels: Record<string, string> | null | undefined,
): string | undefined {
  const held = labels ?? {};
  return held[AE_SERVER_ACCOUNT_LABEL] ?? held[AE_LIVE_ACCOUNT_LABEL];
}

export async function putAeClaudeAccount(
  sessionId: string,
  account: string,
  includeChildren = false,
): Promise<AeSwitchAnswer> {
  const res = await authenticatedFetch(
    `/v1/ae/sessions/${encodeURIComponent(sessionId)}/claude-account`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(includeChildren ? { account, include_children: true } : { account }),
    },
  );
  if (!res.ok) throw await apiErrorFromResponse(res);
  return (await res.json()) as AeSwitchAnswer;
}

export async function moveAllAeClaudeChats(
  account: string,
  hostId: string | undefined,
): Promise<AeMoveAllAnswer> {
  const res = await authenticatedFetch("/v1/ae/claude-account/move-all", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(hostId ? { account, host_id: hostId } : { account }),
  });
  if (!res.ok) throw await apiErrorFromResponse(res);
  const body = (await res.json()) as Partial<AeMoveAllAnswer> | null;
  return { moved: body?.moved ?? [], skipped: body?.skipped ?? [], pending: body?.pending ?? [] };
}

/** One line for the result, e.g. "Moved 4 chats; 1 skipped: Fix CI is mid-reply". */
export function aeMoveAllSummary(answer: AeMoveAllAnswer): string {
  const count = answer.moved.length;
  const moved = `Moved ${count} ${count === 1 ? "chat" : "chats"}`;
  const parts: string[] = [];
  if (answer.pending.length > 0) {
    parts.push(
      `${answer.pending.length} still switching: ${answer.pending.map((s) => s.title).join(", ")}`,
    );
  }
  if (answer.skipped.length > 0) {
    const why = answer.skipped.map((s) =>
      s.reason === "mid-reply" ? `${s.title} is mid-reply` : `${s.title}: ${s.reason}`,
    );
    parts.push(`${answer.skipped.length} skipped: ${why.join(", ")}`);
  }
  return parts.length === 0 ? moved : `${moved}; ${parts.join("; ")}`;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The toast after a switch: "This chat now runs on X; 2 child chats moved; 1 skipped:
 * Reviewer is mid-reply". Without a `children` answer it is the plain one-chat line.
 */
export function aeSwitchSummary(label: string, answer: AeSwitchAnswer): string {
  const own = `This chat now runs on ${label}`;
  const kids = answer.children;
  if (!kids) return `${own}.`;
  if (kids.error) return `${own}; its child chats were not switched`;
  const parts = [own];
  if (kids.moved.length > 0) parts.push(`${plural(kids.moved.length, "child chat")} moved`);
  if (kids.pending.length > 0) {
    parts.push(
      `${kids.pending.length} still switching: ${kids.pending.map((c) => c.title).join(", ")}`,
    );
  }
  if (kids.skipped.length > 0) {
    const why = kids.skipped.map((c) =>
      c.reason === "mid-reply" ? `${c.title} is mid-reply` : `${c.title}: ${c.reason ?? "skipped"}`,
    );
    parts.push(`${kids.skipped.length} skipped: ${why.join(", ")}`);
  }
  return parts.join("; ");
}

/** The chats a switch touched besides the one asked about, to re-read their logins. */
export function aeSwitchedChildIds(answer: AeSwitchAnswer): string[] {
  return [...(answer.children?.moved ?? []), ...(answer.children?.pending ?? [])].map((c) => c.id);
}
