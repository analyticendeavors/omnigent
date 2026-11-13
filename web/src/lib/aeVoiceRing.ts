// Drawing for the Voice ring (omnigent-ae): teal radial bars that rise from the
// circle edge while you talk, an amber liquid ring while Rocky talks. Pure
// functions of a state object, so the component only owns the loop.

import { VOICE_BIN_COUNT } from "@/lib/aeVoiceLevel";

export type VoiceRingMode = "bars" | "liquid" | "idle";

export const RING_BARS = 48;
/** Usable bins: voice sits below about 12 kHz of the 32. */
const USABLE_BINS = 20;

export interface RingColors {
  teal: string;
  amber: string;
}

export interface RingState {
  /** Smoothed bar heights, 0 to 1. */
  bars: Float32Array;
  /** Smoothed synthetic reply envelope, 0 to 1. */
  env: number;
  /** Bump from a new caption sentence, decays on its own. */
  pulse: number;
  /** Eased layer opacities. */
  barsAlpha: number;
  liquidAlpha: number;
}

export function newRingState(): RingState {
  return { bars: new Float32Array(RING_BARS), env: 0, pulse: 0, barsAlpha: 0.3, liquidAlpha: 0.2 };
}

/** Mean voice-band level of the mic bins, 0 to 1. */
export function binsLevel(bins: ArrayLike<number>): number {
  let sum = 0;
  const n = Math.min(USABLE_BINS, bins.length, VOICE_BIN_COUNT);
  for (let i = 1; i < n; i += 1) sum += bins[i];
  return n > 1 ? Math.min(1, (sum / (n - 1)) * 1.6) : 0;
}

/** The synthetic reply envelope: smooth noise plus the sentence bump. */
export function replyEnvelopeTarget(t: number, pulse: number): number {
  return Math.min(
    1,
    0.35 + 0.45 * Math.abs(Math.sin(t * 2.3) * Math.sin(t * 0.9 + 1)) + 0.25 * pulse,
  );
}

/** One animation step; t is seconds. Mutates the state. */
export function stepRing(
  s: RingState,
  mode: VoiceRingMode,
  t: number,
  bins: ArrayLike<number>,
): void {
  // The ring is symmetric about the vertical axis: bar i and its mirror share a bin.
  for (let i = 0; i < RING_BARS; i += 1) {
    const k = i < RING_BARS / 2 ? i : RING_BARS - 1 - i;
    const bin = 1 + Math.floor((k / (RING_BARS / 2)) * (USABLE_BINS - 1));
    const raw = mode === "bars" ? Math.min(0.85, (bins[bin] ?? 0) * 1.5) : 0;
    s.bars[i] += (raw - s.bars[i]) * 0.3;
  }
  const target = mode === "liquid" ? replyEnvelopeTarget(t, s.pulse) : 0;
  s.env += (target - s.env) * 0.12;
  s.pulse *= 0.94;
  const barsTarget = mode === "bars" ? 1 : 0.3;
  const liquidTarget = mode === "liquid" ? 1 : 0.2;
  s.barsAlpha += (barsTarget - s.barsAlpha) * 0.12;
  s.liquidAlpha += (liquidTarget - s.liquidAlpha) * 0.12;
}

/** Sizes in units of the disc radius R. */
const BAR_INNER = 1.275;
const BAR_MAX = 0.55;
const LIQUID_BASE = 1.55;
const LIQUID_AMP = 0.22;
const LIQUID_GAP = 0.1;
/** Half the canvas, in R. */
export const RING_EXTENT = 2.1;
/**
 * The painted ring is drawn at this fraction of R, so its outermost pixel (about
 * 1.9 R for the tallest bars) stays inside the 24 px margin around the 96 px circle
 * and never reaches the label or caption.
 */
export const RING_SCALE = 0.9;

export function drawRing(
  ctx: CanvasRenderingContext2D,
  s: RingState,
  t: number,
  radius: number,
  colors: RingColors,
): void {
  const cx = radius * RING_EXTENT;
  const cy = cx;
  ctx.clearRect(0, 0, cx * 2, cy * 2);
  const R = radius * RING_SCALE;
  const spin = t * 0.25;
  ctx.lineCap = "round";
  ctx.strokeStyle = colors.teal;
  ctx.globalAlpha = s.barsAlpha;
  ctx.lineWidth = Math.max(2, R * 0.075);
  for (let i = 0; i < RING_BARS; i += 1) {
    const a = spin + (i / RING_BARS) * Math.PI * 2;
    const r0 = R * BAR_INNER;
    const r1 = r0 + 2 + s.bars[i] * R * BAR_MAX;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.stroke();
  }
  ctx.strokeStyle = colors.amber;
  for (let layer = 0; layer < 2; layer += 1) {
    ctx.beginPath();
    const steps = 120;
    for (let j = 0; j <= steps; j += 1) {
      const b = (j / steps) * Math.PI * 2;
      const wob = Math.sin(b * 5 + t * (layer ? -1.6 : 2.1)) * 0.5 + Math.sin(b * 3 - t) * 0.5;
      const rr =
        R * (LIQUID_BASE + layer * LIQUID_GAP) + s.env * R * LIQUID_AMP * (0.6 + 0.4 * wob);
      const x = cx + Math.cos(b) * rr;
      const y = cy + Math.sin(b) * rr;
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.globalAlpha = s.liquidAlpha * (layer ? 0.38 : 1);
    ctx.lineWidth = layer ? Math.max(1.5, R * 0.05) : Math.max(2, R * 0.065);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Reduced motion: one still circle whose colour and brightness carry the mode. It never changes between mode changes. */
export function drawStaticRing(
  ctx: CanvasRenderingContext2D,
  mode: VoiceRingMode,
  radius: number,
  colors: RingColors,
): void {
  const cx = radius * RING_EXTENT;
  ctx.clearRect(0, 0, cx * 2, cx * 2);
  const R = radius * RING_SCALE;
  ctx.beginPath();
  ctx.arc(cx, cx, R * (mode === "liquid" ? LIQUID_BASE : BAR_INNER + 0.1), 0, Math.PI * 2);
  ctx.strokeStyle = mode === "liquid" ? colors.amber : colors.teal;
  ctx.lineWidth = Math.max(2, R * 0.07);
  ctx.globalAlpha = mode === "idle" ? 0.25 : mode === "liquid" ? 0.9 : 0.65;
  ctx.stroke();
  ctx.globalAlpha = 1;
}
