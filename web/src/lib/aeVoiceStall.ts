// Voice mode stall detector (omnigent-ae). A Web Speech take can stay "listening" while the
// recognizer has stopped delivering results (WebKit does this after a final). The mic meter
// still hears the user, so the sign of a stall is: sustained speech energy, then a quiet
// spell, and no recognizer result since the speech began. Pure and clock-free: the caller
// passes `now`, so a test can seed levels and time.

/** Speech energy must add up to this long before a quiet spell can count as a stall. */
export const STALL_MIN_SPEECH_MS = 600;
/** Quiet this long after the speech, with no result, is a stall. Browser takes only deliver a
 *  final after a pause, so this is deliberately longer than the usual wait. */
export const STALL_QUIET_MS = 3500;
/** Energy blips further apart than this are noise, not one stretch of speech. */
const STALL_BLIP_RESET_MS = 1500;
/** One animation frame never counts for more than this (a throttled tab is not speech). */
export const MAX_FRAME_MS = 100;
export const MIN_THRESHOLD = 0.12;
export const MAX_THRESHOLD = 0.35;
/** A level that stays this steady for this long is the room, not a person: the floor rises. */
const STEADY_NOISE_MS = 5000;
const FLOOR_RISE_TAU_MS = 2000;
const SLOW_AVG_TAU_MS = 1000;

export interface StallDetector {
  /** One meter frame: the mean level of the voice bins, 0 to 1. */
  feed: (level: number, now: number) => void;
  /** The recognizer produced a result, interim or final. */
  result: (now: number) => void;
  /** Milliseconds since the last result when the take is stalled, else null. Fires once. */
  evaluate: (now: number) => number | null;
  /** The recognizer reported audioend or speechend: the quiet window counts from here. */
  speechEnd: (now: number) => void;
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
  let endSeen: number | null = null;
  let slowAvg = -1;
  let steadyMs = 0;

  const threshold = () => Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, floor * 2 + 0.06));
  const clear = () => {
    aboveMs = 0;
    lastAbove = null;
    endSeen = null;
  };

  return {
    feed(level, now) {
      const dt = lastFeed === 0 ? 0 : Math.min(MAX_FRAME_MS, Math.max(0, now - lastFeed));
      lastFeed = now;
      // Steadiness: how long the level has stayed close to its own slow average.
      if (slowAvg < 0) slowAvg = level;
      const steady = Math.abs(level - slowAvg) <= 0.25 * slowAvg + 0.02;
      steadyMs = steady ? steadyMs + dt : 0;
      slowAvg += (level - slowAvg) * (1 - Math.exp(-dt / SLOW_AVG_TAU_MS));
      if (steadyMs >= STEADY_NOISE_MS && level > floor) {
        // Steady loud sound for seconds is room noise: raise the floor toward it and forget
        // any speech it was counted as.
        floor += (level - floor) * (1 - Math.exp(-dt / FLOOR_RISE_TAU_MS));
        clear();
        return;
      }
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
      const quietFrom = endSeen !== null ? Math.max(lastAbove, endSeen) : lastAbove;
      if (now - quietFrom < STALL_QUIET_MS) return null;
      clear();
      return Math.max(0, now - lastResult);
    },
    speechEnd(now) {
      if (lastAbove !== null) endSeen = now;
    },
    reset(now) {
      lastResult = now;
      lastFeed = 0;
      slowAvg = -1;
      steadyMs = 0;
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
