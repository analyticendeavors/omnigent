// Voice mode stall detector (omnigent-ae). A Web Speech take can stay "listening" while the
// recognizer has stopped delivering results (WebKit does this after a final). The mic meter
// still hears the user, so the sign of a stall is: sustained speech energy, then a quiet
// spell, and no recognizer result since the speech began. Pure and clock-free: the caller
// passes `now`, so a test can seed levels and time.

/** Speech energy must add up to this long before a quiet spell can count as a stall. */
export const STALL_MIN_SPEECH_MS = 600;
/** Quiet this long after the speech, with no result, is a stall. Browser takes only deliver a
 *  final after a pause, so this is deliberately longer than the usual wait. */
export const STALL_QUIET_MS = 2500;
/** Energy blips further apart than this are noise, not one stretch of speech. */
const STALL_BLIP_RESET_MS = 1500;
/** One animation frame never counts for more than this (a throttled tab is not speech). */
const MAX_FRAME_MS = 100;
const MIN_THRESHOLD = 0.12;
const MAX_THRESHOLD = 0.35;

export interface StallDetector {
  /** One meter frame: the mean level of the voice bins, 0 to 1. */
  feed: (level: number, now: number) => void;
  /** The recognizer produced a result, interim or final. */
  result: (now: number) => void;
  /** Milliseconds since the last result when the take is stalled, else null. Fires once. */
  evaluate: (now: number) => number | null;
  /** A new take or a fresh recognizer: forget unanswered speech, keep the noise floor. */
  reset: (now: number) => void;
  /** The level above which the meter counts a frame as speech. */
  threshold: () => number;
}

export function createStallDetector(): StallDetector {
  let floor = 0.03;
  let lastFeed = 0;
  let aboveMs = 0;
  let lastAbove: number | null = null;
  let lastResult = 0;

  const threshold = () => Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, floor * 2 + 0.06));
  const clear = () => {
    aboveMs = 0;
    lastAbove = null;
  };

  return {
    feed(level, now) {
      const dt = lastFeed === 0 ? 0 : Math.min(MAX_FRAME_MS, Math.max(0, now - lastFeed));
      lastFeed = now;
      if (level >= threshold()) {
        aboveMs += dt;
        lastAbove = now;
        return;
      }
      // Quiet frame: the noise floor follows the room, slowly.
      floor += (level - floor) * 0.02;
      if (
        lastAbove !== null &&
        aboveMs < STALL_MIN_SPEECH_MS &&
        now - lastAbove > STALL_BLIP_RESET_MS
      ) {
        clear();
      }
    },
    result(now) {
      lastResult = now;
      clear();
    },
    evaluate(now) {
      if (lastAbove === null || aboveMs < STALL_MIN_SPEECH_MS) return null;
      if (now - lastAbove < STALL_QUIET_MS) return null;
      clear();
      return Math.max(0, now - lastResult);
    },
    reset(now) {
      lastResult = now;
      lastFeed = 0;
      clear();
    },
    threshold,
  };
}

/** iOS (every browser there is WebKit) and desktop Safari. Chrome and Edge are not. */
export function isWebKitSpeech(): boolean {
  try {
    const nav = navigator;
    const ua = nav.userAgent ?? "";
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS asks for the desktop site and says Macintosh.
    if (/Macintosh/.test(ua) && nav.maxTouchPoints > 1) return true;
    return /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/.test(ua);
  } catch {
    return false;
  }
}
