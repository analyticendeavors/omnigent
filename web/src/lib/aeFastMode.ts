// Fast mode for claude-native sessions (omnigent-ae, 2026-10-14). Reid asked
// for Claude Desktop's fast mode switch in the composer's model menu, per
// session. `GET /v1/sessions/{id}/fast-mode` reads it from the session's
// Claude Code status line (null until the session reports it), along with
// whether the host keeps fast mode per session, which turning it on needs.
// `PUT` types `/fast on` or `/fast off` into the terminal and answers 200 once
// Claude Code shows the new state, or 202 pending when the command is typed
// but not confirmed yet, e.g. queued behind a reply
// (omnigent/runner/ae_fast_mode.py). A pending change keeps the switch at the
// requested state and is re-read until it is confirmed or its time runs out.
//
// The state lives in this small store, keyed by session, rather than in the
// menu: the menu unmounts when it closes, and a change still pending must keep
// the switch pending (and a failure its reason) when the menu opens again.

import { useSyncExternalStore } from "react";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";

export interface AeFastModeState {
  /** What Claude Code last reported; null until the session reports it. */
  enabled: boolean | null;
  /** Whether the host keeps fast mode per session; null until a read answers. */
  perSession: boolean | null;
  /** The state a change asks for until Claude Code confirms it; null otherwise. */
  pending: boolean | null;
  /** Why a typed change is not confirmed yet; null while its request runs. */
  pendingReason: string | null;
  /** Why the last change failed, shown until the next change or a successful read. */
  error: string | null;
  /** A read or a change has answered, so a null `enabled` means unreported, not loading. */
  settled: boolean;
}

export interface AeFastModeRead {
  enabled: boolean | null;
  perSession: boolean | null;
}

export interface AeFastModeAnswer {
  /** The confirmed state, or the requested one while `pending`. */
  enabled: boolean;
  pending: boolean;
  /** Why it is pending, e.g. "Applies when the current reply finishes". */
  reason: string | null;
}

const UNKNOWN: AeFastModeState = Object.freeze({
  enabled: null,
  perSession: null,
  pending: null,
  pendingReason: null,
  error: null,
  settled: false,
});

/** Opus releases with fast mode, as `major.minor` (Claude Code docs, 2026-10-14). */
const FAST_MODE_OPUS_VERSIONS = new Set(["5.5", "5", "4.8"]);

const UNCONFIRMED_REASON = "Waiting for Claude Code to confirm";
/** How often an open menu re-reads a pending change. */
export const AE_FAST_MODE_RECHECK_MS = 2_000;
/** How long a pending change waits for Claude Code before the snapshot wins. */
export const AE_FAST_MODE_CONFIRM_WINDOW_MS = 60_000;

const states = new Map<string, AeFastModeState>();
// Bumped by every change, so a read that started before it is dropped.
const generations = new Map<string, number>();
// When each pending change stops waiting for confirmation.
const deadlines = new Map<string, number>();
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

/** Whether a change for the session is still running or waiting for confirmation. */
export function useAeFastModePending(sessionId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => readState(sessionId).pending !== null);
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Ask the server; `enabled` is null when the session has not reported fast mode yet. */
export async function fetchAeFastMode(sessionId: string): Promise<AeFastModeRead> {
  const res = await authenticatedFetch(aeFastModePath(sessionId), { method: "GET" });
  if (!res.ok) throw await apiErrorFromResponse(res);
  const body = (await res.json()) as { enabled?: unknown; per_session?: unknown } | null;
  return { enabled: boolOrNull(body?.enabled), perSession: boolOrNull(body?.per_session) };
}

/** Turn fast mode on or off; resolves with the confirmed state, or the requested one pending. */
export async function putAeFastMode(
  sessionId: string,
  enabled: boolean,
): Promise<AeFastModeAnswer> {
  const res = await authenticatedFetch(aeFastModePath(sessionId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw await apiErrorFromResponse(res);
  const body = (await res.json()) as {
    enabled?: unknown;
    pending?: unknown;
    reason?: unknown;
  } | null;
  if (body?.pending === true) {
    const reason = typeof body.reason === "string" && body.reason ? body.reason : null;
    return { enabled, pending: true, reason: reason ?? UNCONFIRMED_REASON };
  }
  const confirmed = boolOrNull(body?.enabled);
  if (confirmed === null) throw new Error("The server answered without a fast mode state.");
  return { enabled: confirmed, pending: false, reason: null };
}

/**
 * Re-read the session's fast mode, unless a change request is still running.
 * A read that matches a pending change confirms it; once the change's window
 * has passed, the read wins either way. A failed read is unknown.
 */
export async function refreshAeFastMode(sessionId: string): Promise<void> {
  const before = readState(sessionId);
  if (before.pending !== null && before.pendingReason === null) return;
  const generation = generations.get(sessionId) ?? 0;
  let read: AeFastModeRead | null;
  try {
    read = await fetchAeFastMode(sessionId);
  } catch {
    read = null;
  }
  if ((generations.get(sessionId) ?? 0) !== generation) return;
  const enabled = read?.enabled ?? null;
  const { pending } = readState(sessionId);
  const endsPending =
    pending !== null && (enabled === pending || Date.now() >= (deadlines.get(sessionId) ?? 0));
  if (endsPending) deadlines.delete(sessionId);
  writeState(sessionId, {
    enabled,
    settled: true,
    ...(read ? { perSession: read.perSession, error: null } : {}),
    ...(endsPending ? { pending: null, pendingReason: null } : {}),
  });
}

/** Ask for a change: pending until confirmed, the confirmed state after, reverted on failure. */
export async function changeAeFastMode(sessionId: string, enabled: boolean): Promise<void> {
  if (readState(sessionId).pending !== null) return;
  generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
  writeState(sessionId, { pending: enabled, pendingReason: null, error: null });
  try {
    const answer = await putAeFastMode(sessionId, enabled);
    if (answer.pending) {
      deadlines.set(sessionId, Date.now() + AE_FAST_MODE_CONFIRM_WINDOW_MS);
      writeState(sessionId, { pendingReason: answer.reason ?? UNCONFIRMED_REASON });
    } else {
      writeState(sessionId, { enabled: answer.enabled, pending: null, settled: true });
    }
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
  deadlines.clear();
  for (const listener of listeners) listener();
}
