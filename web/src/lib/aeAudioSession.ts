// Safari Audio Session API (navigator.audioSession, Safari 16.4+ and iOS 17+).
// On iOS, playing the cloud voice on an <audio> element switches the page's audio session to
// playback, and WebKit speech recognition never switches it back, so every later mic start hears
// "No speech detected". While Voice mode is on, the session is pinned to "play-and-record".
// WebKit only, feature-detected, and a no-op everywhere else. Nothing here throws.

import { logVoice } from "./aeVoiceLog";
import { isWebKitSpeech } from "./aeVoiceStall";

interface AudioSessionLike {
  type: string;
}

const VOICE_TYPE = "play-and-record";

// Reference count of holders: each mounted Voice chat holds one, and a start tap holds one
// (the "pending hold") until the chat's hook adopts it. The previous type is restored only when
// the count returns to zero.
let holders = 0;
let previousType: string | null = null;
let pendingHold = false;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
/** A start tap's hold that no Voice chat adopted gives itself back after this long. */
export const PENDING_HOLD_MS = 30_000;

function getSession(): AudioSessionLike | null {
  try {
    if (!isWebKitSpeech()) return null;
    const session = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
    return session && typeof session.type === "string" ? session : null;
  } catch {
    return null;
  }
}

function setType(session: AudioSessionLike, type: string): void {
  try {
    if (session.type !== type) session.type = type;
    logVoice(`audio session ${type}`);
  } catch {
    // An unsupported type must not break voice.
  }
}

/** The current audio session type, or "none" where the API is missing. For the mic-start log. */
export function audioSessionType(): string {
  const session = getSession();
  if (!session) return "none";
  try {
    return session.type;
  } catch {
    return "unreadable";
  }
}

/** One more holder: remember the current type on the first one and pin play-and-record. */
export function enterVoiceAudioSession(): void {
  holders += 1;
  const session = getSession();
  if (!session) return;
  if (holders === 1) {
    try {
      previousType = session.type;
    } catch {
      previousType = null;
    }
  }
  setType(session, VOICE_TYPE);
}

/** Set it again (before a mic start, after a reply ends); WebKit may have changed it. */
export function assertVoiceAudioSession(): void {
  if (holders === 0) return;
  const session = getSession();
  if (!session) return;
  try {
    if (session.type === VOICE_TYPE) return;
  } catch {
    return;
  }
  setType(session, VOICE_TYPE);
}

/** One holder fewer; the earlier type comes back only when the last one leaves. */
export function leaveVoiceAudioSession(): void {
  if (holders === 0) return;
  holders -= 1;
  if (holders > 0) return;
  const session = getSession();
  const restore = previousType ?? "auto";
  previousType = null;
  if (session) setType(session, restore);
}

/**
 * Called inside a user tap that will start Voice mode (the new-chat Voice button, the Voice
 * switch), where iOS accepts the type change. The chat's Voice hook does not exist yet (or has
 * not seen the switch), so this holds the session on its behalf; useAeVoiceMode enters for the
 * chat and then calls releaseVoiceAudioHold, so the count never touches zero in between. A hold
 * nobody adopts is released after PENDING_HOLD_MS.
 */
export function holdVoiceAudioSession(): void {
  if (pendingHold) return;
  pendingHold = true;
  enterVoiceAudioSession();
  pendingTimer = setTimeout(releaseVoiceAudioHold, PENDING_HOLD_MS);
}

/** Give back the tap's hold, if one is pending. */
export function releaseVoiceAudioHold(): void {
  if (!pendingHold) return;
  pendingHold = false;
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
  leaveVoiceAudioSession();
}

/** Test hook. */
export function resetAudioSessionState(): void {
  holders = 0;
  previousType = null;
  pendingHold = false;
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
}
