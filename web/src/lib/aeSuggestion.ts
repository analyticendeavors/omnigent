// A predicted next prompt, relayed as `session.suggestion` after a finished
// Claude turn (the forwarder's `ae_prompt_suggest` side call), and the rules
// for when the composer shows it as ghost text.

import { useSyncExternalStore } from "react";
import type { StreamEvent } from "@/lib/events";

/** `session.suggestion`: transient, never persisted. `suggestion` is `null` to clear. */
export interface AeSessionSuggestionEvent {
  type: "session_suggestion";
  conversationId: string;
  suggestion: string | null;
}

/** Parse a `session.suggestion` SSE payload, or `null` when it is malformed. */
export function aeParseSessionSuggestion(
  data: Record<string, unknown>,
): AeSessionSuggestionEvent | null {
  const conversationId = data.conversation_id;
  if (typeof conversationId !== "string" || !conversationId) return null;
  const raw = data.suggestion;
  if (raw === null || raw === undefined) {
    return { type: "session_suggestion", conversationId, suggestion: null };
  }
  if (typeof raw !== "string") return null;
  const suggestion = raw.replace(/\s+/g, " ").trim();
  return { type: "session_suggestion", conversationId, suggestion: suggestion || null };
}

// A new turn or a rotated session makes the last guess stale.
const CLEARS_SUGGESTION_TYPES: ReadonlySet<StreamEvent["type"]> = new Set<StreamEvent["type"]>([
  "session_input_consumed",
  "session_superseded",
]);

/**
 * The suggestion a conversation should hold after `event`: the relayed one,
 * or `null` once a turn starts. A suggestion that arrives while a turn runs
 * belongs to the turn before it and is dropped. `undefined` leaves it as is.
 */
export function aeNextSuggestion(
  event: StreamEvent,
  conversationId: string,
  sessionStatus: string | undefined,
): string | null | undefined {
  if (event.type === "session_suggestion") {
    if (event.conversationId !== conversationId) return undefined;
    if (event.suggestion !== null && sessionStatus === "running") return undefined;
    return event.suggestion;
  }
  if (event.type === "session_status") {
    if (event.conversationId !== conversationId) return undefined;
    return event.status === "running" ? null : undefined;
  }
  return CLEARS_SUGGESTION_TYPES.has(event.type) ? null : undefined;
}

/**
 * What the composer may show: the suggestion only while no turn runs and the
 * box accepts input; the composer itself also hides it once anything is typed.
 */
export function aeComposerSuggestion(
  suggestion: string | null,
  { busy, blocked }: { busy: boolean; blocked: boolean },
): string | null {
  return busy || blocked ? null : suggestion;
}

/** The ghost text to draw over the textarea: only over an empty box. */
export function aeShownSuggestion(
  suggestion: string | null | undefined,
  value: unknown,
): string | null {
  if (!suggestion) return null;
  return value === undefined || value === "" ? suggestion : null;
}

// Tailwind's `sm` line: below it there is no Tab key to offer.
const NARROW_QUERY = "(max-width: 639.98px)";

function subscribeNarrow(callback: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(NARROW_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function narrowSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

/** "Tab to use", or "Tap to use" below 640 px wide. */
export function useAeSuggestionHint(): string {
  const narrow = useSyncExternalStore(subscribeNarrow, narrowSnapshot, () => false);
  return narrow ? "Tap to use" : "Tab to use";
}

/** Plain Tab, the key that takes a shown suggestion. */
export function aeIsSuggestionAcceptKey(event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return (
    event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
  );
}
