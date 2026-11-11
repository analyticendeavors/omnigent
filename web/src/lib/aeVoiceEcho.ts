// Echo guard for Voice mode: the speaker's own voice, heard back by the mic, must never
// count as the person talking. Keeps the text of this turn's spoken sentences while audio
// really plays, plus a short tail after it stops, and splits heard text into echo and new words.

/** How long after playback stops the spoken text still counts as a possible echo. */
export const ECHO_TAIL_MS = 1500;
/** New words needed before heard text counts as the person's own speech. */
export const ECHO_MIN_NEW_WORDS = 2;
/** A heard run this long that matches a run in the spoken text is echo. */
export const ECHO_MIN_RUN = 3;

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export interface EchoSplit {
  /** Heard words (as written) that are not part of an echoed run. */
  fresh: string[];
  /** True when the heard text has enough new words to be the person's own speech. */
  person: boolean;
}

/** Whether `run` appears as a contiguous run in `spoken`. */
function hasRun(spoken: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0) return false;
  for (let i = 0; i + run.length <= spoken.length; i++) {
    if (run.every((w, j) => spoken[i + j] === w)) return true;
  }
  return false;
}

/**
 * Splits heard text against the spoken words. Echo is a contiguous run of 3 or more heard
 * words found in the spoken text (a heard text of 1 or 2 words only when it is such a run
 * whole); a word that merely also appears in the reply stays.
 */
export function splitEcho(heard: string, spoken: readonly string[]): EchoSplit {
  const tokens = heard.split(/\s+/).filter(Boolean);
  const units: { word: string; token: number }[] = [];
  tokens.forEach((t, token) => {
    for (const word of normalizeWords(t)) units.push({ word, token });
  });
  const words = units.map((u) => u.word);
  const echo = new Array<boolean>(units.length).fill(false);
  if (words.length > 0 && words.length < ECHO_MIN_RUN) {
    if (hasRun(spoken, words)) echo.fill(true);
  } else {
    for (let start = 0; start < words.length; start++) {
      // The longest echoed run starting here.
      let end = start;
      while (end < words.length && hasRun(spoken, words.slice(start, end + 1))) end++;
      if (end - start >= ECHO_MIN_RUN) {
        for (let k = start; k < end; k++) echo[k] = true;
        start = end - 1;
      }
    }
  }
  const keep = new Set<number>();
  units.forEach((u, i) => {
    if (!echo[i]) keep.add(u.token);
  });
  const fresh = tokens.filter((_, token) => keep.has(token));
  const newWords = echo.filter((e) => !e).length;
  return { fresh, person: newWords >= ECHO_MIN_NEW_WORDS };
}

// The window: sentences spoken since audio really started playing. Captions that arrive
// before the playing signal wait in `pending` and open the window when playback starts.
let windowText = "";
let pendingText = "";
let playing = false;
let stoppedAt: number | null = null;

/** A sentence is being spoken: it joins this turn's spoken text. */
export function recordSpoken(text: string): void {
  if (text.trim() === "") return;
  if (playing) windowText = `${windowText} ${text}`.trim();
  else pendingText = `${pendingText} ${text}`.trim();
}

/** Audio really started or stopped playing. A start opens a fresh window; a stop starts the tail. */
export function notePlayback(isPlaying: boolean, now: number = Date.now()): void {
  if (isPlaying === playing) return;
  if (isPlaying) {
    windowText = pendingText;
    pendingText = "";
    playing = true;
    stoppedAt = null;
  } else {
    playing = false;
    stoppedAt = now;
    pendingText = "";
  }
}

/** The spoken words that can still echo: while playing, and for the tail after. */
export function activeEchoWords(now: number = Date.now()): readonly string[] | null {
  if (!playing && (stoppedAt === null || now - stoppedAt >= ECHO_TAIL_MS)) {
    windowText = "";
    return null;
  }
  return windowText === "" ? null : normalizeWords(windowText);
}

/** Forget everything spoken; for a chat change, an unmount and tests. */
export function resetEcho(): void {
  windowText = "";
  pendingText = "";
  playing = false;
  stoppedAt = null;
}
