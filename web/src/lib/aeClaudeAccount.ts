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
  /** No terminal was running: the login is stored and the child starts on it next time. */
  queued?: AeChildOutcome[];
  /** Set when the cascade itself failed after the chat switched; no child was attempted. */
  error?: string;
}

export interface AeSwitchAnswer {
  account: string;
  /** False when no runner is bound (the next launch uses the login) or the restart is unconfirmed. */
  relaunched: boolean;
  pending?: boolean;
  /** The chat has no running terminal: the login is stored and the chat starts on it next time. */
  queued?: boolean;
  /** Present only when the switch asked for the children too. */
  children?: AeChildrenAnswer;
}

export interface AeMoveAllAnswer {
  moved: string[];
  skipped: { id: string; title: string; reason: string }[];
  /** Still switching when the server answered; they finish on their own. */
  pending: { id: string; title: string; reason: string }[];
  /** No terminal was running: the login is stored and each starts on it next time. */
  queued?: { id: string; title: string; reason: string }[];
}

/** Re-read a chat's labels and its Usage numbers after its login changed. */
export function aeRefreshChatAccount(queryClient: QueryClient, sessionId: string | null): void {
  void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
  if (sessionId) void queryClient.invalidateQueries({ queryKey: ["ae-limits", sessionId] });
}

/**
 * When to re-read the Usage numbers after a switch (ms after it succeeded). The server answers
 * from the runner's launch-time label, which the runner stamps only after the terminal
 * relaunches, so the first re-read can still see the old login (2026-10-30). The 60 s tail
 * covers a slow relaunch (a pending switch, a busy host, a move-all over many chats).
 */
export const AE_ACCOUNT_FOLLOW_UP_DELAYS_MS = [2000, 5000, 12000, 30000, 60000];

// One schedule per chat, held outside React: the composer menu that starts a switch unmounts
// when it closes, and the re-reads must outlive it. A timer that fires after the user left the
// chat is harmless, an inactive query is only marked stale.
const followUps = new Map<string, () => void>();

/**
 * Re-read the chat's Usage numbers again at each follow-up delay, so the card catches the
 * runner's stamp. Call it after a switch succeeded (and after the immediate
 * `aeRefreshChatAccount`). A repeat call for the same chat replaces its earlier schedule.
 * Returns a function that cancels the pending re-reads.
 */
export function aeRefreshChatAccountSoon(
  queryClient: QueryClient,
  sessionId: string | null,
): () => void {
  if (!sessionId) return () => {};
  followUps.get(sessionId)?.();
  const timers = AE_ACCOUNT_FOLLOW_UP_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["ae-limits", sessionId] });
      if (delay === AE_ACCOUNT_FOLLOW_UP_DELAYS_MS[AE_ACCOUNT_FOLLOW_UP_DELAYS_MS.length - 1]) {
        if (followUps.get(sessionId) === cancel) followUps.delete(sessionId);
      }
    }, delay),
  );
  const cancel = () => {
    timers.forEach(clearTimeout);
    if (followUps.get(sessionId) === cancel) followUps.delete(sessionId);
  };
  followUps.set(sessionId, cancel);
  return cancel;
}

/**
 * The login a chat is on: the last launch's, else the stored pick, else unknown (`undefined`).
 * Same order as the server: a pick stored while the chat was not running is not its login yet.
 */
export function aeChatAccount(
  labels: Record<string, string> | null | undefined,
): string | undefined {
  const held = labels ?? {};
  return held[AE_LIVE_ACCOUNT_LABEL] ?? held[AE_SERVER_ACCOUNT_LABEL];
}

/** Whether the chat both runs on `account` and has it stored, so a switch to it changes nothing. */
export function aeChatAccountSettled(
  labels: Record<string, string> | null | undefined,
  account: string,
): boolean {
  const stored = (labels ?? {})[AE_SERVER_ACCOUNT_LABEL];
  return aeChatAccount(labels) === account && (stored === undefined || stored === account);
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
export function aeMoveAllSummary(answer: AeMoveAllAnswer, label?: string): string {
  const count = answer.moved.length;
  const moved = `Moved ${count} ${count === 1 ? "chat" : "chats"}`;
  const parts: string[] = [];
  const queued = answer.queued?.length ?? 0;
  if (queued > 0) parts.push(`${plural(queued, "chat")} not running ${startsNext(queued, label)}`);
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
/** "starts on X at its next message", for chats whose login was stored with no terminal running. */
const startsNext = (count: number, label: string | undefined) =>
  `${count === 1 ? "starts" : "start"} on ${label ?? "it"} at ${count === 1 ? "its" : "their"} next message`;

/**
 * The toast after a switch: "This chat now runs on X; 2 child chats moved; 1 skipped:
 * Reviewer is mid-reply". Without a `children` answer it is the plain one-chat line.
 */
export function aeSwitchSummary(label: string, answer: AeSwitchAnswer): string {
  const own = answer.queued
    ? `This chat starts on ${label} at its next message`
    : `This chat now runs on ${label}`;
  const kids = answer.children;
  if (!kids) return `${own}.`;
  if (kids.error) return `${own}; its child chats were not switched`;
  const parts = [own];
  if (kids.moved.length > 0) parts.push(`${plural(kids.moved.length, "child chat")} moved`);
  const queued = kids.queued?.length ?? 0;
  if (queued > 0) parts.push(`${plural(queued, "child chat")} ${startsNext(queued, label)}`);
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
  const kids = answer.children;
  return [...(kids?.moved ?? []), ...(kids?.pending ?? []), ...(kids?.queued ?? [])].map(
    (c) => c.id,
  );
}
