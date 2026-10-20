// What the sidebar's hover card says about a session it is not showing: its
// newest step, the question it waits on, when its turn began and its last
// reply, all read from one page of its newest items.

import { subagentStepNote } from "@/components/aeRail/aeRailSubagentSteps";
import type { MessageContentBlock } from "./blocks";
import { extractAssistantText, extractErrorText, previewText } from "./lastAssistantText";
import { fetchSessionItemsPage } from "./sessionsApi";
import { isClaudeAgentMessageContent, isClaudeTaskNotificationText } from "./systemMessage";

/** Newest items read per hover; a longer turn's start lies past them and goes untimed. */
const PEEK_ITEMS = 30;

/** Characters of the question or last reply the card shows. */
const PEEK_TEXT_CHARS = 140;

export interface AeSessionPeek {
  /** The turn's newest tool call's one-line note, e.g. "Run the rebase script". */
  step: string | null;
  /** That call has no result yet. */
  stepRunning: boolean;
  /** The question of an unanswered AskUserQuestion that is the newest call, else `null`. */
  question: string | null;
  /** Epoch ms of the user's own message that started the current turn. */
  turnStartedAt: number | null;
  /** The last assistant reply, condensed to one short line. */
  lastReply: string | null;
  /** The newest error headline, condensed to one short line. */
  lastError: string | null;
}

function record(item: unknown): Record<string, unknown> | null {
  return item && typeof item === "object" ? (item as Record<string, unknown>) : null;
}

/** The first question an AskUserQuestion call asks, or `null` for any other item. */
export function askedQuestion(item: unknown): string | null {
  const r = record(item);
  if (r?.type !== "function_call" || r.name !== "AskUserQuestion") return null;
  try {
    const args: unknown = typeof r.arguments === "string" ? JSON.parse(r.arguments) : r.arguments;
    const first = (record(args)?.questions as unknown[] | undefined)?.[0];
    const text = record(first)?.question;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

/** A message the user wrote, by the chat's own rule; agent and task notices are not. */
function isUserTurnStart(item: unknown): boolean {
  const r = record(item);
  if (r?.type !== "message" || r.role !== "user" || r.is_meta === true) return false;
  if (r.created_by || r.user_authored === true) return true;
  const content = Array.isArray(r.content) ? (r.content as MessageContentBlock[]) : [];
  if (isClaudeAgentMessageContent(content)) return false;
  return !content.some((b) => "text" in b && isClaudeTaskNotificationText(b.text));
}

/** One plain line: markdown emphasis, code ticks and heading or list marks dropped. */
function oneLine(text: string): string {
  const line = text
    .replace(/^\s*(?:#+|[-*]|\d+\.)\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > PEEK_TEXT_CHARS ? `${line.slice(0, PEEK_TEXT_CHARS - 1).trimEnd()}…` : line;
}

/** Read a session's peek from its items, oldest first. */
export function peekFromItems(items: readonly unknown[]): AeSessionPeek {
  const peek: AeSessionPeek = {
    step: null,
    stepRunning: false,
    question: null,
    turnStartedAt: null,
    lastReply: null,
    lastError: null,
  };
  const answered = new Set<unknown>();
  // Newest first: the first hit of each kind is the current one.
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    const r = record(item);
    if (r?.type === "function_call_output") answered.add(r.call_id);
    if (isUserTurnStart(item)) {
      if (typeof r?.created_at === "number") peek.turnStartedAt = r.created_at * 1000;
      // Anything older belongs to an earlier turn.
      break;
    }
    const note = peek.step === null ? subagentStepNote(item) : null;
    if (note !== null) {
      peek.step = note;
      peek.stepRunning = !answered.has(r?.call_id);
      if (peek.stepRunning) peek.question = askedQuestion(item);
    }
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const reply = peek.lastReply === null ? extractAssistantText(items[i]) : undefined;
    if (reply !== undefined) peek.lastReply = oneLine(previewText(reply, PEEK_TEXT_CHARS * 2));
    const error = peek.lastError === null ? extractErrorText(items[i]) : undefined;
    if (error !== undefined) peek.lastError = oneLine(error);
  }
  return peek;
}

/** One page of a session's newest items, read into a peek. */
export async function fetchAeSessionPeek(
  sessionId: string,
  signal?: AbortSignal,
): Promise<AeSessionPeek> {
  const { items } = await fetchSessionItemsPage(sessionId, { limit: PEEK_ITEMS, signal });
  return peekFromItems(items);
}
