// The rail Agents card's "Child chats" model (omnigent-ae, 2026-10-29): the family
// child sessions the open chat started, split into open and closed, each open one with
// a status, ordered so what waits on the user comes first. Pure: the card reads the
// conversation rows and hands them in. The card: components/aeRail/AeRailChildChats.tsx.

import type { Conversation } from "@/hooks/useConversations";
import { getSessionState } from "@/hooks/useSessionState";
import { AE_FORK_SOURCE_KEY, aeOrchParent } from "@/lib/aeFamily";
import { aeIsClosedMember } from "@/lib/aeFamilyClosed";

export type AeChildChatStatus = "needs" | "working" | "error" | "done";

export interface AeChildChat {
  row: Conversation;
  status: AeChildChatStatus;
}

export interface AeChildChatsModel {
  /** Open children, needs-you first, then working, then the rest, each newest first. */
  open: AeChildChat[];
  /** Closed children (reference or archived), newest first. */
  closed: Conversation[];
  /** The open children waiting on the user, in the same order. */
  needs: AeChildChat[];
  working: number;
  /** What the archived read could not tell: it hit its page cap, or failed with nothing cached. */
  archivedNote: "capped" | "failed" | null;
}

const ORDER: Record<AeChildChatStatus, number> = { needs: 0, working: 1, error: 2, done: 2 };

export function aeChildChatStatus(row: Conversation): AeChildChatStatus {
  const state = getSessionState(row);
  if (state?.kind === "awaiting") return "needs";
  if (state?.kind === "running" || state?.kind === "starting") return "working";
  if (state?.kind === "error" || state?.kind === "disconnected") return "error";
  return "done";
}

/** The direct children `sessionId` started; a fork of a session is new work, not a helper. */
export function aeChildChatsOf(rows: readonly Conversation[], sessionId: string): Conversation[] {
  return rows.filter(
    (row) =>
      row.id !== sessionId &&
      aeOrchParent(row.labels) === sessionId &&
      !row.labels?.[AE_FORK_SOURCE_KEY],
  );
}

export function buildAeChildChats(
  rows: readonly Conversation[],
  sessionId: string,
): AeChildChatsModel {
  const children = aeChildChatsOf(rows, sessionId);
  const newestFirst = (a: Conversation, b: Conversation) => b.updated_at - a.updated_at;
  const open = children
    .filter((row) => !aeIsClosedMember(row))
    .map((row) => ({ row, status: aeChildChatStatus(row) }))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || newestFirst(a.row, b.row));
  const closed = children.filter(aeIsClosedMember).sort(newestFirst);
  return {
    open,
    closed,
    needs: open.filter((c) => c.status === "needs"),
    working: open.filter((c) => c.status === "working").length,
    archivedNote: null,
  };
}
