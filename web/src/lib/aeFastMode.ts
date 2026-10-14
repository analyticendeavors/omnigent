// Fast mode for claude-native sessions (omnigent-ae, 2026-10-14). Reid asked
// for Claude Desktop's fast mode switch in the composer's model menu, per
// session. `GET /v1/sessions/{id}/fast-mode` reads it from the session's
// Claude Code status line (null until the session reports it) and `PUT` types
// `/fast on` or `/fast off` into the terminal, answering only once Claude Code
// shows the new state (omnigent/runner/ae_fast_mode.py).
//
// The state lives in this small store, keyed by session, rather than in the
// menu: the menu unmounts when it closes, and a change still running must keep
// the switch pending (and its failure reason) when the menu opens again.

import { useSyncExternalStore } from "react";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";

export interface AeFastModeState {
  /** What Claude Code last confirmed; null until the session reports it. */
  enabled: boolean | null;
  /** The state a running change asks for; null when no change is running. */
  pending: boolean | null;
  /** Why the last change failed, shown in the menu until the next change. */
  error: string | null;
  /** A read or a change has answered, so a null `enabled` means unreported, not loading. */
  settled: boolean;
}

const UNKNOWN: AeFastModeState = Object.freeze({
  enabled: null,
  pending: null,
  error: null,
  settled: false,
});

/** Opus releases with fast mode, as `major.minor` (Claude Code docs, 2026-10-14). */
const FAST_MODE_OPUS_VERSIONS = new Set(["5.5", "5", "4.8"]);

const states = new Map<string, AeFastModeState>();
// Bumped by every change, so a read that started before it is dropped.
const generations = new Map<string, number>();
const listeners = new Set<() => void>();

export function aeFastModePath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/fast-mode`;
}

/**
 * The Opus version a model id or label names, e.g. "5.5" for
 * `claude-opus-5-5[1m]` or "Opus 5.5", "5" for `claude-opus-5-20261001`.
 */
export function opusVersion(value: string | null | undefined): string | null {
  const match = /opus[-\s](\d+)(?:[-.](\d{1,2}))?(?!\d)/.exec((value ?? "").toLowerCase());
  if (!match) return null;
  const [, major, minor] = match;
  return minor === undefined || minor === "0" ? major : `${major}.${minor}`;
}

/** Whether any of the model's spellings (id, alias, label) is an Opus with fast mode. */
export function aeFastModeModelSupported(...spellings: (string | null | undefined)[]): boolean {
  return spellings.some((spelling) => FAST_MODE_OPUS_VERSIONS.has(opusVersion(spelling) ?? ""));
}

function readState(sessionId: string | null): AeFastModeState {
  return (sessionId && states.get(sessionId)) || UNKNOWN;
}

function writeState(sessionId: string, patch: Partial<AeFastModeState>): void {
  states.set(sessionId, { ...readState(sessionId), ...patch });
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The session's fast mode as this tab last learned it. */
export function useAeFastMode(sessionId: string | null): AeFastModeState {
  return useSyncExternalStore(subscribe, () => readState(sessionId));
}

function enabledFrom(body: unknown): boolean | null {
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  return typeof enabled === "boolean" ? enabled : null;
}

/** Ask the server; null when the session has not reported fast mode yet. */
export async function fetchAeFastMode(sessionId: string): Promise<boolean | null> {
  const res = await authenticatedFetch(aeFastModePath(sessionId), { method: "GET" });
  if (!res.ok) throw await apiErrorFromResponse(res);
  return enabledFrom(await res.json());
}

/** Turn fast mode on or off; resolves with the state Claude Code confirmed. */
export async function putAeFastMode(sessionId: string, enabled: boolean): Promise<boolean> {
  const res = await authenticatedFetch(aeFastModePath(sessionId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw await apiErrorFromResponse(res);
  const confirmed = enabledFrom(await res.json());
  if (confirmed === null) throw new Error("The server answered without a fast mode state.");
  return confirmed;
}

/** Re-read the session's fast mode, unless a change is running. Unknown on failure. */
export async function refreshAeFastMode(sessionId: string): Promise<void> {
  if (readState(sessionId).pending !== null) return;
  const generation = generations.get(sessionId) ?? 0;
  let enabled: boolean | null;
  try {
    enabled = await fetchAeFastMode(sessionId);
  } catch {
    enabled = null;
  }
  if ((generations.get(sessionId) ?? 0) !== generation) return;
  writeState(sessionId, { enabled, settled: true });
}

/** Ask for a change: pending while it runs, the confirmed state after, reverted on failure. */
export async function changeAeFastMode(sessionId: string, enabled: boolean): Promise<void> {
  if (readState(sessionId).pending !== null) return;
  generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
  writeState(sessionId, { pending: enabled, error: null });
  try {
    const confirmed = await putAeFastMode(sessionId, enabled);
    writeState(sessionId, { enabled: confirmed, pending: null, settled: true });
  } catch (failure) {
    const reason = failure instanceof Error && failure.message ? failure.message : null;
    // `enabled` was never moved while pending, so clearing `pending` is the revert.
    writeState(sessionId, {
      pending: null,
      error: reason ?? `Could not turn fast mode ${enabled ? "on" : "off"}.`,
    });
  }
}

/** Forget every session's state; for tests. */
export function resetAeFastModeStore(): void {
  states.clear();
  generations.clear();
  for (const listener of listeners) listener();
}
