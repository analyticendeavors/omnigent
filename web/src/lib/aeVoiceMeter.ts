// "Level meter": per device, whether the mic button opens a second microphone stream to draw
// live levels. On iOS WebKit the newest capture wins, so that second stream can take the mic
// from the speech recognizer and leave it deaf; the default there is off. Elsewhere it is on.
// With it off, the ring and bars follow the recognizer's own events instead.

import { useSyncExternalStore } from "react";
import { isWebKitSpeech } from "./aeVoiceStall";

export const VOICE_METER_KEY = "omnigent:ae-voice-meter";

/** The saved choice: "on", "off", or null when the user never chose. */
function readSaved(): "on" | "off" | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(VOICE_METER_KEY);
    return v === "on" || v === "off" ? v : null;
  } catch {
    return null;
  }
}

/** The meter's default on this device: off on WebKit/iOS browser recognition, on elsewhere. */
export function voiceMeterDefault(): boolean {
  return !isWebKitSpeech();
}

export function readVoiceMeter(): boolean {
  const saved = readSaved();
  return saved === null ? voiceMeterDefault() : saved === "on";
}

const listeners = new Set<() => void>();

export function subscribeVoiceMeter(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function writeVoiceMeter(on: boolean): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(VOICE_METER_KEY, on ? "on" : "off");
    } catch {
      // A storage failure must not break the composer.
    }
  }
  listeners.forEach((cb) => cb());
}

export function useVoiceMeter(): boolean {
  return useSyncExternalStore(subscribeVoiceMeter, readVoiceMeter, () => true);
}
