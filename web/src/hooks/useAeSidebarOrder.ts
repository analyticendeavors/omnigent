// The manual session order's sync with the server (omnigent-ae, 2026-10-19):
// `GET /v1/ae/sidebar` reads it and `PUT /v1/ae/sidebar` saves it, carrying
// the revision the change was based on. Moves show at once and save in turn,
// each save built on the latest order; a save the server refuses as stale
// (409, another device saved first) replays the queued moves once on the
// order it returned. There is no push for this route, so the order refetches
// on focus, on reconnect and every minute while the page is visible.

import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useRef } from "react";
import { showToast } from "@/components/ui/toast";
import type { SidebarListQuery } from "@/hooks/useSidebarData";
import { type AeMoveTo, aeIsOrderId, aeMoveInOrder } from "@/lib/aeSessionOrder";
import { authenticatedFetch } from "@/lib/identity";
import { SidebarConfigContext } from "@/lib/sidebarConfig";

export const AE_SIDEBAR_QUERY_KEY = ["ae", "sidebar"] as const;

const REFRESH_MS = 60_000;

export interface AeSidebarOrder {
  order: readonly string[];
  revision: number;
}

/** What the server answers before anyone has saved an order. */
export const AE_EMPTY_ORDER: AeSidebarOrder = { order: [], revision: 0 };

function parseOrder(value: unknown): AeSidebarOrder | null {
  if (!value || typeof value !== "object") return null;
  const { order, revision } = value as { order?: unknown; revision?: unknown };
  if (!Array.isArray(order) || !order.every((id) => typeof id === "string")) return null;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return null;
  return { order, revision };
}

/** The saved order; throws when the route cannot answer. */
export async function fetchAeSidebarOrder(): Promise<AeSidebarOrder> {
  const res = await authenticatedFetch("/v1/ae/sidebar", { method: "GET" });
  if (!res.ok) throw new Error(`GET /v1/ae/sidebar answered ${res.status}`);
  const parsed = parseOrder(await res.json());
  if (!parsed) throw new Error("GET /v1/ae/sidebar answered without an order");
  return parsed;
}

export type AePutResult =
  { ok: true; saved: AeSidebarOrder } | { ok: false; current: AeSidebarOrder };

/**
 * Save `order` on top of `revision`. A stale revision comes back as the
 * server's current order (`ok: false`); any other failure throws with the
 * status and the server's message.
 */
export async function putAeSidebarOrder(
  order: readonly string[],
  revision: number,
): Promise<AePutResult> {
  const res = await authenticatedFetch("/v1/ae/sidebar", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order, revision }),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // No JSON body; the status line is all there is.
  }
  const error = (body as { error?: { message?: unknown } } | null)?.error;
  if (res.status === 409) {
    const current = parseOrder(error);
    if (current) return { ok: false, current };
  }
  if (!res.ok) {
    const message = typeof error?.message === "string" ? `: ${error.message}` : "";
    throw new Error(`PUT /v1/ae/sidebar answered ${res.status}${message}`);
  }
  const saved = parseOrder(body);
  if (!saved) throw new Error("PUT /v1/ae/sidebar answered without an order");
  return { ok: true, saved };
}

/** One change to the order: a move within a list, or a whole new order. */
export type AeOrderOp =
  | {
      kind: "move";
      id: string;
      to: AeMoveTo;
      scopeIds: readonly string[];
      loadedIds: readonly string[];
    }
  | { kind: "set"; order: readonly string[] };

function applyOp(order: readonly string[], op: AeOrderOp): readonly string[] {
  if (op.kind === "set") return op.order;
  return aeMoveInOrder({
    order,
    loadedIds: op.loadedIds,
    scopeIds: op.scopeIds,
    id: op.id,
    to: op.to,
  });
}

interface SaveQueue {
  /** The last order the server confirmed. */
  acked: AeSidebarOrder;
  pending: AeOrderOp[];
  inflight: boolean;
  /** A stale save was already replayed once since the last confirmed one. */
  replayed: boolean;
  /** Callers waiting for the queue to drain: true once saved, false once undone. */
  waiters: ((saved: boolean) => void)[];
}

// One queue per query client, so the sidebar and Settings share it.
const queues = new WeakMap<QueryClient, SaveQueue>();

function queueOf(queryClient: QueryClient): SaveQueue {
  let queue = queues.get(queryClient);
  if (!queue) {
    queue = { acked: AE_EMPTY_ORDER, pending: [], inflight: false, replayed: false, waiters: [] };
    queues.set(queryClient, queue);
  }
  return queue;
}

function shownOrder(queryClient: QueryClient): AeSidebarOrder {
  return queryClient.getQueryData<AeSidebarOrder>(AE_SIDEBAR_QUERY_KEY) ?? AE_EMPTY_ORDER;
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBusy(queue: SaveQueue | undefined): boolean {
  return !!queue && (queue.inflight || queue.pending.length > 0);
}

function settle(queue: SaveQueue, saved: boolean): void {
  for (const resolve of queue.waiters.splice(0)) resolve(saved);
}

async function flush(queryClient: QueryClient, queue: SaveQueue): Promise<void> {
  if (queue.inflight || queue.pending.length === 0) return;
  queue.inflight = true;
  const sent = queue.pending.splice(0);
  let result: AePutResult;
  try {
    // A provisional `temp:` row has no session id yet; the server refuses it.
    const order = shownOrder(queryClient).order.filter(aeIsOrderId);
    result = await putAeSidebarOrder(order, queue.acked.revision);
  } catch (error) {
    queue.inflight = false;
    queue.pending = [];
    queue.replayed = false;
    queryClient.setQueryData(AE_SIDEBAR_QUERY_KEY, queue.acked);
    showToast(
      `Could not save the session order: ${reasonOf(error)}. ` +
        `Your recent changes to it were undone; try again.`,
    );
    settle(queue, false);
    return;
  }
  queue.inflight = false;
  if (result.ok) {
    queue.acked = result.saved;
    queue.replayed = false;
    // Moves queued meanwhile are already on screen; the next save sends them.
    if (queue.pending.length === 0) {
      queryClient.setQueryData(AE_SIDEBAR_QUERY_KEY, result.saved);
      settle(queue, true);
    }
    void flush(queryClient, queue);
    return;
  }
  queue.acked = result.current;
  const waiting = [...sent, ...queue.pending];
  if (queue.replayed) {
    queue.pending = [];
    queue.replayed = false;
    queryClient.setQueryData(AE_SIDEBAR_QUERY_KEY, result.current);
    showToast(
      "The session order changed on another device, so your recent changes to it were " +
        "undone. The list shows the saved order; try again.",
    );
    settle(queue, false);
    return;
  }
  queue.replayed = true;
  queue.pending = waiting;
  queryClient.setQueryData(AE_SIDEBAR_QUERY_KEY, {
    order: waiting.reduce(applyOp, result.current.order),
    revision: result.current.revision,
  });
  void flush(queryClient, queue);
}

/**
 * Apply a change on screen and queue its save. Returns false when it changes
 * nothing (a move past the end of a list, say), and then saves nothing.
 */
export function aeEnqueueOrder(queryClient: QueryClient, op: AeOrderOp): boolean {
  const queue = queueOf(queryClient);
  const shown = shownOrder(queryClient);
  if (!queue.inflight && queue.pending.length === 0) queue.acked = shown;
  const next = applyOp(shown.order, op);
  if (next === shown.order) return false;
  queryClient.setQueryData(AE_SIDEBAR_QUERY_KEY, { order: next, revision: shown.revision });
  queue.pending.push(op);
  void flush(queryClient, queue);
  return true;
}

/**
 * A fetched order, unless it would undo what the screen shows: while a save
 * is queued or running the shown order stands, and an answer older than the
 * shown revision (a read that raced a save) is dropped.
 */
function mergeFetched(queryClient: QueryClient, fetched: AeSidebarOrder): AeSidebarOrder {
  const shown = queryClient.getQueryData<AeSidebarOrder>(AE_SIDEBAR_QUERY_KEY);
  if (!shown) return fetched;
  if (isBusy(queues.get(queryClient))) return shown;
  return fetched.revision < shown.revision ? shown : fetched;
}

/**
 * The order to base a whole-order change on: the shown one while a save is
 * queued (it carries the queued moves), else a fresh read from the server.
 */
export async function aeReadOrder(queryClient: QueryClient): Promise<AeSidebarOrder> {
  if (isBusy(queues.get(queryClient))) return shownOrder(queryClient);
  const current = mergeFetched(queryClient, await fetchAeSidebarOrder());
  queryClient.setQueryData(AE_SIDEBAR_QUERY_KEY, current);
  return current;
}

/** Resolves once the queue drains: true when everything saved, false when undone. */
export function aeOrderSettled(queryClient: QueryClient): Promise<boolean> {
  const queue = queues.get(queryClient);
  if (!isBusy(queue)) return Promise.resolve(true);
  return new Promise((resolve) => {
    queue?.waiters.push(resolve);
  });
}

/** The saved order, read only while `enabled` (Manual ordering on). */
export function useAeSidebarOrder(enabled: boolean) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: AE_SIDEBAR_QUERY_KEY,
    queryFn: async () => mergeFetched(queryClient, await fetchAeSidebarOrder()),
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? REFRESH_MS : false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    retry: false,
  });
}

/** The queued, optimistic save, bound to this tree's query client. */
export function useAeOrderMover(): (op: AeOrderOp) => boolean {
  const queryClient = useQueryClient();
  return useCallback((op: AeOrderOp) => aeEnqueueOrder(queryClient, op), [queryClient]);
}

/**
 * Load the list's further pages while `enabled`, up to the rows the background
 * refresh keeps current (`maxRefreshSessions`): a row past that window would
 * keep a stale status, which Triage groups by and Manual ranks among.
 */
export function useAeLoadAllPages(query: SidebarListQuery, enabled: boolean): void {
  const { maxRefreshSessions } = useContext(SidebarConfigContext);
  const loaded = query.data?.pages.reduce((count, page) => count + page.data.length, 0) ?? 0;
  const { hasNextPage, isFetchingNextPage, isError } = query;
  const fetchNextPage = useRef(query.fetchNextPage);
  fetchNextPage.current = query.fetchNextPage;
  useEffect(() => {
    if (!enabled || !hasNextPage || isFetchingNextPage || isError) return;
    if (loaded >= maxRefreshSessions) return;
    void fetchNextPage.current();
  }, [enabled, hasNextPage, isFetchingNextPage, isError, loaded, maxRefreshSessions]);
}
