// The "Switch the child chats too?" question (omnigent-ae, 2026-10-28). Asked when a
// chat with child chats is moved to another Claude login. The pickers (composer
// menu, action dock) unmount when they close, so the question lives in this small
// store and one dialog mounted in the app shell shows it, as aeMoveAllChats does.

import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { aeFamilyChildren } from "@/lib/aeFamily";
import { aeReadFamilySessions } from "@/lib/aeFamilyRead";

export interface AeSwitchFamilyRequest {
  sessionId: string;
  /** The login's id; "" is the default login. */
  account: string;
  label: string;
  childCount: number;
}

let current: AeSwitchFamilyRequest | null = null;
const listeners = new Set<() => void>();

function emit(next: AeSwitchFamilyRequest | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function askAeSwitchFamily(request: AeSwitchFamilyRequest): void {
  emit(request);
}

export function dismissAeSwitchFamily(): void {
  emit(null);
}

export function useAeSwitchFamilyRequest(): AeSwitchFamilyRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/**
 * Switch a chat: asks about its children first when it has any, else calls `direct`
 * (the plain one-chat switch). A failed read of the session list also calls `direct`,
 * which is what a switch did before children were asked about.
 */
export function aeSwitchOrAsk(
  queryClient: QueryClient,
  target: Omit<AeSwitchFamilyRequest, "childCount">,
  direct: () => void,
): void {
  aeReadFamilySessions(queryClient).then(
    (rows) => {
      const childCount = aeFamilyChildren(rows, target.sessionId).length;
      if (childCount > 0) askAeSwitchFamily({ ...target, childCount });
      else direct();
    },
    () => direct(),
  );
}
