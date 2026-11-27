// The owner's master chat (omnigent-ae, 2026-11-27): the label that marks it, and the two
// `/v1/ae/master-chat` routes behind the sidebar's "Master chat" row (AeMasterChatRow).
// `GET` answers the session id (or null) and how many sessions wait on the owner; `POST` finds
// the session or creates it. The server rules live in `ae_omni_policies.router`
// (`master_chat_view`, `master_chat_open`); the master chat holds no working slot there
// (`sessions.working_sessions`) and `isAeSlot` in `aeLabels.ts` mirrors that.

import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { subscribeToQueryKeys } from "@/lib/aeQueryCacheSubscribe";
import { authenticatedFetch } from "@/lib/identity";

export const AE_MASTER_KEY = "ae.master";
export const AE_MASTER_CHAT_QUERY_KEY = ["ae", "master-chat"] as const;

const REFETCH_MS = 60_000;
/** Conversation-list changes refetch the count at most this often. */
const LIST_REFETCH_GAP_MS = 5_000;

export interface AeMasterChat {
  /** The caller's open master chat, or null before the first click. */
  sessionId: string | null;
  /** Sessions waiting on the owner, or null when the server could not count them. */
  waiting: number | null;
}

/** A conversation row labelled as the master chat. */
export function isAeMasterChat(row: { labels?: Record<string, string> | null }): boolean {
  return Boolean(row.labels?.[AE_MASTER_KEY]?.trim());
}

/** `GET /v1/ae/master-chat`; an older server (404) or any failure reads as nothing known. */
export async function fetchAeMasterChat(): Promise<AeMasterChat> {
  const res = await authenticatedFetch("/v1/ae/master-chat", { method: "GET" });
  if (!res.ok) return { sessionId: null, waiting: null };
  const body = (await res.json()) as { session_id?: unknown; waiting?: unknown };
  return {
    sessionId: typeof body.session_id === "string" ? body.session_id : null,
    waiting: typeof body.waiting === "number" ? body.waiting : null,
  };
}

/** `POST /v1/ae/master-chat`: the session id, creating the session the first time. Throws the server's sentence. */
export async function openAeMasterChat(): Promise<string> {
  const res = await authenticatedFetch("/v1/ae/master-chat", { method: "POST" });
  const body = (await res.json().catch(() => null)) as {
    session_id?: unknown;
    error?: { message?: unknown };
  } | null;
  if (res.ok && typeof body?.session_id === "string") return body.session_id;
  const reason = body?.error?.message;
  throw new Error(
    typeof reason === "string" && reason
      ? reason
      : `Opening the master chat failed (${res.status}).`,
  );
}

/** Re-read the master chat now (after a click created it). */
export function refreshAeMasterChat(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: AE_MASTER_CHAT_QUERY_KEY });
}

/**
 * The master chat's id and the waiting count: read every 60 s and on window focus, and again
 * (at most once in 5 s) when the cached conversation rows change, since a session moving to
 * review or blocked changes the count.
 */
export function useAeMasterChat(): AeMasterChat {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: AE_MASTER_CHAT_QUERY_KEY,
    queryFn: fetchAeMasterChat,
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: true,
    staleTime: LIST_REFETCH_GAP_MS,
    retry: false,
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeToQueryKeys(queryClient, [["conversations"]], () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void refreshAeMasterChat(queryClient);
      }, LIST_REFETCH_GAP_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [queryClient]);
  return data ?? { sessionId: null, waiting: null };
}
