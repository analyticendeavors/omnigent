// The new chat's roles preset pick (omnigent-ae, 2026-10-24). The new-chat
// composer has no session yet, so its pill holds the choice here and the first
// send applies it right after the session is created (lib/aeDraftPresetApply.ts).
// Empty means the user's default preset. When the New Chat screen creates the
// session, the pick moves into a slot keyed by that session id (2026-10-24), so
// a later pill change or an early return can never land on another session.

import { useSyncExternalStore } from "react";
import type { NativeModelOption } from "@/lib/types";

let pick: string | null = null;
const listeners = new Set<() => void>();

export function aeGetDraftPick(): string | null {
  return pick;
}

/** Hold `id` (a preset id or "lead-picks") for the next new chat; null clears it. */
export function aeSetDraftPick(id: string | null) {
  if (pick === id) return;
  pick = id;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAeDraftPick(): string | null {
  return useSyncExternalStore(subscribe, aeGetDraftPick, aeGetDraftPick);
}

/** A bound pick older than this is dropped rather than applied to a later send. */
const BOUND_TTL_MS = 120_000;

export interface AeBoundPreset {
  pick: string;
  models: readonly NativeModelOption[];
}

let bound: { key: string; value: AeBoundPreset; at: number } | null = null;

/** Move the held pick, if any, to `sessionId` and clear the draft. */
export function aeBindDraftPreset(sessionId: string, models: readonly NativeModelOption[]) {
  if (!pick) return;
  bound = { key: sessionId, value: { pick, models }, at: Date.now() };
  aeSetDraftPick(null);
}

/** The pick bound to `sessionId`, once; null when none, for another session, or stale. */
export function aeTakeBoundPreset(sessionId: string | null): AeBoundPreset | null {
  const entry = bound;
  if (!entry || entry.key !== sessionId) return null;
  bound = null;
  return Date.now() - entry.at <= BOUND_TTL_MS ? entry.value : null;
}
