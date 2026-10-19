// Claude Code's context snapshot (`GET /v1/sessions/{id}/context-usage`), shared
// by the usage popover and the session rail. Each read launches a throwaway
// Claude process on the runner, so one request per session and identity is in
// flight at a time and a result is reused for three minutes.
//
// A `pending` answer is retried quietly for about two minutes, then its reason
// shows; every other answer shows at once. A turn end or a refresh reads anew.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { authenticatedFetch } from "@/lib/identity";
import { isTempConvId } from "@/lib/tempConversationId";
import { useChatStore } from "@/store/chatStore";

export interface ContextCategory {
  name: string;
  tokens: number;
  kind: "used" | "free" | "buffer" | "deferred";
}
export interface ContextUsage {
  available: boolean;
  reason?: string;
  /** Claude has not started yet; ask again shortly. */
  pending?: boolean;
  /** The runner or its host did not answer: a lost connection. */
  offline?: boolean;
  /** Retrying can never succeed in this session (another harness, no /proc). */
  final?: boolean;
  categories: ContextCategory[];
  totalTokens: number;
  maxTokens: number;
  autoCompactThreshold: number | null;
  isAutoCompactEnabled: boolean;
  observedAt: string;
  complete: boolean;
  details: Record<string, { name: string; tokens: number }[]>;
  /** MCP servers the snapshot's Claude process saw, name and status only. */
  mcpServers?: McpServerStatus[];
}

export interface McpServerStatus {
  name: string;
  /** "connected", "failed", "needs-auth", "pending", "disabled" or "unknown". */
  status: string;
}

/** The key a snapshot is shared under: harness and model, so a switch loads a new one. */
export function aeContextIdentity(
  harness: string | null | undefined,
  model: string | null | undefined,
): string {
  return `${harness ?? ""}:${model ?? ""}`;
}

/** A snapshot this recent is reused instead of asking the runner again. */
export const AE_CONTEXT_SNAPSHOT_TTL_MS = 3 * 60_000;
/** Past this age (client clock) the popover falls back to the live cache bar. */
export const AE_CONTEXT_SNAPSHOT_FRESH_MS = 4 * 60_000;
/** Unwatched snapshots kept beyond this many are dropped, oldest first. */
const MAX_KEPT = 20;
/** Waits between quiet retries of a not-ready answer; the last one repeats. */
export const AE_CONTEXT_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];
/** Not-ready answers for this long stop retrying and show their reason. */
export const AE_CONTEXT_RETRY_WINDOW_MS = 2 * 60_000;

export interface AeContextSnapshotState {
  data?: ContextUsage;
  error?: string;
  loading: boolean;
  /** Claude is starting: the store is retrying quietly, so show loading, not an error. */
  pending?: boolean;
  /** Client time the shown snapshot arrived. */
  receivedAt?: number;
  /** An available snapshot arrived within `AE_CONTEXT_SNAPSHOT_FRESH_MS`. */
  fresh: boolean;
  /** Ask for a new snapshot now (the rail's refresh button). */
  refresh: () => void;
}

interface SnapshotValue {
  data?: ContextUsage;
  error?: string;
  receivedAt?: number;
  inFlight: boolean;
  /** A not-ready answer came back and a quiet retry is scheduled. */
  pending?: boolean;
}

interface Entry {
  sessionId: string;
  value: SnapshotValue;
  /** When the last request finished, success or not. */
  settledAt?: number;
  watchers: number;
  timer?: ReturnType<typeof setTimeout>;
  listeners: Set<() => void>;
  /** When the current run of not-ready answers began. */
  retryStartedAt?: number;
  retryAttempt: number;
  /** The wait before the scheduled quiet retry. */
  retryDelay?: number;
  /** The quiet window ran out; only a turn end, a status change or a refresh opens another. */
  retryExhausted?: boolean;
  /** A runner-cache-skipping read was asked for while another request was in flight. */
  wantFresh?: boolean;
  /** The session status last handled for this entry, so every subscriber acts on an edge once. */
  lastStatus?: string | null;
}

const entries = new Map<string, Entry>();
const EMPTY: SnapshotValue = { inFlight: false };

function entryKey(sessionId: string, identity: string): string {
  return JSON.stringify([sessionId, identity]);
}

function entryFor(sessionId: string, identity: string): Entry {
  const key = entryKey(sessionId, identity);
  let entry = entries.get(key);
  if (!entry) {
    entry = { sessionId, value: EMPTY, watchers: 0, listeners: new Set(), retryAttempt: 0 };
    entries.set(key, entry);
    prune(key);
  }
  return entry;
}

/** Drops idle entries past the cap, never `keep` (the entry being created). */
function prune(keep: string): void {
  if (entries.size <= MAX_KEPT) return;
  for (const [key, entry] of entries) {
    if (entries.size <= MAX_KEPT) return;
    if (
      key !== keep &&
      entry.watchers === 0 &&
      entry.listeners.size === 0 &&
      !entry.value.inFlight
    ) {
      entries.delete(key);
    }
  }
}

function update(entry: Entry, value: Partial<SnapshotValue>): void {
  entry.value = { ...entry.value, ...value };
  for (const listener of entry.listeners) listener();
}

/** A real snapshot or a final answer is settled; any other unavailable one is asked again. */
function isFresh(entry: Entry, now: number): boolean {
  const data = entry.value.data;
  return (
    (data?.available === true || data?.final === true) &&
    now - (entry.value.receivedAt ?? 0) < AE_CONTEXT_SNAPSHOT_TTL_MS
  );
}

function resetRetry(entry: Entry): void {
  entry.retryStartedAt = undefined;
  entry.retryAttempt = 0;
  entry.retryDelay = undefined;
}

function schedule(entry: Entry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  if (entry.watchers === 0 || entry.settledAt === undefined) return;
  const after =
    entry.value.pending && entry.retryDelay !== undefined
      ? entry.retryDelay
      : AE_CONTEXT_SNAPSHOT_TTL_MS;
  const wait = Math.max(0, entry.settledAt + after - Date.now());
  entry.timer = setTimeout(() => load(entry), wait);
}

/** Store an answer; a pending one schedules a quiet retry until the window ends. */
function settle(entry: Entry, data: ContextUsage): void {
  const now = Date.now();
  if (!data.pending) {
    resetRetry(entry);
    update(entry, { data, error: undefined, receivedAt: now, inFlight: false, pending: false });
    return;
  }
  entry.retryStartedAt ??= now;
  const delays = AE_CONTEXT_RETRY_DELAYS_MS;
  const delay = delays[Math.min(entry.retryAttempt, delays.length - 1)];
  const retry =
    entry.watchers > 0 &&
    !entry.retryExhausted &&
    now + delay - entry.retryStartedAt <= AE_CONTEXT_RETRY_WINDOW_MS;
  if (retry) {
    entry.retryAttempt += 1;
    entry.retryDelay = delay;
  } else {
    if (entry.watchers > 0) entry.retryExhausted = true;
    resetRetry(entry);
  }
  // A real snapshot already shown stays until a newer real one replaces it.
  const shown = entry.value.data?.available ? {} : { data, receivedAt: now };
  update(entry, { ...shown, error: undefined, inFlight: false, pending: retry });
}

async function readSnapshot(sessionId: string, fresh: boolean): Promise<ContextUsage> {
  const response = await authenticatedFetch(
    `/v1/sessions/${encodeURIComponent(sessionId)}/context-usage${fresh ? "?fresh=true" : ""}`,
  );
  if (!response.ok) {
    throw new Error(
      `Could not load the context snapshot (HTTP ${response.status}). Try again; if it keeps failing, check that the session's runner is online.`,
    );
  }
  return (await response.json()) as ContextUsage;
}

/** `fresh` skips the runner's own three-minute cache. */
function load(entry: Entry, fresh = false): void {
  if (entry.value.inFlight) {
    if (fresh) entry.wantFresh = true;
    return;
  }
  entry.wantFresh = false;
  update(entry, { inFlight: true });
  readSnapshot(entry.sessionId, fresh)
    .then(
      (data) => settle(entry, data),
      (error: unknown) => {
        resetRetry(entry);
        update(entry, {
          error:
            error instanceof Error && error.message
              ? error.message
              : "Could not load the context snapshot. Try again.",
          inFlight: false,
          pending: false,
        });
      },
    )
    .finally(() => {
      entry.settledAt = Date.now();
      schedule(entry);
      if (entry.wantFresh) load(entry, true);
    });
}

/** Start watching: fetch unless a recent snapshot or a request already exists. */
function watch(entry: Entry): () => void {
  entry.watchers += 1;
  if (entry.watchers === 1) {
    if (!isFresh(entry, Date.now())) load(entry);
    else schedule(entry);
  }
  return () => {
    entry.watchers -= 1;
    if (entry.watchers === 0) {
      schedule(entry);
      resetRetry(entry);
      if (entry.value.pending) update(entry, { pending: false });
      entry.lastStatus = undefined;
    }
  };
}

/** Read anew past the runner's cache, with a new retry window: refresh and turn end. */
function reload(entry: Entry): void {
  resetRetry(entry);
  entry.retryExhausted = false;
  load(entry, true);
}

/** Drops every cached snapshot and timer; tests call it between cases. */
export function resetAeContextSnapshots(): void {
  for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer);
  entries.clear();
}

const noop = () => () => {};

/** One context snapshot per session and identity, shared by the popover and the rail. */
export function useAeContextSnapshot(
  sessionId: string | null,
  opts: { enabled: boolean; identity: string },
): AeContextSnapshotState {
  const id = sessionId && !isTempConvId(sessionId) ? sessionId : null;
  const { enabled, identity } = opts;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!id) return noop();
      const entry = entryFor(id, identity);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [id, identity],
  );
  const value = useSyncExternalStore(
    subscribe,
    () => (id ? (entries.get(entryKey(id, identity))?.value ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
  useEffect(() => {
    if (!enabled || !id) return undefined;
    return watch(entryFor(id, identity));
  }, [enabled, id, identity]);
  // A status change may end a spent quiet window; a turn ending also reads anew.
  const status = useChatStore((s) =>
    id !== null && s.conversationId === id ? s.sessionStatus : null,
  );
  useEffect(() => {
    if (!enabled || !id) return;
    const entry = entryFor(id, identity);
    const before = entry.lastStatus;
    if (before === status) return;
    entry.lastStatus = status;
    if (before === undefined) return;
    entry.retryExhausted = false;
    const wasActive = before === "running" || before === "waiting";
    if (wasActive && (status === "idle" || status === "failed")) reload(entry);
  }, [enabled, id, identity, status]);
  const refresh = useCallback(() => {
    if (id) reload(entryFor(id, identity));
  }, [id, identity]);
  const pending = value.pending === true;
  return {
    data: value.data,
    error: value.error,
    receivedAt: value.receivedAt,
    pending,
    loading: value.inFlight || pending || (enabled && id !== null && !value.data && !value.error),
    fresh:
      value.data?.available === true &&
      Date.now() - (value.receivedAt ?? 0) < AE_CONTEXT_SNAPSHOT_FRESH_MS,
    refresh,
  };
}

export const categoryColors = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
  "bg-sky-500",
  "bg-violet-500",
  "bg-teal-500",
];
export function categoryColor(name: string) {
  const names = [
    "System prompt",
    "System tools",
    "MCP server instructions",
    "MCP tools",
    "Custom agents",
    "Memory files",
    "Skills",
    "Messages",
  ];
  return categoryColors[Math.max(0, names.indexOf(name)) % categoryColors.length];
}

export function contextCountdown(data: ContextUsage, used: number): string | null {
  if (!data.isAutoCompactEnabled) return "Auto-compact is off";
  if (data.autoCompactThreshold == null) return null;
  const left = data.autoCompactThreshold - used;
  return left <= 0 ? "Auto-compact is due" : `About ${Math.round(left / 1000)}k until auto-compact`;
}
