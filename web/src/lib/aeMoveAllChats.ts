// The "Move all open chats?" question that follows a change of the Claude login
// new chats use (omnigent-ae, 2026-10-27). The pickers (composer menu, Settings)
// unmount when they close, so the question lives in this small store and one
// dialog mounted in the app shell shows it.

import { useSyncExternalStore } from "react";

export interface AeMoveAllRequest {
  /** The login's id; "" is the default login. */
  account: string;
  label: string;
  hostId: string | undefined;
}

let current: AeMoveAllRequest | null = null;
const listeners = new Set<() => void>();

function emit(next: AeMoveAllRequest | null): void {
  current = next;
  for (const listener of listeners) listener();
}

/** Ask the user whether to move every open chat to the login just picked for new chats. */
export function askAeMoveAll(request: AeMoveAllRequest): void {
  emit(request);
}

export function dismissAeMoveAll(): void {
  emit(null);
}

export function useAeMoveAllRequest(): AeMoveAllRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
