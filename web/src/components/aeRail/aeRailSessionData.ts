// The open session as the rail reads it, from what the app already holds:
// labels from the caches the sidebar keeps warm (its lists, the pinned list,
// the backfill row, then the session snapshot), and the chat's loaded blocks.
// Neither costs a request, and a push or the Status menu's overlay repaints both.

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { Conversation } from "@/hooks/useConversations";
import type { AnyBlock } from "@/lib/blocks";
import type { ConversationsInfiniteData } from "@/lib/sessionListCache";
import type { Session } from "@/lib/types";
import { useChatStore } from "@/store/chatStore";

export type AeLabels = Record<string, string>;

const NO_LABELS: AeLabels = {};

/** What the caches know of a session beyond its labels: the facts the Compact card checks. */
export interface AeRailSessionRow {
  labels: AeLabels;
  /** A sub-agent or other child session names its parent. */
  parentId: string | null;
  archived: boolean;
  /** `"sub_agent"` for native child sessions, else `"default"`; `null` when the copy lacks it. */
  kind: string | null;
}

function fromConversation(row: Conversation): AeRailSessionRow {
  return {
    labels: row.labels ?? NO_LABELS,
    parentId: row.parent_session_id ?? null,
    archived: row.archived === true,
    kind: null,
  };
}

/** This session's row from any cached copy, or `null` when no cache holds it. */
export function readAeRailSessionRow(
  queryClient: QueryClient,
  id: string,
): AeRailSessionRow | null {
  for (const queryKey of [["conversations"], ["project-sessions"]]) {
    for (const [, data] of queryClient.getQueriesData<ConversationsInfiniteData>({ queryKey })) {
      for (const page of data?.pages ?? []) {
        const row = page.data.find((conversation: Conversation) => conversation.id === id);
        if (row) return fromConversation(row);
      }
    }
  }
  const pinned = queryClient.getQueryData<{ conversations: Conversation[] }>([
    "pinned-conversations",
  ]);
  const pinnedRow = pinned?.conversations.find((row) => row.id === id);
  if (pinnedRow) return fromConversation(pinnedRow);
  const backfill = queryClient.getQueryData<Conversation | null>(["conversation-backfill", id]);
  if (backfill) return fromConversation(backfill);
  const snapshot = queryClient.getQueryData<Session>(["session", id]);
  if (snapshot) {
    return {
      labels: snapshot.labels ?? NO_LABELS,
      parentId: snapshot.parentSessionId ?? null,
      archived: snapshot.archived === true,
      kind: snapshot.kind ?? null,
    };
  }
  return null;
}

/** This session's labels from any cached copy, or `null` when no cache holds it. */
export function readAeRailSessionLabels(queryClient: QueryClient, id: string): AeLabels | null {
  return readAeRailSessionRow(queryClient, id)?.labels ?? null;
}

/**
 * The open session's row, live; `null` until a cache holds the session. The row object is
 * rebuilt on each read, so the hook returns a stable copy while its fields are unchanged.
 */
export function useAeRailSessionRow(id: string): AeRailSessionRow | null {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const last = useRef<AeRailSessionRow | null>(null);
  const read = useCallback(() => {
    const next = readAeRailSessionRow(queryClient, id);
    const prev = last.current;
    if (
      next &&
      prev &&
      next.labels === prev.labels &&
      next.parentId === prev.parentId &&
      next.archived === prev.archived &&
      next.kind === prev.kind
    ) {
      return prev;
    }
    last.current = next;
    return next;
  }, [queryClient, id]);
  return useSyncExternalStore(subscribe, read, read);
}

/** The open session's labels, live; `null` until a cache holds the session. */
export function useAeRailSessionLabels(id: string): AeLabels | null {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const read = useCallback(() => readAeRailSessionLabels(queryClient, id), [queryClient, id]);
  return useSyncExternalStore(subscribe, read, read);
}

export interface AeRailLoadedBlocks {
  blocks: readonly AnyBlock[];
  /** Older history exists that the chat has not loaded. */
  moreHistory: boolean;
}

/** The chat's loaded blocks when it shows this session, else `null` (nothing is fetched). */
export function useAeRailLoadedBlocks(id: string): AeRailLoadedBlocks | null {
  const blocks = useChatStore((s) => (s.conversationId === id ? s.blocks : null));
  const moreHistory = useChatStore((s) => s.conversationId === id && s.hasMoreHistory);
  return useMemo(() => (blocks ? { blocks, moreHistory } : null), [blocks, moreHistory]);
}
