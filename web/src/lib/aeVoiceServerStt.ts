// "Transcribe on the box": per device, whether Voice mode on an iPhone or iPad sends the mic to
// the server's dictation (WS /v1/dictation/stream) instead of Apple's webkitSpeechRecognition.
// On iOS 18 the browser recognizer goes deaf after any spoken reply, so the default there is on.
// Elsewhere the setting does not exist: it is off and not shown. Manual mic taps keep their path.
//
// This file also holds the one AudioContext a Voice tap unlocks. iOS only lets a context run
// when it was created or resumed inside a user gesture, and a dictation take builds its audio
// graph long after the tap (once the socket is ready), so the tap makes the context and the take
// reuses it.

import { useSyncExternalStore } from "react";

export const VOICE_SERVER_STT_KEY = "omnigent:ae-voice-server-stt";

/** iPhone, iPad and iPod, including iPadOS asking for the desktop site. Not desktop Safari. */
export function isIosDevice(): boolean {
  try {
    const nav = navigator;
    const ua = nav.userAgent ?? "";
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    return /Macintosh/.test(ua) && nav.maxTouchPoints > 1;
  } catch {
    return false;
  }
}

/** The saved choice: "on", "off", or null when the user never chose. */
function readSaved(): "on" | "off" | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(VOICE_SERVER_STT_KEY);
    return v === "on" || v === "off" ? v : null;
  } catch {
    return null;
  }
}

/** The setting's value: the saved choice, else on for iOS and off elsewhere. */
export function readVoiceServerStt(): boolean {
  const saved = readSaved();
  return saved === null ? isIosDevice() : saved === "on";
}

/** True when a Voice mode start on this device should use the server recognizer. */
export function voiceServerStt(): boolean {
  return isIosDevice() && readVoiceServerStt();
}

const listeners = new Set<() => void>();

export function subscribeVoiceServerStt(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function writeVoiceServerStt(on: boolean): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(VOICE_SERVER_STT_KEY, on ? "on" : "off");
    } catch {
      // A storage failure must not break the composer.
    }
  }
  listeners.forEach((cb) => cb());
}

/** Reactive {@link voiceServerStt}. */
export function useVoiceServerStt(): boolean {
  return useSyncExternalStore(subscribeVoiceServerStt, voiceServerStt, () => false);
}

let sharedCtx: AudioContext | null = null;

/** The tap-unlocked context, or null when none exists or it was closed. */
export function getSharedVoiceAudioContext(): AudioContext | null {
  if (sharedCtx && sharedCtx.state === "closed") sharedCtx = null;
  return sharedCtx;
}

/**
 * Call inside a Voice tap (next to primeVoicePlayback): makes the shared context if needed and
 * resumes it. A no-op unless the server recognizer will be used on this device.
 */
export function unlockVoiceAudioContext(): void {
  if (!voiceServerStt()) return;
  try {
    if (!getSharedVoiceAudioContext()) sharedCtx = new AudioContext();
    void Promise.resolve(sharedCtx?.resume?.()).catch(() => {});
  } catch {
    // Unlocking is best effort; the take falls back to its own context.
  }
}

/**
 * Resumes the tap-unlocked context when one exists, without making one. For a Voice mode start
 * with no gesture (auto-arm, chat switch): a context made outside a tap would start suspended.
 */
export function resumeVoiceAudioContext(): void {
  const ctx = getSharedVoiceAudioContext();
  if (!ctx || ctx.state === "running") return;
  try {
    void Promise.resolve(ctx.resume?.()).catch(() => {});
  } catch {
    // Best effort; DictationSession logs a context that is still not running.
  }
}

/** Test seam: forget the shared context. */
export function resetSharedVoiceAudioContext(): void {
  sharedCtx = null;
}
