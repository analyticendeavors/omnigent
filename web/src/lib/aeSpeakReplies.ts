// Speak replies: per-browser preferences, voice ranking and a queueing speaker
// over window.speechSynthesis. Every access is guarded; nothing here throws when
// the speech API or storage is missing.

import { splitForSpeech } from "./aeSpeechText";

export const WORKING_CUE_TEXT = "Working on it.";
export const WORKING_CUE_DELAY_MS = 6000;
export const FAST_EFFORT = "low";
export const RATE_FASTER = 1.25;

const SPEAK_KEY = "omnigent:ae-speak-replies:";
const FAST_STATE_KEY = "omnigent:ae-speak-fast:";
export const SPEAK_FAST_ENABLED_KEY = "omnigent:ae-speak-fast-enabled";
export const SPEAK_VOICE_KEY = "omnigent:ae-speak-voice";
export const SPEAK_RATE_KEY = "omnigent:ae-speak-rate";

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

export function readSpeakReplies(chatId: string): boolean {
  return getItem(SPEAK_KEY + chatId) === "true";
}

export function writeSpeakReplies(chatId: string, on: boolean): void {
  setItem(SPEAK_KEY + chatId, on ? "true" : null);
}

export interface FastAnswersState {
  previousEffort: string | null;
}

export function readFastAnswersState(chatId: string): FastAnswersState | null {
  const raw = getItem(FAST_STATE_KEY + chatId);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const prev = (parsed as { previousEffort?: unknown }).previousEffort;
    return { previousEffort: typeof prev === "string" ? prev : null };
  } catch {
    return null;
  }
}

export function writeFastAnswersState(chatId: string, state: FastAnswersState): void {
  setItem(FAST_STATE_KEY + chatId, JSON.stringify({ previousEffort: state.previousEffort }));
}

export function clearFastAnswersState(chatId: string): void {
  setItem(FAST_STATE_KEY + chatId, null);
}

export function readFastEnabled(): boolean {
  return getItem(SPEAK_FAST_ENABLED_KEY) !== "false";
}

export function writeFastEnabled(on: boolean): void {
  setItem(SPEAK_FAST_ENABLED_KEY, on ? null : "false");
}

export function readVoiceURI(): string | null {
  return getItem(SPEAK_VOICE_KEY);
}

export function writeVoiceURI(uri: string | null): void {
  setItem(SPEAK_VOICE_KEY, uri);
}

export function readRate(): number {
  return getItem(SPEAK_RATE_KEY) === String(RATE_FASTER) ? RATE_FASTER : 1;
}

export function writeRate(rate: number): void {
  setItem(SPEAK_RATE_KEY, rate === RATE_FASTER ? String(RATE_FASTER) : null);
}

export function isSpeechSupported(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.speechSynthesis) && typeof window.SpeechSynthesisUtterance === "function";
}

export function listVoices(): SpeechSynthesisVoice[] {
  if (!isSpeechSupported()) return [];
  try {
    return window.speechSynthesis.getVoices();
  } catch {
    return [];
  }
}

/** Voices load late in Chrome and Edge; the callback fires when the list changes. */
export function onVoicesChanged(cb: () => void): () => void {
  if (!isSpeechSupported()) return () => {};
  const synth = window.speechSynthesis;
  synth.addEventListener?.("voiceschanged", cb);
  return () => synth.removeEventListener?.("voiceschanged", cb);
}

function defaultLang(): string {
  try {
    return typeof navigator === "undefined" ? "en-US" : navigator.language || "en-US";
  } catch {
    return "en-US";
  }
}

export function rankVoices(
  voices: readonly SpeechSynthesisVoice[],
  lang: string = defaultLang(),
): SpeechSynthesisVoice[] {
  const prefix = lang.slice(0, 2).toLowerCase();
  const score = (v: SpeechSynthesisVoice): number[] => [
    v.lang.slice(0, 2).toLowerCase() === prefix ? 0 : 1,
    /Natural|Online/.test(v.name) ? 0 : 1,
    /Google/.test(v.name) ? 0 : 1,
    /Premium|Enhanced|Siri/.test(v.name) ? 0 : 1,
    v.default ? 0 : 1,
  ];
  return [...voices].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i];
    return a.name.localeCompare(b.name);
  });
}

export function pickDefaultVoice(
  voices: readonly SpeechSynthesisVoice[],
  lang: string = defaultLang(),
): SpeechSynthesisVoice | null {
  return rankVoices(voices, lang)[0] ?? null;
}

/** Short menu name: "Microsoft Aria Online (Natural) - English" reads "Aria (Natural)". */
export function voiceLabel(voice: Pick<SpeechSynthesisVoice, "name">): string {
  let name = voice.name.split(" - ")[0];
  const stripped = name.replace(/^(Microsoft|Google) /, "");
  if (stripped.trim() !== "") name = stripped;
  return name.replace(/ Online/, "").trim();
}

export interface SpeakOptions {
  voiceURI: string | null;
  rate: number;
}

export interface Speaker {
  speak: (text: string, opts: SpeakOptions) => void;
  stop: () => void;
  speaking: () => boolean;
  subscribe: (cb: () => void) => () => void;
  /** Utterances queued and not yet ended; the speaker keeps them referenced. */
  retained: () => number;
}

export function createSpeaker(): Speaker {
  const listeners = new Set<() => void>();
  // Bumped by stop() so events from cancelled utterances are ignored.
  let generation = 0;
  let pending = 0;
  let isSpeaking = false;
  // Chrome collects an unreferenced utterance mid-speech and never fires its end.
  const utterances = new Set<SpeechSynthesisUtterance>();

  const notify = () => listeners.forEach((cb) => cb());
  const setSpeaking = (next: boolean) => {
    if (isSpeaking === next) return;
    isSpeaking = next;
    notify();
  };

  return {
    speak(text, opts) {
      if (!isSpeechSupported()) return;
      const chunks = splitForSpeech(text);
      if (chunks.length === 0) return;
      const gen = generation;
      const synth = window.speechSynthesis;
      const voices = listVoices();
      const voice =
        (opts.voiceURI ? voices.find((v) => v.voiceURI === opts.voiceURI) : undefined) ??
        pickDefaultVoice(voices);
      pending += chunks.length;
      setSpeaking(true);
      // Chrome drops a speak() issued in the same tick as cancel().
      setTimeout(() => {
        if (gen !== generation) return;
        for (const chunk of chunks) {
          const utterance = new window.SpeechSynthesisUtterance(chunk);
          if (voice) {
            utterance.voice = voice;
            utterance.lang = voice.lang;
          }
          utterance.rate = opts.rate;
          utterances.add(utterance);
          const done = () => {
            utterances.delete(utterance);
            if (gen !== generation) return;
            pending = Math.max(0, pending - 1);
            if (pending === 0) setSpeaking(false);
          };
          utterance.onend = done;
          utterance.onerror = done;
          try {
            synth.speak(utterance);
          } catch {
            done();
          }
        }
      }, 0);
    },
    stop() {
      generation++;
      pending = 0;
      utterances.clear();
      if (isSpeechSupported()) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // Nothing to cancel.
        }
      }
      setSpeaking(false);
    },
    speaking: () => isSpeaking,
    retained: () => utterances.size,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
