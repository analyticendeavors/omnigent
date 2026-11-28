// The owner's master chat (omnigent-ae, 2026-11-27): the two `/v1/ae/master-chat` routes behind
// the sidebar's "Master chat" row (AeMasterChatRow). `GET` answers the session id (or null) and
// how many sessions wait on the owner; `POST` finds the session or creates it. The server keeps
// the id in its own registry (`ae_omni_policies.master_chat`), never in a label; the id read here
// is the one every client rule compares against (`isAeMasterChat`). The master chat holds no
// working slot there (`sessions.working_sessions`) and `isAeSlot` in `aeLabels.ts` mirrors that.

import { type QueryClient, useQuery } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/identity";

export const AE_MASTER_CHAT_QUERY_KEY = ["ae", "master-chat"] as const;

const REFETCH_MS = 60_000;
/** The server caches its answer this long, so asking sooner only reads the cache. */
const STALE_MS = 5_000;

export interface AeMasterChat {
  /** The caller's open master chat, or null before the first click. */
  sessionId: string | null;
  /** Sessions waiting on the owner, or null when the server could not count them. */
  waiting: number | null;
}

/**
 * Whether a row is the master chat: its id is the one the server's registry holds, and it is not
 * archived (an archived one is an ordinary row at once, before the next read drops the id).
 */
export function isAeMasterChat(
  row: { id: string; archived?: boolean },
  masterId: string | null | undefined,
): boolean {
  return Boolean(masterId) && row.id === masterId && row.archived !== true;
}

/** The master chat id the last `GET` read, from the query cache (null until one has). */
export function readAeMasterChatId(queryClient: QueryClient): string | null {
  return queryClient.getQueryData<AeMasterChat>(AE_MASTER_CHAT_QUERY_KEY)?.sessionId ?? null;
}

/**
 * `GET /v1/ae/master-chat`. An older server (404) reads as no master chat; any other failure
 * throws, so the query keeps the id it already has instead of dropping it for a moment.
 */
export async function fetchAeMasterChat(): Promise<AeMasterChat> {
  const res = await authenticatedFetch("/v1/ae/master-chat", { method: "GET" });
  if (res.status === 404) return { sessionId: null, waiting: null };
  if (!res.ok) throw new Error(`Reading the master chat failed (${res.status}).`);
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
 * The options both hooks share. react-query keeps the options of whichever observer rendered
 * last, so they must agree on the key, the reader, `retry` and `staleTime`.
 */
const MASTER_CHAT_QUERY = {
  queryKey: AE_MASTER_CHAT_QUERY_KEY,
  queryFn: fetchAeMasterChat,
  staleTime: STALE_MS,
  retry: false,
} as const;

/**
 * The master chat's id and the waiting count: read every 60 s and on window focus, and after a
 * click creates it (`refreshAeMasterChat`). It does not follow the conversation list: the list
 * changes on every streamed event, and one read per event is a read the server would only
 * answer from its cache.
 */
export function useAeMasterChat(): AeMasterChat {
  const { data } = useQuery({
    ...MASTER_CHAT_QUERY,
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: true,
  });
  return data ?? { sessionId: null, waiting: null };
}

/**
 * Only the master chat's id, for the lists that hide it. It follows the cache the row's
 * `useAeMasterChat` fills and never fetches or sets a timer of its own.
 */
export function useAeMasterChatId(): string | null {
  const { data } = useQuery({
    ...MASTER_CHAT_QUERY,
    enabled: false,
    select: (chat: AeMasterChat) => chat.sessionId,
  });
  return data ?? null;
}
