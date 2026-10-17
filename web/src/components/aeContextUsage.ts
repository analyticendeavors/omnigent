// Claude Code's context snapshot (`GET /v1/sessions/{id}/context-usage`), shared
// by the usage popover and the session rail. Each read launches a throwaway
// Claude process on the runner, so one request per session and identity is in
// flight at a time and a result is reused for three minutes.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { authenticatedFetch } from "@/lib/identity";
import { isTempConvId } from "@/lib/tempConversationId";

export interface ContextCategory {
  name: string;
  tokens: number;
  kind: "used" | "free" | "buffer" | "deferred";
}
export interface ContextUsage {
  available: boolean;
  reason?: string;
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

export interface AeContextSnapshotState {
  data?: ContextUsage;
  error?: string;
  loading: boolean;
  /** Client time the shown snapshot arrived. */
  receivedAt?: number;
  /** The snapshot arrived within `AE_CONTEXT_SNAPSHOT_FRESH_MS`. */
  fresh: boolean;
  /** Ask for a new snapshot now (the rail's refresh button). */
  refresh: () => void;
}

interface SnapshotValue {
  data?: ContextUsage;
  error?: string;
  receivedAt?: number;
  inFlight: boolean;
}

interface Entry {
  sessionId: string;
  value: SnapshotValue;
  /** When the last request finished, success or not. */
  settledAt?: number;
  watchers: number;
  timer?: ReturnType<typeof setTimeout>;
  listeners: Set<() => void>;
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
    entry = { sessionId, value: EMPTY, watchers: 0, listeners: new Set() };
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

function isFresh(entry: Entry, now: number): boolean {
  return (
    entry.value.data !== undefined &&
    now - (entry.value.receivedAt ?? 0) < AE_CONTEXT_SNAPSHOT_TTL_MS
  );
}

function schedule(entry: Entry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  if (entry.watchers === 0 || entry.settledAt === undefined) return;
  const wait = Math.max(0, entry.settledAt + AE_CONTEXT_SNAPSHOT_TTL_MS - Date.now());
  entry.timer = setTimeout(() => load(entry), wait);
}

async function readSnapshot(sessionId: string): Promise<ContextUsage> {
  const response = await authenticatedFetch(
    `/v1/sessions/${encodeURIComponent(sessionId)}/context-usage`,
  );
  if (!response.ok) {
    throw new Error(
      `Could not load the context snapshot (HTTP ${response.status}). Try again; if it keeps failing, check that the session's runner is online.`,
    );
  }
  return (await response.json()) as ContextUsage;
}

function load(entry: Entry): void {
  if (entry.value.inFlight) return;
  update(entry, { inFlight: true });
  readSnapshot(entry.sessionId)
    .then(
      (data) => update(entry, { data, error: undefined, receivedAt: Date.now(), inFlight: false }),
      (error: unknown) =>
        update(entry, {
          error:
            error instanceof Error && error.message
              ? error.message
              : "Could not load the context snapshot. Try again.",
          inFlight: false,
        }),
    )
    .finally(() => {
      entry.settledAt = Date.now();
      schedule(entry);
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
    if (entry.watchers === 0) schedule(entry);
  };
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
  const refresh = useCallback(() => {
    if (id) load(entryFor(id, identity));
  }, [id, identity]);
  return {
    data: value.data,
    error: value.error,
    receivedAt: value.receivedAt,
    loading: value.inFlight || (enabled && id !== null && !value.data && !value.error),
    fresh:
      value.data !== undefined &&
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
