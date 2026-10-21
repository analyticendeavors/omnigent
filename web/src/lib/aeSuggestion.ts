// The predicted next prompts (up to three, best first), relayed as
// `session.suggestion` after a finished turn (the forwarder's
// `ae_prompt_suggest` side call), and the rules for when the composer shows
// them as ghost text.

import { useState, useSyncExternalStore } from "react";
import type { StreamEvent } from "@/lib/events";

/** The ranked guesses a conversation holds, best first; never empty. */
export type AeSuggestions = readonly string[];

/** `session.suggestion`: transient, never persisted. `suggestions` is `null` to clear. */
export interface AeSessionSuggestionEvent {
  type: "session_suggestion";
  conversationId: string;
  suggestions: AeSuggestions | null;
}

const MAX_SUGGESTIONS = 3;

function oneLine(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

/** Parse a `session.suggestion` SSE payload, or `null` when it is malformed. */
export function aeParseSessionSuggestion(
  data: Record<string, unknown>,
): AeSessionSuggestionEvent | null {
  const conversationId = data.conversation_id;
  if (typeof conversationId !== "string" || !conversationId) return null;
  // `suggestions` is the ranked list; a server from before it sends `suggestion` alone.
  const raw = data.suggestions ?? (data.suggestion == null ? null : [data.suggestion]);
  if (raw === null) return { type: "session_suggestion", conversationId, suggestions: null };
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) return null;
  const suggestions = raw.map(oneLine).filter(Boolean).slice(0, MAX_SUGGESTIONS);
  return {
    type: "session_suggestion",
    conversationId,
    suggestions: suggestions.length ? suggestions : null,
  };
}

/** Whether two held lists show the same guesses (the store skips a no-op write). */
export function aeSameSuggestions(
  a: AeSuggestions | null | undefined,
  b: AeSuggestions | null | undefined,
): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null);
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

// A new turn or a rotated session makes the last guess stale.
const CLEARS_SUGGESTION_TYPES: ReadonlySet<StreamEvent["type"]> = new Set<StreamEvent["type"]>([
  "session_input_consumed",
  "session_superseded",
]);

/**
 * The suggestions a conversation should hold after `event`: the relayed ones,
 * or `null` once a turn starts. Suggestions that arrive while a turn runs
 * belong to the turn before it and are dropped. `undefined` leaves them as is.
 */
export function aeNextSuggestion(
  event: StreamEvent,
  conversationId: string,
  sessionStatus: string | undefined,
): AeSuggestions | null | undefined {
  if (event.type === "session_suggestion") {
    if (event.conversationId !== conversationId) return undefined;
    if (event.suggestions !== null && sessionStatus === "running") return undefined;
    return event.suggestions;
  }
  if (event.type === "session_status") {
    if (event.conversationId !== conversationId) return undefined;
    return event.status === "running" ? null : undefined;
  }
  return CLEARS_SUGGESTION_TYPES.has(event.type) ? null : undefined;
}

/**
 * What the composer may show: the suggestions only while no turn runs and the
 * box accepts input; the composer itself also hides them once anything is typed.
 */
export function aeComposerSuggestion(
  suggestions: AeSuggestions | null,
  { busy, blocked }: { busy: boolean; blocked: boolean },
): AeSuggestions | null {
  return busy || blocked ? null : suggestions;
}

/** The guesses to draw as ghost text over the textarea: only over an empty box. */
export function aeShownSuggestion(
  suggestions: AeSuggestions | null | undefined,
  value: unknown,
): AeSuggestions | null {
  if (!suggestions?.length) return null;
  return value === undefined || value === "" ? suggestions : null;
}

/**
 * The guess the ghost shows out of `list`, and a step to the next or previous
 * one (wrapping). New guesses start at the top; clearing typed text brings
 * back the same guesses at the same place.
 */
export function useAeSuggestionCycle(list: AeSuggestions | null): {
  text: string | null;
  index: number;
  count: number;
  cycle: (step: 1 | -1) => void;
} {
  const [pick, setPick] = useState<{ list: AeSuggestions | null; index: number }>({
    list: null,
    index: 0,
  });
  const count = list?.length ?? 0;
  const index = pick.list === list && pick.index < count ? pick.index : 0;
  const cycle = (step: 1 | -1) => {
    if (count > 1) setPick({ list, index: (index + step + count) % count });
  };
  return { text: list?.[index] ?? null, index, count, cycle };
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
