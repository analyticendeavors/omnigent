// Refused playback. iOS and some browsers refuse audio that no tap started; the
// speaker reports it here and the Voice panel offers a tap that plays it.

import { useSyncExternalStore } from "react";

let blocked = false;
let resume: (() => void) | null = null;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (blocked === next) return;
  blocked = next;
  listeners.forEach((cb) => cb());
}

/** The browser refused the reply; `resume` plays it again and must run inside a tap. */
export function markPlaybackBlocked(onResume: () => void): void {
  resume = onResume;
  set(true);
}

export function clearPlaybackBlocked(): void {
  resume = null;
  set(false);
}

/** Runs the stored resume. Blocked stays true until the speaker clears it. */
export function resumePlayback(): void {
  try {
    resume?.();
  } catch {
    // A failed resume leaves the panel asking for another tap.
  }
}

export function isPlaybackBlocked(): boolean {
  return blocked;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function usePlaybackBlocked(): boolean {
  return useSyncExternalStore(subscribe, isPlaybackBlocked, () => false);
}
