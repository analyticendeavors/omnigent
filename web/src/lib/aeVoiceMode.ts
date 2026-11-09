// Voice mode: one switch for hands-free talking. A small per-chat store (on, phase,
// whether the speaker is talking, how to speak a line), the spoken option matcher
// for question cards, and the call that tells the server to add the spoken-style line.

import { useSyncExternalStore } from "react";
import {
  type AskUserQuestionPayload,
  castAskUserQuestionPayload,
  parseAskUserQuestionPreview,
} from "./askUserQuestion";
import { withBasePath } from "./basePath";
import type { AnyBlock, ElicitationBlock } from "./blocks";
import { authenticatedFetch } from "./identity";

/** Quiet time after a finished sentence before the draft is sent. */
export const GRACE_MS = 600;
/** Gap after the last spoken sentence before the mic comes back. */
export const RESUME_MS = 300;

export type VoicePhase = "off" | "listening" | "thinking" | "speaking";

/** What the composer mic exposes so Voice mode can start and stop it. */
export interface AeMicController {
  start: () => void;
  stop: () => void;
  isListening: () => boolean;
}

export interface VoiceSnapshot {
  on: boolean;
  phase: VoicePhase;
  /** The speaker is talking (published by the speaker button). */
  speaking: boolean;
  /** Speaks one line through the chat's voice (registered by the speaker button). */
  speak: ((text: string) => void) | null;
}

const KEY = "omnigent:ae-voice-mode:";

function getItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setItem(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // A storage failure must not break the composer.
  }
}

export function readVoiceMode(chatId: string): boolean {
  return getItem(KEY + chatId) === "true";
}

export function writeVoiceMode(chatId: string, on: boolean): void {
  setItem(KEY + chatId, on ? "true" : null);
}

const states = new Map<string, VoiceSnapshot>();
const listeners = new Set<() => void>();
const OFF: VoiceSnapshot = { on: false, phase: "off", speaking: false, speak: null };

export function getVoiceSnapshot(chatId: string | null): VoiceSnapshot {
  if (chatId === null) return OFF;
  let state = states.get(chatId);
  if (!state) {
    const on = readVoiceMode(chatId);
    state = { ...OFF, on, phase: on ? "listening" : "off" };
    states.set(chatId, state);
  }
  return state;
}

function patch(chatId: string, next: Partial<VoiceSnapshot>): void {
  const prev = getVoiceSnapshot(chatId);
  const merged = { ...prev, ...next };
  if ((Object.keys(merged) as (keyof VoiceSnapshot)[]).every((k) => merged[k] === prev[k])) return;
  states.set(chatId, merged);
  listeners.forEach((cb) => cb());
}

export function subscribeVoice(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useVoiceSnapshot(chatId: string | null): VoiceSnapshot {
  return useSyncExternalStore(
    subscribeVoice,
    () => getVoiceSnapshot(chatId),
    () => OFF,
  );
}

/** Forget every chat's state; for tests. */
export function resetVoiceStore(): void {
  states.clear();
  listeners.forEach((cb) => cb());
}

/** Tell the server, which adds the spoken-style line to each message while it is on. */
export async function postVoiceLabel(chatId: string, on: boolean): Promise<void> {
  try {
    await authenticatedFetch(withBasePath(`/v1/ae/sessions/${encodeURIComponent(chatId)}/voice`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on }),
    });
  } catch {
    // The switch still works without the style line.
  }
}

export function setVoiceOn(chatId: string, on: boolean): void {
  writeVoiceMode(chatId, on);
  patch(chatId, { on, phase: on ? "listening" : "off" });
  void postVoiceLabel(chatId, on);
}

export function setVoicePhase(chatId: string, phase: VoicePhase): void {
  patch(chatId, { phase });
}

export function setVoiceSpeaking(chatId: string, speaking: boolean): void {
  patch(chatId, { speaking });
}

export function registerVoiceSpeaker(chatId: string, speak: (text: string) => void): () => void {
  patch(chatId, { speak });
  return () => {
    if (getVoiceSnapshot(chatId).speak === speak) patch(chatId, { speak: null });
  };
}

// Spoken option matching

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};
const NUMBER_SPOKEN = [
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
];
const STOP_WORDS = new Set([
  "do",
  "just",
  "so",
  "ok",
  "okay",
  "yes",
  "yeah",
  "the",
  "a",
  "an",
  "it",
  "this",
  "that",
  "to",
  "of",
  "and",
  "i",
  "me",
  "my",
  "please",
  "option",
  "number",
  "choice",
  "pick",
  "choose",
  "select",
  "go",
  "with",
  "want",
  "ill",
  "take",
  "lets",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function hasPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((w, j) => haystack[i + j] === w)) return true;
  }
  return false;
}

function numberIn(tokens: string[], count: number): number | null {
  // "the second one" holds both an ordinal and a bare number word: the ordinal wins.
  for (const t of tokens) {
    const n = ORDINAL_WORDS[t];
    if (n !== undefined && n <= count) return n - 1;
  }
  for (const t of tokens) {
    const n = /^\d+$/.test(t) ? Number(t) : NUMBER_WORDS[t];
    if (n !== undefined && n >= 1 && n <= count) return n - 1;
  }
  return null;
}

/**
 * The index of the option a spoken answer names, or null. Order: a label said
 * whole, then a number or ordinal ("two", "2", "the first one", "option two"),
 * then a label whose every word was said, then a short answer made only of one
 * label's words ("force it" for "Force it when the image lands").
 */
export function matchSpokenOption(transcript: string, labels: readonly string[]): number | null {
  const said = words(transcript);
  if (said.length === 0 || labels.length === 0) return null;
  const parts = labels.map(words);

  let whole = -1;
  parts.forEach((p, i) => {
    if (hasPhrase(said, p) && (whole < 0 || p.length > parts[whole].length)) whole = i;
  });
  if (whole >= 0) return whole;

  const numbered = numberIn(said, labels.length);
  if (numbered !== null) return numbered;

  const all = parts.flatMap((p, i) =>
    p.length > 0 && p.every((w) => said.includes(w)) ? [i] : [],
  );
  if (all.length > 0) {
    const longest = Math.max(...all.map((i) => parts[i].length));
    const top = all.filter((i) => parts[i].length === longest);
    return top.length === 1 ? top[0] : null;
  }

  const content = said.filter((w) => !STOP_WORDS.has(w));
  if (content.length === 0 || said.length > 4) return null;
  const subset = parts.flatMap((p, i) => (content.every((w) => p.includes(w)) ? [i] : []));
  return subset.length === 1 ? subset[0] : null;
}

/** Several options at once, for a multi-select card ("one and three", "force it, hold it"). */
export function matchSpokenOptions(transcript: string, labels: readonly string[]): number[] {
  const found = new Set<number>();
  for (const segment of transcript.split(/,|\band\b|\bplus\b|\balso\b/i)) {
    const index = matchSpokenOption(segment, labels);
    if (index !== null) found.add(index);
  }
  return [...found].sort((a, b) => a - b);
}

const DONE_PHRASES = [
  "done",
  "thats all",
  "that is all",
  "thats it",
  "that is it",
  "finished",
  "submit",
  "all done",
];

/** The transcript without a closing "done", and whether it had one. */
export function splitDone(transcript: string): { done: boolean; rest: string } {
  const said = words(transcript);
  for (const phrase of DONE_PHRASES) {
    const p = phrase.split(" ");
    const end = said.length - p.length;
    if (end >= 0 && p.every((w, i) => said[end + i] === w)) {
      return { done: true, rest: said.slice(0, end).join(" ") };
    }
  }
  return { done: false, rest: transcript };
}

/** True when the transcript ends the picking on a multi-select card. */
export function isDoneWord(transcript: string): boolean {
  return splitDone(transcript).done;
}

/** "Question. <text> One, <label>. Two, <label>." Descriptions are not read. */
export function questionSpeech(question: string, labels: readonly string[]): string {
  const text = question.trim();
  const head = /[.?!]$/.test(text) ? text : `${text}.`;
  const options = labels.map((label, i) => {
    const l = label.trim().replace(/[.?!]+$/, "");
    return `${NUMBER_SPOKEN[i] ?? String(i + 1)}, ${l}.`;
  });
  return ["Question.", head, ...options].join(" ");
}

// The pending question card

export function isPendingElicitation(
  b: AnyBlock,
  conversationId: string | null,
): b is ElicitationBlock {
  return (
    b.type === "elicitation" &&
    b.status === "pending" &&
    (b.targetSessionId == null || b.targetSessionId === conversationId)
  );
}

/** The key a card's answers use: the question's id, else its text. */
export function questionKey(q: { id?: string; question: string }): string {
  return q.id && q.id.length > 0 ? q.id : q.question;
}

/** The questions on a pending card, or null when it is not a question card Voice mode can answer. */
export function questionsOf(
  block: ElicitationBlock | undefined,
): AskUserQuestionPayload["questions"] | null {
  if (!block) return null;
  const payload =
    castAskUserQuestionPayload(block.askUserQuestion) ??
    parseAskUserQuestionPreview(block.contentPreview);
  const questions = payload?.questions;
  if (!questions || questions.length === 0 || questions.some((q) => q.isSecret)) return null;
  return questions;
}
