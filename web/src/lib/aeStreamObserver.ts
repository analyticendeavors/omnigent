// The chat store's per-event hook for the AE activity line. Kept apart from
// `aeSessionProgress` so the SSE parser's import of that module stays acyclic.

import { aeStampLastEvent } from "@/lib/aeSessionActivity";
import { aeIsContentEvent, aeNextProgress, type AeSessionProgress } from "@/lib/aeSessionProgress";
import type { StreamEvent } from "@/lib/events";

export interface AeObservedState {
  aeProgress: AeSessionProgress | null;
  sessionStatus: string;
}

/**
 * Per stream event: stamp "last activity" for content events and for the
 * switch to running (a turn starting is activity, repeated running posts are
 * not), and keep the conversation's progress line current.
 */
export function aeObserveStreamEvent(
  event: StreamEvent,
  conversationId: string,
  write: (patch: { lastEventAt?: number; aeProgress?: AeSessionProgress | null }) => void,
  read: () => AeObservedState | null,
): void {
  const state = read();
  const startsRunning =
    event.type === "session_status" &&
    event.conversationId === conversationId &&
    event.status === "running" &&
    state?.sessionStatus !== "running";
  if (aeIsContentEvent(event) || startsRunning) aeStampLastEvent(conversationId, write);
  const next = aeNextProgress(event, conversationId);
  if (next === undefined) return;
  if (next === null) {
    if ((state?.aeProgress ?? null) !== null) write({ aeProgress: null });
    return;
  }
  write({ aeProgress: { ...next, receivedAt: Date.now() } });
}
