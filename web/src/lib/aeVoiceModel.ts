// Voice mode's fast model (omnigent-ae, 2026-11-11): while Voice mode is on, a Claude chat runs on a
// quick model (newest Sonnet unless the person picked another), and the chat's own model comes back
// when Voice mode ends. Fast answers (low effort) is a separate setting and stays as it was.

import { aeClaudeVersion, aeClaudeVersionLabel } from "@/lib/aeClaudeModels";
import { findNativeModelOption } from "@/lib/codexNativeModels";
import type { NativeModelOption } from "@/lib/types";

export const VOICE_MODEL_KEY = "omnigent:ae-voice-fast-model";
const STATE_KEY = "omnigent:ae-voice-model-state:";
/** Stored value for "keep the chat's own model". */
export const VOICE_MODEL_OFF = "off";

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

/** The saved pick: a model id, `off`, or null when none was made (the default applies). */
export function readVoiceModelPick(): string | null {
  const raw = getItem(VOICE_MODEL_KEY);
  return raw === null || raw === "" ? null : raw;
}

export function writeVoiceModelPick(pick: string | null): void {
  setItem(VOICE_MODEL_KEY, pick);
}

/** The newest Sonnet row, else null (a family without a Sonnet row has no default). */
export function defaultFastModel(options: readonly NativeModelOption[]): NativeModelOption | null {
  let best: { option: NativeModelOption; score: number } | null = null;
  for (const option of options) {
    const text = `${option.model ?? ""} ${option.id}`;
    const version = aeClaudeVersion(option.model ?? option.id) ?? aeClaudeVersion(option.id);
    const family = version?.family ?? (/sonnet/i.test(text) ? "sonnet" : null);
    if (family !== "sonnet") continue;
    const score = version ? version.major * 1000 + version.minor : 0;
    if (best === null || score > best.score) best = { option, score };
  }
  return best?.option ?? null;
}

/** The model id Voice mode should switch to, or null for off, an unknown pick or no Sonnet row. */
export function resolveFastModel(
  pick: string | null,
  options: readonly NativeModelOption[],
): string | null {
  if (pick === VOICE_MODEL_OFF) return null;
  if (pick !== null) {
    const chosen = options.find((option) => option.id === pick);
    if (chosen) return chosen.id;
  }
  return defaultFastModel(options)?.id ?? null;
}

export function voiceModelLabel(option: NativeModelOption): string {
  const version =
    aeClaudeVersionLabel(option.model ?? option.id) ?? aeClaudeVersionLabel(option.id);
  return version ?? option.displayName ?? option.id;
}

/** The model the chat runs on now: the pick it was given, else the harness's reported row. */
export function effectiveModelId(
  options: readonly NativeModelOption[],
  override: string | null,
  reported: string | null,
): string | null {
  return override ?? findNativeModelOption(options, reported)?.id ?? reported;
}

export interface VoiceModelState {
  /** The chat's model request before Voice mode (null: it followed the default). */
  previous: string | null;
  /** The model the chat reported then, for a session that cannot reset to its default. */
  fallback: string | null;
  /** The model Voice mode switched to. */
  fast: string;
  /** The tab that applied the switch (null for a state saved before tabs were recorded). */
  owner: string | null;
  /** When the switch was recorded, epoch ms (0 when unknown). */
  at: number;
}

/** Another tab's state counts as abandoned after this long. */
export const VOICE_MODEL_STALE_MS = 6 * 60 * 60 * 1000;

const TAB_KEY = "omnigent:ae-voice-tab-id";
let memoryTabId: string | null = null;

/** An id for this browser tab (kept in sessionStorage, so a reload keeps it). */
export function voiceTabId(): string {
  if (memoryTabId) return memoryTabId;
  let id: string | null;
  try {
    id = typeof window === "undefined" ? null : window.sessionStorage.getItem(TAB_KEY);
  } catch {
    id = null;
  }
  if (!id) {
    id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      window.sessionStorage.setItem(TAB_KEY, id);
    } catch {
      // The id then lives for this page only.
    }
  }
  memoryTabId = id;
  return id;
}

/** Test hook: forget the cached tab id. */
export function resetVoiceTabId(): void {
  memoryTabId = null;
}

export function readVoiceModelState(chatId: string): VoiceModelState | null {
  const raw = getItem(STATE_KEY + chatId);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VoiceModelState>;
    if (typeof parsed.fast !== "string" || parsed.fast === "") return null;
    return {
      previous: typeof parsed.previous === "string" ? parsed.previous : null,
      fallback: typeof parsed.fallback === "string" ? parsed.fallback : null,
      fast: parsed.fast,
      owner: typeof parsed.owner === "string" ? parsed.owner : null,
      at: typeof parsed.at === "number" ? parsed.at : 0,
    };
  } catch {
    return null;
  }
}

export function writeVoiceModelState(
  chatId: string,
  state: Omit<VoiceModelState, "owner" | "at"> & Partial<Pick<VoiceModelState, "owner" | "at">>,
): void {
  setItem(
    STATE_KEY + chatId,
    JSON.stringify({ ...state, owner: state.owner ?? voiceTabId(), at: state.at ?? Date.now() }),
  );
}

export function clearVoiceModelState(chatId: string): void {
  setItem(STATE_KEY + chatId, null);
}

function stale(state: VoiceModelState, now: number): boolean {
  return state.at === 0 || now - state.at > VOICE_MODEL_STALE_MS;
}

/**
 * May this tab revert and clear the state? The tab that applied the switch may; so may any tab for
 * a state saved before owners were recorded, an abandoned one, or one whose chat has Voice mode
 * persisted off. Another live tab's state is left alone.
 */
export function mayRevertVoiceModel(
  state: VoiceModelState,
  voicePersistedOn: boolean,
  now: number = Date.now(),
): boolean {
  return (
    state.owner === null || state.owner === voiceTabId() || !voicePersistedOn || stale(state, now)
  );
}

export type VoiceModelVerdict = "revert" | "hand-picked" | "keep";

/**
 * What the chat's current model says about the saved state. `revert`: still on the fast model.
 * `hand-picked`: a known model that is neither the fast nor the previous one (or the state is
 * abandoned): leave it and forget the state. `keep`: not hydrated yet, or a switch to the fast
 * model may still be in flight (the override is unknown, empty or the previous one).
 */
export function voiceModelVerdict(
  state: VoiceModelState,
  override: string | null,
  options: readonly NativeModelOption[],
  now: number = Date.now(),
): VoiceModelVerdict {
  if (override === state.fast) return "revert";
  if (stale(state, now)) return "hand-picked";
  if (override === null || override === state.previous) return "keep";
  return options.some((o) => o.id === override) ? "hand-picked" : "keep";
}
