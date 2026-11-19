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

let active = false;
let previousType: string | null = null;

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

/** Voice mode started: remember the current type once and pin play-and-record. */
export function enterVoiceAudioSession(): void {
  const session = getSession();
  if (!session) return;
  if (!active) {
    try {
      previousType = session.type;
    } catch {
      previousType = null;
    }
    active = true;
  }
  setType(session, VOICE_TYPE);
}

/** Set it again (before a mic start, after a reply ends); WebKit may have changed it. */
export function assertVoiceAudioSession(): void {
  if (!active) return;
  const session = getSession();
  if (!session) return;
  try {
    if (session.type === VOICE_TYPE) return;
  } catch {
    return;
  }
  setType(session, VOICE_TYPE);
}

/** Voice mode ended: put the type back as it was. */
export function leaveVoiceAudioSession(): void {
  if (!active) return;
  active = false;
  const session = getSession();
  const restore = previousType ?? "auto";
  previousType = null;
  if (session) setType(session, restore);
}

/** Test hook. */
export function resetAudioSessionState(): void {
  active = false;
  previousType = null;
}
