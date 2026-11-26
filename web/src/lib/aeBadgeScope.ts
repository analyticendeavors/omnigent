// What the app icon badge counts (omnigent-ae, 2026-11-26). The badge shows
// working sessions on every client, native shell and Home Screen web app alike.
// "top-level" (default) is the number the Session Dashboard pill shows; "all"
// adds working helper and child sessions. Device-local.

import { useSyncExternalStore } from "react";
import { aeStatusOf, countAeSlots, isAeSlot } from "@/lib/aeLabels";
import type { Conversation } from "@/hooks/useConversations";

const STORAGE_KEY = "omnigent:ae-badge-scope";

export type AeBadgeScope = "top-level" | "all";
export const AE_BADGE_SCOPES: readonly AeBadgeScope[] = ["top-level", "all"];
export const DEFAULT_AE_BADGE_SCOPE: AeBadgeScope = "top-level";

export function readAeBadgeScope(): AeBadgeScope {
  if (typeof window === "undefined") return DEFAULT_AE_BADGE_SCOPE;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return AE_BADGE_SCOPES.includes(stored as AeBadgeScope)
      ? (stored as AeBadgeScope)
      : DEFAULT_AE_BADGE_SCOPE;
  } catch {
    return DEFAULT_AE_BADGE_SCOPE;
  }
}

const listeners = new Set<() => void>();

export function writeAeBadgeScope(value: AeBadgeScope): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // A local view preference; losing it is harmless.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAeBadgeScope(): AeBadgeScope {
  return useSyncExternalStore(subscribe, readAeBadgeScope, () => DEFAULT_AE_BADGE_SCOPE);
}

type BadgeRow = Pick<
  Conversation,
  "id" | "labels" | "archived" | "parent_session_id" | "pending_elicitations_count" | "status"
>;

/**
 * The number on the app icon. "top-level": the slot count the Session Dashboard
 * pill shows (follows the helpers-count policy). "all": every working,
 * unarchived session once by id, child sessions included.
 */
export function aeBadgeCount(
  rows: Iterable<BadgeRow>,
  helpersCount: boolean,
  scope: AeBadgeScope,
): number {
  if (scope === "top-level") return countAeSlots(rows, helpersCount);
  const held = new Set<string>();
  for (const row of rows) {
    if (aeStatusOf(row.labels) === "working" && isAeSlot({ ...row, parent_session_id: null })) {
      held.add(row.id);
    }
  }
  return held.size;
}
