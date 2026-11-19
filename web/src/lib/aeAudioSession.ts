// Safari Audio Session API (navigator.audioSession, Safari 16.4+ and iOS 17+).
// On iOS, playing the cloud voice on an <audio> element switches the page's audio session to
// playback, and WebKit speech recognition never switches it back, so every later mic start hears
// "No speech detected". While Voice mode is on, the session is pinned to "play-and-record".
// WebKit only, feature-detected, and a no-op everywhere else. Nothing here throws.

import { getMicStream, micConstraint } from "./aeAudioDevices";
import { logVoice } from "./aeVoiceLog";
import { isWebKitSpeech } from "./aeVoiceStall";

interface AudioSessionLike {
  type: string;
  state?: string;
  addEventListener?: (type: "statechange", listener: () => void) => void;
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
  sessionMayBeInactive = false;
  stateListenerInstalled = false;
}

// iOS 18 WebKit sets the audio session inactive when an <audio> clip longer than about 0.95 s
// ends, and webkitSpeechRecognition never reactivates it, so the next recognizer start hears
// nothing. Every resolved getUserMedia({ audio }) reactivates it, so a throwaway mic stream
// right before the start puts the session back.
let sessionMayBeInactive = false;
let stateListenerInstalled = false;
/** The longest a reactivation may take before the recognizer starts anyway. */
export const REACTIVATE_TIMEOUT_MS = 1500;

/** A long clip just ended: the next mic start needs a reactivation first. */
export function markSessionMayBeInactive(): void {
  sessionMayBeInactive = true;
}

/** Whether the next mic start will reactivate the audio session first. */
export function reactivationPending(): boolean {
  return sessionMayBeInactive && isWebKitSpeech();
}

/** The Audio Session API state ("active", "inactive", ...), or "none" where it is missing. */
export function audioSessionState(): string {
  const session = getSession();
  if (!session || typeof session.state !== "string") return "none";
  return session.state;
}

function watchSessionState(): void {
  if (stateListenerInstalled) return;
  const session = getSession();
  if (!session || typeof session.addEventListener !== "function") return;
  stateListenerInstalled = true;
  try {
    session.addEventListener("statechange", () => {
      logVoice(`audio session state ${audioSessionState()}`);
    });
  } catch {
    // Observation only.
  }
}

/**
 * Before a WebKit recognizer start: when a long clip may have deactivated the audio session,
 * open a throwaway mic stream and stop its tracks at once. Never throws; a timeout or a refusal
 * is logged and the start goes on.
 */
export async function reactivateAudioSessionForMic(): Promise<boolean> {
  if (!sessionMayBeInactive || !isWebKitSpeech()) return false;
  watchSessionState();
  logVoice(`audio session state before reactivate ${audioSessionState()}`);
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const open = getMicStream(micConstraint() ?? true).then((stream) => {
      stream.getTracks().forEach((track) => track.stop());
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), REACTIVATE_TIMEOUT_MS);
    });
    // A stream that arrives after the timeout is still stopped by the handler above.
    await Promise.race([open, timeout]);
    sessionMayBeInactive = false;
    logVoice("reactivate ok", `${Date.now() - t0} ms`);
    return true;
  } catch (err) {
    const msg = (err as { message?: string; name?: string } | null)?.message ?? "error";
    logVoice(`reactivate failed ${msg}`);
    return false;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
