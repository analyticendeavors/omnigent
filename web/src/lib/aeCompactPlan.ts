// Queued compact (omnigent-ae), the page's side. The plan lives on the server, which saves the
// chat's notes at the end of a real turn and then compacts, so it survives leaving the chat, a
// reload, closing the tab and a deploy. This file only asks the server to queue or cancel, and
// polls the plan's phase while one exists. The driver is
// packages/ae_omni_policies/src/ae_omni_policies/compact_queue.py.

import { useCallback, useSyncExternalStore } from "react";
import { showToast } from "@/components/ui/toast";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";

export type AeCompactPhase = "queued" | "preparing" | "compacting";

/** How often the page asks the server for the phase while a plan exists. */
export const AE_COMPACT_POLL_MS = 1500;

interface Entry {
  phase: AeCompactPhase | null;
  /** The server still holds a failure for this chat, so the poll goes on until /seen lands. */
  failureOpen: boolean;
  refs: number;
  timer: ReturnType<typeof setInterval> | null;
  toasted: Set<string>;
  /** Bumped by the page's own POST and DELETE, so a GET started before them cannot undo them. */
  rev: number;
  listeners: Set<() => void>;
}

interface Failure {
  id: string;
  message: string;
}

const entries = new Map<string, Entry>();

const TOASTED_KEY = "ae.compact.toasted";
const TOASTED_KEEP = 20;

/** Failure ids already toasted in this browser, so a reload does not toast one twice. */
function readToasted(): string[] {
  try {
    const raw = window.localStorage.getItem(TOASTED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function rememberToasted(id: string): void {
  try {
    const ids = [...readToasted().filter((v) => v !== id), id].slice(-TOASTED_KEEP);
    window.localStorage.setItem(TOASTED_KEY, JSON.stringify(ids));
  } catch {
    // The page works without it; the in-memory set still stops a repeat within this load.
  }
}

const url = (id: string, tail = "") => `/v1/ae/sessions/${encodeURIComponent(id)}/compact${tail}`;

function entryFor(id: string): Entry {
  let entry = entries.get(id);
  if (!entry) {
    entry = {
      phase: null,
      failureOpen: false,
      refs: 0,
      timer: null,
      toasted: new Set(),
      rev: 0,
      listeners: new Set(),
    };
    entries.set(id, entry);
  }
  return entry;
}

function setPhase(id: string, phase: AeCompactPhase | null): void {
  const entry = entryFor(id);
  if (entry.phase === phase) return;
  entry.phase = phase;
  for (const listener of entry.listeners) listener();
  syncTimer(id);
}

function syncTimer(id: string): void {
  const entry = entryFor(id);
  const wanted = (entry.phase !== null || entry.failureOpen) && entry.refs > 0;
  if (wanted && entry.timer === null) {
    entry.timer = setInterval(() => void refresh(id), AE_COMPACT_POLL_MS);
  } else if (!wanted && entry.timer !== null) {
    clearInterval(entry.timer);
    entry.timer = null;
  }
}

async function refresh(id: string): Promise<void> {
  const rev = entryFor(id).rev;
  let res: Response;
  try {
    res = await authenticatedFetch(url(id));
  } catch {
    return; // keep the last phase and keep polling
  }
  if (res.status === 403 || res.status === 404) {
    if (entryFor(id).rev === rev) setPhase(id, null);
    return;
  }
  if (!res.ok) return;
  let body: { phase?: AeCompactPhase | null; failure?: Failure | null };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return;
  }
  if (entryFor(id).rev !== rev) return;
  const failure = body.failure ?? null;
  entryFor(id).failureOpen = failure !== null;
  setPhase(id, body.phase ?? null);
  syncTimer(id);
  if (!failure) return;
  const entry = entryFor(id);
  if (!entry.toasted.has(failure.id) && !readToasted().includes(failure.id)) {
    showToast(failure.message);
  }
  entry.toasted.add(failure.id);
  rememberToasted(failure.id);
  // Until /seen lands the server keeps the failure, so every poll tries again.
  authenticatedFetch(url(id, "/seen"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ failure_id: failure.id }),
  }).catch(() => undefined);
}

/** The phase a 409 names in its error body, if any. */
async function phaseOfConflict(res: Response): Promise<AeCompactPhase | null> {
  try {
    const body = (await res.clone().json()) as { error?: { phase?: AeCompactPhase } };
    return body.error?.phase ?? null;
  } catch {
    return null;
  }
}

/** Queue a compact for the chat on the server. Rejects with the server's reason. */
export async function startAeCompactPlan(
  conversationId: string,
  options?: { snooze?: boolean },
): Promise<void> {
  const res = await authenticatedFetch(url(conversationId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ snooze: Boolean(options?.snooze) }),
  });
  entryFor(conversationId).rev += 1;
  if (res.ok) {
    setPhase(conversationId, "queued");
    return;
  }
  if (res.status === 409) {
    const phase = await phaseOfConflict(res);
    if (phase) {
      setPhase(conversationId, phase);
      return;
    }
  }
  throw await apiErrorFromResponse(res);
}

/** Cancel the chat's queued compact. Once the compact is going out it cannot be cancelled. */
export async function cancelAeCompactPlan(conversationId: string): Promise<void> {
  const res = await authenticatedFetch(url(conversationId), { method: "DELETE" });
  entryFor(conversationId).rev += 1;
  if (res.ok) {
    setPhase(conversationId, null);
    return;
  }
  if (res.status === 409) {
    setPhase(conversationId, "compacting");
    return;
  }
  throw await apiErrorFromResponse(res);
}

/** The chat's compact phase, or null when none is queued. */
export function useAeCompactPlan(conversationId: string | null): AeCompactPhase | null {
  // A stable subscribe: React resubscribes whenever it changes, and each subscribe may fetch.
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!conversationId) return () => undefined;
      const entry = entryFor(conversationId);
      entry.listeners.add(listener);
      entry.refs += 1;
      if (entry.refs === 1) void refresh(conversationId);
      syncTimer(conversationId);
      return () => {
        entry.listeners.delete(listener);
        entry.refs -= 1;
        syncTimer(conversationId);
      };
    },
    [conversationId],
  );
  return useSyncExternalStore(subscribe, () =>
    conversationId ? (entries.get(conversationId)?.phase ?? null) : null,
  );
}

/** Forget every plan and stop every poll (tests). */
export function resetAeCompactPlans(): void {
  for (const entry of entries.values()) {
    if (entry.timer !== null) clearInterval(entry.timer);
  }
  entries.clear();
}
