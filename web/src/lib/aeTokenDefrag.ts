// Token defrag (omnigent-ae, 2026-10-18): while a conversation compacts, the
// composer tray shows message pills hopping left and melting into summary pills,
// then pouring into the context ring; a click opens a Win98-style defragmenter.
// The motion models are pure so they can be tested without a browser.

import { useSyncExternalStore } from "react";
import type { AnyBlock } from "@/lib/blocks";

// ── Preference: per device, on unless switched off ──────────────────────

export const AE_TOKEN_DEFRAG_KEY = "ae.tokenDefrag";
const prefListeners = new Set<() => void>();

/** Whether the animation is on; anything but a stored "off" means on. */
export function readAeTokenDefrag(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(AE_TOKEN_DEFRAG_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeAeTokenDefrag(on: boolean): void {
  try {
    window.localStorage.setItem(AE_TOKEN_DEFRAG_KEY, on ? "on" : "off");
  } catch {
    // A failed write keeps the stored value; the switch reads it back.
  }
  for (const listener of prefListeners) listener();
}

function subscribePref(listener: () => void): () => void {
  prefListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === AE_TOKEN_DEFRAG_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    prefListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAeTokenDefragEnabled(): boolean {
  return useSyncExternalStore(subscribePref, readAeTokenDefrag, () => true);
}

// ── Where compaction stands, read from the store's blocks ───────────────

/** The key `buildBubbles` gives a compaction bubble built from `blocks[index]`. */
export function aeCompactionBubbleKey(block: AnyBlock, index: number): string {
  return block.ctx.itemId ?? `compaction_${index}`;
}

/** A loading block further back than this is a stranded one, not a running compaction. */
export const AE_DEFRAG_SCAN_LIMIT = 400;

const phaseCache = new WeakMap<readonly AnyBlock[], string>();

/**
 * Whether a compaction is on screen, as a string so a store selector re-renders
 * only when it changes: `run:<start epoch s>` while a loading block is newer than
 * the last marker, else `idle`. The store keeps loading blocks after completion
 * (only the bubbles drop them), so the newest marker, not "any loading block",
 * decides. How a run ends comes from the stream's events, not from the blocks,
 * which a reconnect swaps for history. Cached per blocks array.
 */
export function aeCompactionPhase(blocks: readonly AnyBlock[]): string {
  const cached = phaseCache.get(blocks);
  if (cached !== undefined) return cached;
  let running = false;
  let start: number | null = null;
  for (let i = blocks.length - 1; i >= Math.max(0, blocks.length - AE_DEFRAG_SCAN_LIMIT); i -= 1) {
    const block = blocks[i];
    if (block.type === "compaction") break;
    if (block.type === "compaction_loading") {
      running = true;
      const at = block.startedAtS ?? block.ctx.clientCreatedAtS ?? null;
      if (at !== null && (start === null || at < start)) start = at;
    }
  }
  const phase = running ? `run:${start ?? ""}` : "idle";
  phaseCache.set(blocks, phase);
  return phase;
}

export type AeCompactionPhase = { kind: "idle" } | { kind: "running"; startedAtS: number | null };

export function parseAeCompactionPhase(phase: string): AeCompactionPhase {
  if (!phase.startsWith("run:")) return { kind: "idle" };
  const at = Number.parseFloat(phase.slice(4));
  return { kind: "running", startedAtS: Number.isFinite(at) ? at : null };
}

const stampCache = new WeakMap<readonly AnyBlock[], Map<string, number>>();

/**
 * The creation stamp of every marker this page saw land, by the key `buildBubbles`
 * gives its bubble. A marker loaded from history carries no live stamp. Cached
 * per blocks array, so every mounted marker shares one pass.
 */
export function aeLiveMarkerStamps(blocks: readonly AnyBlock[]): Map<string, number> {
  const cached = stampCache.get(blocks);
  if (cached) return cached;
  const stamps = new Map<string, number>();
  blocks.forEach((block, index) => {
    const at = block.ctx.clientCreatedAtS;
    if (block.type === "compaction" && at !== undefined) {
      stamps.set(aeCompactionBubbleKey(block, index), at);
    }
  });
  stampCache.set(blocks, stamps);
  return stamps;
}

/** Compaction reports only its start and finish, so progress is a time estimate. */
export const AE_DEFRAG_TAU_MS = 40_000;

/** Past this, a run with no finish or failure is given up (a dropped stream). */
export const AE_DEFRAG_STALE_MS = 15 * 60_000;

/** Eases toward 97%, so the last pills wait for the real finish. */
export function aeDefragEstimate(elapsedMs: number, tauMs = AE_DEFRAG_TAU_MS): number {
  if (!(elapsedMs > 0)) return 0;
  return 0.97 * (1 - Math.exp(-elapsedMs / tauMs));
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

// ── The pill strip: one pill hops at a time, docks, and melts in ────────

/** System prompt, system tools, MCP tools, memory files, skills: never moved. */
export const AE_DEFRAG_FIXED = [
  { category: "System prompt", width: 10 },
  { category: "System tools", width: 18 },
  { category: "MCP tools", width: 9 },
  { category: "Memory files", width: 13 },
  { category: "Skills", width: 6 },
] as const;
export const AE_DEFRAG_MESSAGES = 40;
const GAP = 3;
const SLOTS = 4;
const SLOT_MAX = 24;
const SPEED_PX_PER_MS = 0.9;
const BEAT_MS = 200;
const FINISH_BEAT_MS = 60;
const MELT_PX_PER_MS = 0.08;
const FINISH_MELT_PX_PER_MS = 0.3;
const HOP_PX = 5;

export interface AeDefragPill {
  id: number;
  kind: "fixed" | "message" | "summary";
  /** Index into AE_DEFRAG_FIXED for a fixed pill. */
  tone: number;
  x: number;
  y: number;
  w: number;
  /** A message's width before melting; the width a summary grows toward. */
  w0: number;
  flying: boolean;
  docked: boolean;
  gone: boolean;
  /** Flight progress (0 to 1), its length, and where it took off. */
  t: number;
  flightMs: number;
  fromX: number;
}

export interface AeDefragStrip {
  fixed: AeDefragPill[];
  messages: AeDefragPill[];
  summaries: AeDefragPill[];
  flying: AeDefragPill[];
  dock: AeDefragPill[];
  x0: number;
  perSlot: number;
  next: number;
  beatMs: number;
  absorbed: number;
  nextId: number;
}

export interface AeDefragStep {
  /** Message pills that took off this step (their origin gets an outline). */
  launched: AeDefragPill[];
  /** Summary pills that took in a whole message this step (they pulse). */
  landed: AeDefragPill[];
}

function addPill(
  strip: AeDefragStrip,
  kind: AeDefragPill["kind"],
  x: number,
  w: number,
  tone = 0,
): AeDefragPill {
  const pill: AeDefragPill = {
    id: strip.nextId,
    kind,
    tone,
    x,
    y: 0,
    w,
    w0: w,
    flying: false,
    docked: false,
    gone: false,
    t: 0,
    flightMs: 0,
    fromX: x,
  };
  strip.nextId += 1;
  return pill;
}

export function aeCreateDefragStrip(seed = 5): AeDefragStrip {
  const strip: AeDefragStrip = {
    fixed: [],
    messages: [],
    summaries: [],
    flying: [],
    dock: [],
    x0: 0,
    perSlot: AE_DEFRAG_MESSAGES / SLOTS,
    next: 0,
    beatMs: 0,
    absorbed: 0,
    nextId: 1,
  };
  let x = 0;
  AE_DEFRAG_FIXED.forEach(({ width }, tone) => {
    strip.fixed.push(addPill(strip, "fixed", x, width, tone));
    x += width + GAP;
  });
  strip.x0 = x + 3;
  const random = seededRandom(seed);
  x = strip.x0;
  for (let i = 0; i < AE_DEFRAG_MESSAGES; i += 1) {
    if (random() < 0.24) x += 6 + Math.round(random() * 10);
    const width = 8 + Math.round(random() * 4);
    strip.messages.push(addPill(strip, "message", x, width));
    x += width + GAP;
  }
  return strip;
}

function slotX(strip: AeDefragStrip, slot: number): number {
  return strip.x0 + slot * (SLOT_MAX + GAP);
}

function currentSlot(strip: AeDefragStrip): number {
  return Math.min(Math.floor(strip.absorbed / strip.perSlot), SLOTS - 1);
}

/** A slot's width for `units` messages taken in: 6 px for the first, then 2 px each. */
function slotWidth(strip: AeDefragStrip, units: number): number {
  if (units <= 1) return 6 * Math.max(0, units);
  return Math.min(SLOT_MAX, 6 + ((units - 1) * (SLOT_MAX - 6)) / (strip.perSlot - 1));
}

function summaryFor(strip: AeDefragStrip, slot: number): AeDefragPill {
  let pill = strip.summaries[slot];
  if (!pill) {
    pill = addPill(strip, "summary", slotX(strip, slot), 0);
    strip.summaries[slot] = pill;
  }
  return pill;
}

/** Where the next arrival lines up: behind the last docked pill, else at the seam. */
function tailX(strip: AeDefragStrip): number {
  const last = strip.dock[strip.dock.length - 1];
  if (last) return last.x + last.w + GAP;
  const summary = summaryFor(strip, currentSlot(strip));
  return summary.x + summary.w;
}

function takeIn(strip: AeDefragStrip, slot: number, summary: AeDefragPill, step: AeDefragStep) {
  strip.absorbed += 1;
  summary.w0 = slotWidth(strip, strip.absorbed - slot * strip.perSlot);
  step.landed.push(summary);
}

/**
 * Advance the strip by `dtMs`. While fewer than `target` messages have left, one
 * takes off per beat, hops over the others, lines up at the end of the summary
 * pill, and the head of the line melts in as the summary grows by the same
 * amount. `instant` (reduced motion) takes a launched pill in on the spot.
 */
export function aeStepDefragStrip(
  strip: AeDefragStrip,
  dtMs: number,
  target: number,
  finishing: boolean,
  instant = false,
): AeDefragStep {
  const step: AeDefragStep = { launched: [], landed: [] };
  const beatMs = finishing ? FINISH_BEAT_MS : BEAT_MS;
  strip.beatMs = Math.min(strip.beatMs + dtMs, beatMs);
  if (strip.next < Math.min(target, strip.messages.length) && strip.beatMs >= beatMs) {
    strip.beatMs = 0;
    const pill = strip.messages[strip.next];
    strip.next += 1;
    step.launched.push(pill);
    if (instant) {
      const slot = currentSlot(strip);
      const summary = summaryFor(strip, slot);
      pill.gone = true;
      takeIn(strip, slot, summary, step);
      summary.w = summary.w0;
    } else {
      pill.flying = true;
      pill.t = 0;
      pill.fromX = pill.x;
      const speed = finishing ? SPEED_PX_PER_MS * 2 : SPEED_PX_PER_MS;
      pill.flightMs = Math.max(200, Math.min(650, Math.abs(pill.x - tailX(strip)) / speed));
      strip.flying.push(pill);
    }
  }

  // Summaries grow first, so the seam the dock measures is this frame's.
  for (const summary of strip.summaries) {
    if (summary) summary.w += (summary.w0 - summary.w) * Math.min(1, dtMs / 70);
  }

  let slot = currentSlot(strip);
  let summary = summaryFor(strip, slot);
  let seam = summary.x + summary.w;
  const melt = finishing ? FINISH_MELT_PX_PER_MS : MELT_PX_PER_MS;
  for (let i = 0; i < strip.dock.length; i += 1) {
    const pill = strip.dock[i];
    const ahead = strip.dock[i - 1];
    const to = ahead ? ahead.x + ahead.w + GAP : seam;
    pill.x += (to - pill.x) * Math.min(1, dtMs / 45);
    if (i !== 0 || Math.abs(pill.x - seam) >= 0.8) continue;
    pill.x = seam;
    pill.w -= melt * dtMs;
    const melted = Math.min(1, 1 - pill.w / pill.w0);
    summary.w0 = slotWidth(strip, strip.absorbed - slot * strip.perSlot + melted);
    if (pill.w > 0.3) continue;
    pill.w = 0;
    pill.gone = true;
    pill.docked = false;
    strip.dock.shift();
    i -= 1;
    takeIn(strip, slot, summary, step);
    if (strip.absorbed % strip.perSlot === 0 && strip.absorbed < strip.messages.length) {
      slot = currentSlot(strip);
      summary = summaryFor(strip, slot);
      seam = summary.x + summary.w;
    }
  }

  let aim = tailX(strip);
  for (let j = 0; j < strip.flying.length; j += 1) {
    const pill = strip.flying[j];
    const pillAim = aim;
    aim += pill.w + GAP;
    pill.t = Math.min(1, pill.t + dtMs / pill.flightMs);
    const want = pill.fromX + (pillAim - pill.fromX) * easeInOut(pill.t);
    pill.x += (want - pill.x) * Math.min(1, dtMs / 22);
    pill.y = -HOP_PX * Math.sin(Math.PI * pill.t);
    if (pill.t >= 1 && Math.abs(pill.x - pillAim) < 1.5) {
      pill.flying = false;
      pill.docked = true;
      pill.y = 0;
      strip.flying.splice(j, 1);
      j -= 1;
      strip.dock.push(pill);
    }
  }
  return step;
}

/** Nothing in the air, nothing docked, and every summary at its width: a frame would change nothing. */
export function aeDefragStripResting(strip: AeDefragStrip): boolean {
  return (
    strip.flying.length === 0 &&
    strip.dock.length === 0 &&
    strip.summaries.every((summary) => !summary || Math.abs(summary.w0 - summary.w) < 0.05)
  );
}

export function aeDefragStripDrained(strip: AeDefragStrip): boolean {
  return (
    strip.next >= strip.messages.length && strip.flying.length === 0 && strip.dock.length === 0
  );
}

/** Share shown, 0 to 1: messages taken in plus the melted part of the one melting. */
export function aeDefragShown(strip: AeDefragStrip): number {
  const head = strip.dock[0];
  const melted = head && head.w < head.w0 ? Math.max(0, Math.min(1, 1 - head.w / head.w0)) : 0;
  return Math.min(1, (strip.absorbed + melted) / strip.messages.length);
}

// ── The hidden window's cluster map ─────────────────────────────────────

export type AeDefragCell =
  "unmovable" | "summary" | "writing" | "reading" | "free" | "message" | "buffer";

export interface AeDefragMap {
  cells: AeDefragCell[];
  /** Indexes of the message cells, in reading order. */
  messages: number[];
  consumed: number;
  write: number;
  reading: number[];
  writing: number[];
}

export const AE_DEFRAG_MAP_COLUMNS = 40;
export const AE_DEFRAG_MAP_ROWS = 14;
const MAP_UNMOVABLE = 34;
const MAP_BUFFER = 36;
const MAP_READS_PER_WRITE = 6;

export function aeCreateDefragMap(seed = 11): AeDefragMap {
  const random = seededRandom(seed);
  const total = AE_DEFRAG_MAP_COLUMNS * AE_DEFRAG_MAP_ROWS;
  const cells: AeDefragCell[] = [];
  const messages: number[] = [];
  for (let i = 0; i < total; i += 1) {
    let cell: AeDefragCell = "message";
    if (i < MAP_UNMOVABLE) cell = "unmovable";
    else if (i >= total - MAP_BUFFER) cell = "buffer";
    else if (random() < 0.22) cell = "free";
    if (cell === "message") messages.push(i);
    cells.push(cell);
  }
  return { cells, messages, consumed: 0, write: MAP_UNMOVABLE, reading: [], writing: [] };
}

/**
 * One tick: last tick's reads become free and its writes become summary, then
 * cells are read up to `target`, with one summary cell written per six read.
 * Returns the indexes whose cell changed.
 */
export function aeTickDefragMap(map: AeDefragMap, target: number): number[] {
  const changed: number[] = [];
  const set = (index: number, cell: AeDefragCell) => {
    if (map.cells[index] === cell) return;
    map.cells[index] = cell;
    changed.push(index);
  };
  for (const index of map.reading) set(index, "free");
  for (const index of map.writing) set(index, "summary");
  map.reading = [];
  map.writing = [];
  const total = map.messages.length;
  while (map.consumed < Math.min(target, total)) {
    const index = map.messages[map.consumed];
    map.consumed += 1;
    set(index, "reading");
    map.reading.push(index);
    if (map.consumed % MAP_READS_PER_WRITE === 0 || map.consumed === total) {
      set(map.write, "writing");
      map.writing.push(map.write);
      map.write += 1;
    }
  }
  return changed;
}

// ── The context ring: held while the pills land, then a pulse ───────────

interface RingDisplay {
  hold: number | null;
  pulse: boolean;
}

let ringDisplay: RingDisplay = { hold: null, pulse: false };
let pulseTimer: ReturnType<typeof setTimeout> | null = null;
const ringListeners = new Set<() => void>();

function setRingDisplay(next: RingDisplay) {
  ringDisplay = next;
  for (const listener of ringListeners) listener();
}

/** Keep the composer ring at `tokens` until released with `null`. */
export function aeHoldContextRing(tokens: number | null): void {
  if (ringDisplay.hold !== tokens) setRingDisplay({ ...ringDisplay, hold: tokens });
}

/** A short pulse as the pills pour into the ring. */
export function aePulseContextRing(): void {
  if (pulseTimer !== null) clearTimeout(pulseTimer);
  setRingDisplay({ ...ringDisplay, pulse: true });
  pulseTimer = setTimeout(() => {
    pulseTimer = null;
    setRingDisplay({ ...ringDisplay, pulse: false });
  }, 260);
}

function subscribeRing(listener: () => void): () => void {
  ringListeners.add(listener);
  return () => ringListeners.delete(listener);
}

const readRing = () => ringDisplay;

/** The token count the composer ring shows (the held one while held) and its pulse. */
export function useAeContextRingDisplay(tokensUsed: number | null): {
  tokens: number | null;
  pulse: boolean;
} {
  const display = useSyncExternalStore(subscribeRing, readRing, readRing);
  return { tokens: display.hold ?? tokensUsed, pulse: display.pulse };
}

// ── Before and after counts for the compaction marker ───────────────────

export interface AeCompactionTotals {
  before: number;
  after: number;
}

interface NotedTotals {
  /** Epoch seconds, floored like a live block's `clientCreatedAtS`. */
  notedAtS: number;
  /** `null` for a compaction that reported no counts. */
  totals: AeCompactionTotals | null;
}

/** How many compactions each conversation's stream finished or failed on this page. */
export interface AeCompactionCounts {
  completed: number;
  failed: number;
}

const NO_COUNTS: AeCompactionCounts = { completed: 0, failed: 0 };
const compactionCounts = new Map<string, AeCompactionCounts>();
/** Recent compactions per conversation, oldest first. */
const notedTotals = new Map<string, NotedTotals[]>();
const NOTED_KEEP = 32;
const totalsListeners = new Set<() => void>();
let totalsVersion = 0;

function countEnd(conversationId: string, end: keyof AeCompactionCounts): void {
  const counts = compactionCounts.get(conversationId) ?? NO_COUNTS;
  compactionCounts.set(conversationId, { ...counts, [end]: counts[end] + 1 });
  totalsVersion += 1;
  for (const listener of totalsListeners) listener();
}

/** Record a compaction the stream reported as failed. Called from the stream tap. */
export function aeNoteCompactionFailed(conversationId: string): void {
  countEnd(conversationId, "failed");
}

export function aeCompactionCountsFor(conversationId: string | null): AeCompactionCounts {
  return conversationId === null ? NO_COUNTS : (compactionCounts.get(conversationId) ?? NO_COUNTS);
}

/** The completed and failed counts for `conversationId`, re-rendering when either moves. */
export function useAeCompactionCounts(conversationId: string | null): AeCompactionCounts {
  return useSyncExternalStore(
    subscribeAeCompactionTotals,
    () => aeCompactionCountsFor(conversationId),
    () => NO_COUNTS,
  );
}

/**
 * Record a finished compaction's counts. Called from the stream tap on
 * `compaction_completed`, before the store replaces `tokensUsed` with the new
 * total (so `before` is the last count the ring showed) and before its marker
 * block exists. A completion without both counts still takes a slot, so its
 * marker shows none rather than an older compaction's.
 */
export function aeNoteCompactionTotals(
  conversationId: string,
  before: number | null | undefined,
  after: number | null | undefined,
): void {
  const counted =
    before != null && after != null && Number.isFinite(before) && Number.isFinite(after);
  const list = notedTotals.get(conversationId) ?? [];
  list.push({
    notedAtS: Math.floor(Date.now() / 1000),
    totals: counted ? { before, after } : null,
  });
  if (list.length > NOTED_KEEP) list.splice(0, list.length - NOTED_KEEP);
  notedTotals.set(conversationId, list);
  countEnd(conversationId, "completed");
}

/** The counts of the conversation's latest compaction, for the window's completion box. */
export function aeNotedCompactionTotals(conversationId: string | null): AeCompactionTotals | null {
  if (conversationId === null) return null;
  const list = notedTotals.get(conversationId);
  return list?.[list.length - 1]?.totals ?? null;
}

/**
 * The counts for a marker whose live block was created at `createdAtS`: the latest
 * compaction noted at or before then, since each is noted just before its marker
 * lands. Needs no rendering, so an off-screen marker keeps its counts; a marker
 * loaded from history has no live stamp and shows none.
 */
export function aeCompactionTotalsFor(
  conversationId: string,
  createdAtS: number | null | undefined,
): AeCompactionTotals | null {
  if (createdAtS == null) return null;
  const list = notedTotals.get(conversationId) ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].notedAtS <= createdAtS) return list[i].totals;
  }
  return null;
}

export function subscribeAeCompactionTotals(listener: () => void): () => void {
  totalsListeners.add(listener);
  return () => totalsListeners.delete(listener);
}

export function aeCompactionTotalsVersion(): number {
  return totalsVersion;
}

/** Test hook: clear the ring hold, the pulse and every recorded count. */
export function resetAeTokenDefrag(): void {
  if (pulseTimer !== null) clearTimeout(pulseTimer);
  pulseTimer = null;
  ringDisplay = { hold: null, pulse: false };
  compactionCounts.clear();
  notedTotals.clear();
  totalsVersion = 0;
}
