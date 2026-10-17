// The chat store's per-event hook for the AE activity line. Kept apart from
// `aeSessionProgress` so the SSE parser's import of that module stays acyclic.

import { aeStampLastEvent } from "@/lib/aeSessionActivity";
import { aeIsContentEvent, aeNextProgress, type AeSessionProgress } from "@/lib/aeSessionProgress";
import type { StreamEvent } from "@/lib/events";

/**
 * Per stream event: stamp "last activity" for content events only, and keep
 * the conversation's progress line current.
 */
export function aeObserveStreamEvent(
  event: StreamEvent,
  conversationId: string,
  write: (patch: { lastEventAt?: number; aeProgress?: AeSessionProgress | null }) => void,
  read: () => AeSessionProgress | null,
): void {
  if (aeIsContentEvent(event)) aeStampLastEvent(conversationId, write);
  const next = aeNextProgress(event, conversationId);
  if (next === undefined) return;
  if (next === null && read() === null) return;
  write({ aeProgress: next });
}
