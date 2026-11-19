// Speak replies: per-browser preferences, voice ranking and a queueing speaker
// over window.speechSynthesis. Every access is guarded; nothing here throws when
// the speech API or storage is missing.

import { splitForSpeech } from "./aeSpeechText";
import { logVoice } from "./aeVoiceLog";
import { isWebKitSpeech } from "./aeVoiceStall";
import { isIosDevice } from "./aeVoiceServerStt";
import { clearPlaybackBlocked, markPlaybackBlocked } from "./aeVoicePlayback";

export const WORKING_CUE_TEXT = "Working on it.";
export const WORKING_CUE_DELAY_MS = 6000;
export const FAST_EFFORT = "low";
export const RATE_FASTER = 1.25;
export const RATE_FASTEST = 1.5;

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

export interface VoiceChoice {
  kind: "cloud" | "device";
  id: string;
}

/** Stored as `cloud:<id>` or `device:<voiceURI>`; a bare value is a device URI from before. */
export function readVoiceChoice(): VoiceChoice | null {
  const raw = getItem(SPEAK_VOICE_KEY);
  if (raw === null || raw === "") return null;
  if (raw.startsWith("cloud:") && raw.length > 6) return { kind: "cloud", id: raw.slice(6) };
  if (raw.startsWith("device:") && raw.length > 7) return { kind: "device", id: raw.slice(7) };
  return { kind: "device", id: raw };
}

/** True when the stored value predates the `cloud:` and `device:` prefixes. */
export function isLegacyVoiceChoice(): boolean {
  const raw = getItem(SPEAK_VOICE_KEY);
  return !!raw && !/^(cloud|device):./.test(raw);
}

export function writeVoiceChoice(choice: VoiceChoice | null): void {
  setItem(SPEAK_VOICE_KEY, choice === null ? null : `${choice.kind}:${choice.id}`);
}

export function readRate(): number {
  const raw = getItem(SPEAK_RATE_KEY);
  if (raw === String(RATE_FASTER)) return RATE_FASTER;
  if (raw === String(RATE_FASTEST)) return RATE_FASTEST;
  return 1;
}

export function writeRate(rate: number): void {
  setItem(SPEAK_RATE_KEY, rate === RATE_FASTER || rate === RATE_FASTEST ? String(rate) : null);
}

export function isSpeechSupported(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.speechSynthesis) && typeof window.SpeechSynthesisUtterance === "function";
}

export function listVoices(): SpeechSynthesisVoice[] {
  if (!isSpeechSupported()) return [];
  try {
    const voices = window.speechSynthesis.getVoices();
    return isIosDevice() ? dedupeIosVoices(voices.filter((v) => !isSilentIosVoice(v))) : voices;
  } catch {
    return [];
  }
}

/**
 * Apple's novelty and legacy Mac voices. iOS lists them in getVoices() but
 * most never make a sound, so the picker hides them on iPhone and iPad.
 */
const SILENT_IOS_VOICE_NAMES = new Set([
  "albert", "bad news", "bahh", "bells", "boing", "bubbles", "cellos",
  "good news", "jester", "organ", "superstar", "trinoids", "whisper",
  "wobble", "zarvox", "fred", "junior", "kathy", "ralph",
]);

export function isSilentIosVoice(voice: SpeechSynthesisVoice): boolean {
  return SILENT_IOS_VOICE_NAMES.has(voice.name.trim().toLowerCase());
}

function iosVoiceQuality(voice: SpeechSynthesisVoice): number {
  const uri = voice.voiceURI ?? "";
  if (/\.premium\./i.test(uri)) return 2;
  if (/\.enhanced\./i.test(uri)) return 1;
  return 0;
}

function iosVoiceKey(v: SpeechSynthesisVoice): string {
  // Only Apple's quality tiers of one system voice are merged; any other voice
  // (a Personal Voice, a third-party voice) stays its own entry.
  if (!/^com\.apple\.voice\.(compact|enhanced|premium)\./i.test(v.voiceURI ?? "")) {
    return `uri|${v.voiceURI}`;
  }
  return `${v.name.trim().toLowerCase()}|${(v.lang ?? "").replace("_", "-").toLowerCase()}`;
}

/**
 * Map a saved device voice URI to the copy listVoices() keeps. A pick of a
 * copy that the iOS dedupe dropped resolves to the kept copy of the same voice.
 */
export function canonicalVoiceUri(uri: string): string {
  const voices = listVoices();
  if (voices.some((v) => v.voiceURI === uri)) return uri;
  let raw: SpeechSynthesisVoice | undefined;
  try {
    raw = window.speechSynthesis.getVoices().find((v) => v.voiceURI === uri);
  } catch {
    return uri;
  }
  if (!raw) return uri;
  const key = iosVoiceKey(raw);
  return voices.find((v) => iosVoiceKey(v) === key)?.voiceURI ?? uri;
}

/**
 * iOS lists a voice once per installed quality (compact, enhanced, premium)
 * under the same name. Keep one entry per name and language, the best quality.
 */
export function dedupeIosVoices(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  const best = new Map<string, SpeechSynthesisVoice>();
  for (const v of voices) {
    const key = iosVoiceKey(v);
    const held = best.get(key);
    if (!held || iosVoiceQuality(v) > iosVoiceQuality(held)) best.set(key, v);
  }
  const keep = new Set(best.values());
  return voices.filter((v) => keep.has(v));
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
  /** A cloud voice id; only the cloud speaker reads it. */
  cloudVoiceId?: string | null;
  /** The first chunk is a short phrase, so the voice starts sooner (first speak of a reply). */
  shortFirst?: boolean;
}

// The sentence being spoken, for the Voice panel. The chat's hook registers the receiver.
let captionHandler: ((text: string) => void) | null = null;

export function setCaptionHandler(handler: ((text: string) => void) | null): void {
  captionHandler = handler;
}

// Audio is really playing (not just queued): the chat's hook registers the receiver.
let playbackHandler: ((playing: boolean) => void) | null = null;

export function setPlaybackHandler(handler: ((playing: boolean) => void) | null): void {
  playbackHandler = handler;
}

export function emitPlaying(playing: boolean): void {
  try {
    playbackHandler?.(playing);
  } catch {
    // A receiver failure must not stop the voice.
  }
}

export function emitCaption(text: string): void {
  try {
    captionHandler?.(text);
  } catch {
    // A caption failure must not stop the voice.
  }
}

// The cloud speaker's prime, registered by the hook module that owns the cloud speaker.
let cloudPrimer: (() => void) | null = null;

export function registerCloudPrimer(primer: (() => void) | null): void {
  cloudPrimer = primer;
}

let cloudReleaser: (() => number) | null = null;
let cloudSpeaking: (() => boolean) | null = null;

/**
 * The cloud speaker's mic-start release: frees its audio element and returns the settle ms left.
 * `speaking` tells whether a real reply is playing, so a reply that starts during the settle is
 * waited out instead of the mic starting over it.
 */
export function registerCloudReleaser(
  releaser: (() => number) | null,
  speaking: (() => boolean) | null = null,
): void {
  cloudReleaser = releaser;
  cloudSpeaking = speaking;
}

/** On WebKit, how long after the cloud audio element is released the recognizer may start. */
export const MIC_AUDIO_SETTLE_MS = 150;

/** True from the moment the silent priming utterance is spoken until it ends, errors or is cancelled. */
let primeSpeaking = false;
const PRIME_FLAG_MAX_MS = 12_000;

/** Test hook: forget a prime in flight. */
export function resetPrimeSpeaking(): void {
  primeSpeaking = false;
}

/**
 * Unlocks audio for later replies. Call only inside a click or pointer handler:
 * iOS refuses playback that no tap started. Never throws.
 */
export function primeVoicePlayback(): void {
  logVoice("prime");
  try {
    cloudPrimer?.();
  } catch {
    // Priming is best effort.
  }
  try {
    if (!isSpeechSupported()) return;
    // WebKit keeps a zero-volume utterance speaking for about 10 s and holds the audio session,
    // so a recognizer started meanwhile hears nothing. The cloud voice never needs it.
    // Known gap (doc only): this WebKit cloud path also skips the synth unlock, so if the cloud
    // voice later fails and the device-voice fallback speaks, iOS may need one more tap first.
    if (isWebKitSpeech() && readVoiceChoice()?.kind === "cloud") {
      logVoice("prime skipped synth (webkit cloud)");
      return;
    }
    const synth = window.speechSynthesis;
    if (synth.speaking) return;
    const utterance = new window.SpeechSynthesisUtterance(" ");
    utterance.volume = 0;
    primeSpeaking = true;
    // The engine may never report the end (iOS can drop it): a safety timer clears the flag so
    // a later real reply is never mistaken for the prime.
    const safety = setTimeout(() => {
      primeSpeaking = false;
    }, PRIME_FLAG_MAX_MS);
    const clear = () => {
      clearTimeout(safety);
      primeSpeaking = false;
    };
    utterance.onend = clear;
    utterance.onerror = clear;
    try {
      synth.speak(utterance);
    } catch (err) {
      primeSpeaking = false;
      throw err;
    }
  } catch {
    // Priming is best effort.
  }
}

/** How often, and for how long, a WebKit mic start waits for the priming utterance to end. */
export const MIC_SYNTH_POLL_MS = 100;
export const MIC_SYNTH_WAIT_CAP_MS = 1500;

/**
 * Runs `go` once the device synthesizer is idle. Only WebKit waits (its priming utterance holds
 * the audio session); elsewhere, and whenever a real reply is speaking instead of the prime, `go`
 * runs at once and nothing is cancelled. At the cap the prime is cancelled and `go` runs. Returns a cancel that drops a pending `go`. Never throws.
 */
export function whenSynthIdle(go: () => void): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inner: (() => void) | null = null;
  const realReplySpeaking = (): boolean => {
    try {
      return cloudSpeaking?.() ?? false;
    } catch {
      return false;
    }
  };
  // WebKit: the cloud audio element must have let go of the audio session before the mic starts.
  const begin = () => {
    timer = null;
    if (cancelled) return;
    let settleMs = 0;
    try {
      if (isWebKitSpeech()) settleMs = cloudReleaser?.() ?? 0;
    } catch {
      settleMs = 0;
    }
    if (settleMs > 0) timer = setTimeout(settleDone, settleMs);
    else inner = whenSynthIdleNow(go);
  };
  // A reply that started during the settle owns the element: wait for it, then release again.
  const settleDone = () => {
    timer = null;
    if (cancelled) return;
    if (realReplySpeaking()) {
      timer = setTimeout(waitForReply, MIC_SYNTH_POLL_MS);
      return;
    }
    inner = whenSynthIdleNow(go);
  };
  const waitForReply = () => {
    timer = null;
    if (cancelled) return;
    if (realReplySpeaking()) timer = setTimeout(waitForReply, MIC_SYNTH_POLL_MS);
    else begin();
  };
  begin();
  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    inner?.();
  };
}

function whenSynthIdleNow(go: () => void): () => void {
  let synth: SpeechSynthesis | null = null;
  try {
    // Wait only for the priming utterance, never for a real reply that is speaking.
    if (
      primeSpeaking &&
      isWebKitSpeech() &&
      isSpeechSupported() &&
      window.speechSynthesis.speaking
    ) {
      synth = window.speechSynthesis;
    } else if (primeSpeaking && isSpeechSupported() && !window.speechSynthesis.speaking) {
      primeSpeaking = false;
    }
  } catch {
    synth = null;
  }
  if (!synth) {
    go();
    return () => {};
  }
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    timer = null;
    const speaking = ((): boolean => {
      try {
        return synth.speaking;
      } catch {
        return false;
      }
    })();
    const waited = Date.now() - started;
    if (!speaking) primeSpeaking = false;
    if (primeSpeaking && waited < MIC_SYNTH_WAIT_CAP_MS) {
      timer = setTimeout(tick, MIC_SYNTH_POLL_MS);
      return;
    }
    if (primeSpeaking && speaking) {
      // Only the prime is speaking here (the flag), so a real reply is never cancelled.
      primeSpeaking = false;
      try {
        synth.cancel();
      } catch {
        // Best effort.
      }
    }
    logVoice("mic waited for synth", `${waited} ms`);
    go();
  };
  timer = setTimeout(tick, MIC_SYNTH_POLL_MS);
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

/** Unlocks the cloud voices' audio element only; call inside a tap. Never throws. */
export function primeCloudPlayback(): void {
  logVoice("prime cloud");
  try {
    cloudPrimer?.();
  } catch {
    // Priming is best effort.
  }
}

export interface Speaker {
  speak: (text: string, opts: SpeakOptions) => void;
  stop: () => void;
  /** Unlocks playback inside a tap (the cloud speaker's audio element). */
  prime?: () => void;
  /** WebKit: frees the audio element before the mic starts; returns the settle ms still to wait. */
  releaseForMic?: () => number;
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

  // Chunks the browser refused ("not-allowed"), spoken again by the tap that resumes.
  let refused: { chunk: string; opts: SpeakOptions }[] = [];

  const notify = () => listeners.forEach((cb) => cb());
  const setSpeaking = (next: boolean) => {
    if (isSpeaking === next) return;
    isSpeaking = next;
    if (!next) emitPlaying(false);
    notify();
  };

  const speakChunk = (chunk: string, opts: SpeakOptions, gen: number, resumed: boolean) => {
    const synth = window.speechSynthesis;
    const voices = listVoices();
    const voice =
      (opts.voiceURI
        ? voices.find((v) => v.voiceURI === canonicalVoiceUri(opts.voiceURI!))
        : undefined) ??
      pickDefaultVoice(voices);
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
      if (pending === 0) {
        setSpeaking(false);
        emitCaption("");
      }
    };
    utterance.onstart = () => {
      if (gen !== generation) return;
      if (resumed) clearPlaybackBlocked();
      logVoice("say start");
      emitPlaying(true);
      emitCaption(chunk);
    };
    utterance.onend = () => {
      logVoice("say end");
      done();
    };
    utterance.onerror = (e) => {
      logVoice(e.error === "not-allowed" ? "say blocked" : "say error", e.error);
      if (e.error === "not-allowed" && gen === generation) {
        // Keep the item current: speaking() stays true until a tap plays it or stop() runs.
        utterances.delete(utterance);
        refused.push({ chunk, opts });
        markPlaybackBlocked(() => {
          const again = refused;
          refused = [];
          for (const r of again) speakChunk(r.chunk, r.opts, gen, true);
        });
        return;
      }
      done();
    };
    try {
      synth.speak(utterance);
    } catch {
      done();
    }
  };

  return {
    speak(text, opts) {
      if (!isSpeechSupported()) return;
      const chunks = splitForSpeech(text, undefined, { shortFirst: opts.shortFirst });
      if (chunks.length === 0) return;
      const gen = generation;
      pending += chunks.length;
      setSpeaking(true);
      // Chrome drops a speak() issued in the same tick as cancel().
      setTimeout(() => {
        if (gen !== generation) return;
        for (const chunk of chunks) speakChunk(chunk, opts, gen, false);
      }, 0);
    },
    stop() {
      generation++;
      pending = 0;
      refused = [];
      clearPlaybackBlocked();
      emitCaption("");
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
