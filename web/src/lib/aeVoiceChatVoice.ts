// The voice Voice mode speaks with (omnigent-ae, 2026-11-12). Rocky's cloud voice takes seconds per
// sentence, so while Voice mode is on, replies, Read last reply and the approval line use this
// voice instead; outside Voice mode the normal Voice pick applies. Saved per device.

import type { CloudVoice } from "./aeCloudVoice";
import type { VoiceChoice } from "./aeSpeakReplies";

export const VOICE_CHAT_VOICE_KEY = "omnigent:ae-voice-chat-voice";
/** Stored value for "Same as Speak replies". */
export const VOICE_CHAT_VOICE_SAME = "same";

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

/** The saved pick: `same`, `cloud:<id>`, `device:<voiceURI>`, or null when none was made. */
export function readVoiceChatVoicePick(): string | null {
  const raw = getItem(VOICE_CHAT_VOICE_KEY);
  if (raw === VOICE_CHAT_VOICE_SAME) return raw;
  if (raw !== null && /^(cloud|device):./.test(raw)) return raw;
  return null;
}

export function writeVoiceChatVoicePick(pick: string | null): void {
  setItem(VOICE_CHAT_VOICE_KEY, pick);
}

/** The fastest cloud voice that is not Rocky's: the first one the server lists (Azure). */
export function fastestCloudVoice(cloudVoices: readonly CloudVoice[]): CloudVoice | null {
  return cloudVoices.find((v) => v.provider !== "rocky") ?? null;
}

/**
 * The voice Voice mode speaks with. `same` gives the Speak replies voice. A saved voice that the
 * server no longer lists falls to the default. The default is the fastest non-Rocky cloud voice,
 * else the device voice.
 */
export function resolveVoiceChatVoice(
  pick: string | null,
  cloudVoices: readonly CloudVoice[],
  speakVoice: VoiceChoice | null,
  deviceDefault: VoiceChoice | null,
): VoiceChoice | null {
  if (pick === VOICE_CHAT_VOICE_SAME) return speakVoice;
  if (pick !== null) {
    const [kind, ...rest] = pick.split(":");
    const id = rest.join(":");
    if (kind === "device") return { kind: "device", id };
    // An empty list is a list not loaded yet: keep the saved cloud voice, the server knows it.
    if (cloudVoices.length === 0 || cloudVoices.some((v) => v.id === id)) {
      return { kind: "cloud", id };
    }
  }
  const fast = fastestCloudVoice(cloudVoices);
  return fast ? { kind: "cloud", id: fast.id } : deviceDefault;
}

/** The pick the menu shows as selected. */
export function voiceChatVoiceKey(pick: string | null, resolved: VoiceChoice | null): string {
  if (pick === VOICE_CHAT_VOICE_SAME) return VOICE_CHAT_VOICE_SAME;
  return resolved ? `${resolved.kind}:${resolved.id}` : "";
}
