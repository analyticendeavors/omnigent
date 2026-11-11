// "Mic while speaking": per device, whether Voice mode keeps the mic open while a reply
// plays (`always`, speaking cuts it off) or waits until it ends (`wait`, the default).

import { useSyncExternalStore } from "react";

export type MicWhileSpeaking = "wait" | "always";
export const MIC_WHILE_SPEAKING_KEY = "omnigent:ae-voice-mic-while-speaking";

export function readMicWhileSpeaking(): MicWhileSpeaking {
  if (typeof window === "undefined") return "wait";
  try {
    return window.localStorage.getItem(MIC_WHILE_SPEAKING_KEY) === "always" ? "always" : "wait";
  } catch {
    return "wait";
  }
}

const listeners = new Set<() => void>();

export function subscribeMicWhileSpeaking(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function writeMicWhileSpeaking(mode: MicWhileSpeaking): void {
  if (typeof window !== "undefined") {
    try {
      if (mode === "always") window.localStorage.setItem(MIC_WHILE_SPEAKING_KEY, "always");
      else window.localStorage.removeItem(MIC_WHILE_SPEAKING_KEY);
    } catch {
      // A storage failure must not break the composer.
    }
  }
  listeners.forEach((cb) => cb());
}

export function useMicWhileSpeaking(): MicWhileSpeaking {
  return useSyncExternalStore(subscribeMicWhileSpeaking, readMicWhileSpeaking, () => "wait");
}
