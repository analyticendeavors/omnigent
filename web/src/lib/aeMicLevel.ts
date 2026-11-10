// The live mic level (0 to 1) for the Voice panel. One global value, not per chat:
// only one mic listens at a time. Publishes are throttled so React is not
// re-rendered at frame rate.

import { useSyncExternalStore } from "react";

/** Changes closer together than this are dropped. */
export const MIC_LEVEL_THROTTLE_MS = 50;

let level = 0;
let lastChangeAt = Number.NEGATIVE_INFINITY;
const listeners = new Set<() => void>();

function set(next: number): void {
  if (next === level) return;
  level = next;
  listeners.forEach((cb) => cb());
}

export function publishMicLevel(next: number): void {
  const clamped = Number.isFinite(next) ? Math.min(1, Math.max(0, next)) : 0;
  const now = Date.now();
  if (clamped === level || now - lastChangeAt < MIC_LEVEL_THROTTLE_MS) return;
  lastChangeAt = now;
  set(clamped);
}

/** The mic stopped: the bars go back to the baseline now, throttle or not. */
export function resetMicLevel(): void {
  lastChangeAt = Number.NEGATIVE_INFINITY;
  set(0);
}

export function getMicLevel(): number {
  return level;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useMicLevel(): number {
  return useSyncExternalStore(subscribe, getMicLevel, () => 0);
}
