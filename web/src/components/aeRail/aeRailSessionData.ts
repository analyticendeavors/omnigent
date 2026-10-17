// The open session as the rail reads it, from what the app already holds:
// labels from the caches the sidebar keeps warm (its lists, the pinned list,
// the backfill row, then the session snapshot), and the chat's loaded blocks.
// Neither costs a request, and a push or the Status menu's overlay repaints both.

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { Conversation } from "@/hooks/useConversations";
import type { AnyBlock } from "@/lib/blocks";
import type { ConversationsInfiniteData } from "@/lib/sessionListCache";
import type { Session } from "@/lib/types";
import { useChatStore } from "@/store/chatStore";

export type AeLabels = Record<string, string>;

const NO_LABELS: AeLabels = {};

/** This session's labels from any cached copy, or `null` when no cache holds it. */
export function readAeRailSessionLabels(queryClient: QueryClient, id: string): AeLabels | null {
  for (const queryKey of [["conversations"], ["project-sessions"]]) {
    for (const [, data] of queryClient.getQueriesData<ConversationsInfiniteData>({ queryKey })) {
      for (const page of data?.pages ?? []) {
        const row = page.data.find((conversation: Conversation) => conversation.id === id);
        if (row) return row.labels ?? NO_LABELS;
      }
    }
  }
  const pinned = queryClient.getQueryData<{ conversations: Conversation[] }>([
    "pinned-conversations",
  ]);
  const pinnedRow = pinned?.conversations.find((row) => row.id === id);
  if (pinnedRow) return pinnedRow.labels ?? NO_LABELS;
  const backfill = queryClient.getQueryData<Conversation | null>(["conversation-backfill", id]);
  if (backfill) return backfill.labels ?? NO_LABELS;
  const snapshot = queryClient.getQueryData<Session>(["session", id]);
  if (snapshot) return snapshot.labels ?? NO_LABELS;
  return null;
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
