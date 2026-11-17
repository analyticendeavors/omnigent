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

/** A soundstart counts as speech only when the sound lasted this long before its soundend. */
export const EVENT_HEARD_MIN_SOUND_MS = 600;
/** Speech heard and no result this long after the last sound or speech event is a stall, even
 *  when no soundend, speechend or audioend ever came (a recognizer that hung mid-take). */
export const EVENT_NO_END_STALL_MS = 6000;

/**
 * The stall detector for a take with no level meter (the meter is off): the recognizer's own
 * events are the only signal. "Heard" means a speechstart, or a soundstart that lasted at least
 * EVENT_HEARD_MIN_SOUND_MS before its soundend (a cough or a click is not speech). A stall is
 * speech heard and then either STALL_QUIET_MS with no result after a soundend, speechend or
 * audioend, or EVENT_NO_END_STALL_MS with no result after the last sound or speech event when no
 * end event came. It never reads audio levels.
 */
export interface EventStallDetector {
  /** speechstart: the recognizer heard speech. */
  speechStart: (now: number) => void;
  /** soundstart: not speech until it has lasted long enough (see soundEnd). */
  soundStart: (now: number) => void;
  /** soundend: a sound that lasted EVENT_HEARD_MIN_SOUND_MS counts as heard. */
  soundEnd: (now: number) => void;
  /** speechend or audioend. */
  ended: (now: number) => void;
  /** A result, interim or final. */
  result: (now: number) => void;
  /** Milliseconds since the last result when stalled, else null. Fires once. */
  evaluate: (now: number) => number | null;
  /** A new take or a fresh recognizer. */
  reset: (now: number) => void;
}

export function createEventStallDetector(): EventStallDetector {
  let heardAt: number | null = null;
  let endAt: number | null = null;
  let soundAt: number | null = null;
  let lastEventAt = 0;
  let lastResult = 0;
  const clear = () => {
    heardAt = null;
    endAt = null;
    soundAt = null;
  };
  return {
    speechStart(now) {
      heardAt = now;
      endAt = null;
      lastEventAt = now;
    },
    soundStart(now) {
      soundAt = now;
      endAt = null;
      lastEventAt = now;
    },
    soundEnd(now) {
      lastEventAt = now;
      const started = soundAt;
      soundAt = null;
      if (started !== null && now - started >= EVENT_HEARD_MIN_SOUND_MS) {
        heardAt = started;
        endAt = now;
      } else if (heardAt !== null) {
        endAt = now;
      }
    },
    ended(now) {
      lastEventAt = now;
      if (heardAt !== null) endAt = now;
    },
    result(now) {
      lastResult = now;
      clear();
    },
    evaluate(now) {
      if (heardAt === null) return null;
      const quietAfterEnd = endAt !== null && now - endAt >= STALL_QUIET_MS;
      const hungNoEnd = now - lastEventAt >= EVENT_NO_END_STALL_MS;
      if (!quietAfterEnd && !hungNoEnd) return null;
      clear();
      return Math.max(0, now - lastResult);
    },
    reset(now) {
      lastResult = now;
      lastEventAt = now;
      clear();
    },
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
