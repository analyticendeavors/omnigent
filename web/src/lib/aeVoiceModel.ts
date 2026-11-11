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
    };
  } catch {
    return null;
  }
}

export function writeVoiceModelState(chatId: string, state: VoiceModelState): void {
  setItem(STATE_KEY + chatId, JSON.stringify(state));
}

export function clearVoiceModelState(chatId: string): void {
  setItem(STATE_KEY + chatId, null);
}
