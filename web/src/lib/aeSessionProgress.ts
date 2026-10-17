// A terminal agent's live spinner line ("✻ Crunching… (4m 42s · ↓ 24.5k
// tokens)"), relayed as `session.progress`, plus the rule for which stream
// events count as real activity for "last activity".

import type { StreamEvent } from "@/lib/events";

/** A spinner line as the server relays it. */
export interface AeProgressLine {
  /** The spinner verb, e.g. "Crunching". */
  label: string;
  /** Elapsed text as the terminal drew it, e.g. "4m 42s". */
  elapsed: string;
  /** The same elapsed time in seconds, when sent, so the row can tick it. */
  elapsedS: number | null;
  /** Token text, e.g. "24.5k tokens", when the line shows one. */
  tokens: string | null;
}

/** A relayed line plus when it arrived (epoch ms). */
export interface AeSessionProgress extends AeProgressLine {
  receivedAt: number;
}

/**
 * `session.progress`: transient, never persisted. `progress` is `null` when
 * the spinner went away.
 */
export interface AeSessionProgressEvent {
  type: "session_progress";
  conversationId: string;
  progress: AeProgressLine | null;
}

/** After this long with no content event, a working row hints at a silent step. */
export const AE_NO_OUTPUT_HINT_AFTER_MS = 60_000;
export const AE_NO_OUTPUT_HINT = "no output yet; a long step may be writing";
/**
 * The forwarder refreshes a steady line every 10 s; one not refreshed for this
 * long belongs to a stalled forwarder or a dropped host and is not shown.
 */
export const AE_PROGRESS_STALE_MS = 30_000;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Parse a `session.progress` SSE payload, or `null` when it is malformed. */
export function aeParseSessionProgress(
  data: Record<string, unknown>,
): AeSessionProgressEvent | null {
  const conversationId = text(data.conversation_id);
  if (conversationId === null) return null;
  if (data.label === null || data.label === undefined) {
    return { type: "session_progress", conversationId, progress: null };
  }
  const label = text(data.label);
  const elapsed = text(data.elapsed);
  if (label === null || elapsed === null) return null;
  return {
    type: "session_progress",
    conversationId,
    progress: { label, elapsed, elapsedS: seconds(data.elapsed_s), tokens: text(data.tokens) },
  };
}

/** Seconds the way Claude Code's spinner draws them: "12s", "4m 42s", "1h 3m". */
export function aeTuiElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The line while it is still being refreshed, else `null`. */
export function aeLiveProgress(
  progress: AeSessionProgress | null,
  now: number,
): AeSessionProgress | null {
  if (progress === null || now - progress.receivedAt > AE_PROGRESS_STALE_MS) return null;
  return progress;
}

/**
 * One line for the Working row: "Crunching · 4m 42s · 24.5k tokens", with the
 * elapsed time ticked forward from when the line arrived.
 */
export function aeProgressText(progress: AeSessionProgress, now: number): string {
  const elapsed =
    progress.elapsedS === null
      ? progress.elapsed
      : aeTuiElapsed(progress.elapsedS + Math.max(0, now - progress.receivedAt) / 1000);
  return [progress.label, elapsed, progress.tokens].filter(Boolean).join(" · ");
}

// Assistant text, reasoning, items and tool output. Status, usage, cost, model,
// presence and progress events are bookkeeping and never count as activity.
const CONTENT_EVENT_TYPES: ReadonlySet<StreamEvent["type"]> = new Set<StreamEvent["type"]>([
  "text_delta",
  "reasoning_started",
  "reasoning_delta",
  "reasoning_summary_delta",
  "reasoning_done",
  "message_done",
  "tool_call",
  "tool_result",
  "tool_output_delta",
  "native_tool_call",
  "slash_command",
  "terminal_command",
  "output_file_done",
  "elicitation_request",
  "compaction_completed",
  "session_input_consumed",
]);

// A new item or tool row supersedes the spinner it was drawing.
const CLEARS_PROGRESS_TYPES: ReadonlySet<StreamEvent["type"]> = new Set<StreamEvent["type"]>([
  "message_done",
  "reasoning_done",
  "tool_call",
  "tool_result",
  "native_tool_call",
  "session_input_consumed",
  "session_superseded",
]);

/** Whether an event is real output, the only kind "last activity" counts. */
export function aeIsContentEvent(event: StreamEvent): boolean {
  return CONTENT_EVENT_TYPES.has(event.type);
}

/**
 * The progress a conversation should hold after `event`: the relayed line, or
 * `null` once an item lands or the session stops running. `undefined` leaves
 * it as is.
 */
export function aeNextProgress(
  event: StreamEvent,
  conversationId: string,
): AeProgressLine | null | undefined {
  if (event.type === "session_progress") {
    return event.conversationId === conversationId ? event.progress : undefined;
  }
  if (event.type === "session_status") {
    if (event.conversationId !== conversationId) return undefined;
    return event.status === "running" ? undefined : null;
  }
  return CLEARS_PROGRESS_TYPES.has(event.type) ? null : undefined;
}

/** Whether the Working row should hint at a silent step: no content for a minute. */
export function aeShowsNoOutputHint(lastContentAt: number | null, now: number): boolean {
  return lastContentAt !== null && now - lastContentAt >= AE_NO_OUTPUT_HINT_AFTER_MS;
}
