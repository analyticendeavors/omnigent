import { describe, expect, it } from "vitest";
import { binsLevel, newRingState, RING_BARS, replyEnvelopeTarget, stepRing } from "./aeVoiceRing";

const loud = new Float32Array(32).fill(0.8);
const quiet = new Float32Array(32);

describe("aeVoiceRing", () => {
  it("bars rise with mic bins in bars mode and stay flat otherwise", () => {
    const s = newRingState();
    for (let i = 0; i < 40; i += 1) stepRing(s, "bars", i / 60, loud);
    expect(s.bars[0]).toBeGreaterThan(0.5);
    expect(s.barsAlpha).toBeGreaterThan(0.95);
    const t = newRingState();
    for (let i = 0; i < 40; i += 1) stepRing(t, "liquid", i / 60, loud);
    expect(Math.max(...t.bars)).toBeLessThan(0.01);
  });

  it("the bars are mirrored about the vertical axis", () => {
    const s = newRingState();
    const ramp = Float32Array.from({ length: 32 }, (_, i) => i / 40);
    for (let i = 0; i < 40; i += 1) stepRing(s, "bars", i / 60, ramp);
    expect(s.bars[3]).toBeCloseTo(s.bars[RING_BARS - 1 - 3]);
  });

  it("the reply envelope runs only in liquid mode and a pulse lifts it", () => {
    const s = newRingState();
    for (let i = 0; i < 60; i += 1) stepRing(s, "idle", i / 60, quiet);
    expect(s.env).toBeLessThan(0.01);
    for (let i = 0; i < 60; i += 1) stepRing(s, "liquid", i / 60, quiet);
    expect(s.env).toBeGreaterThan(0.2);
    expect(replyEnvelopeTarget(0, 1)).toBeGreaterThan(replyEnvelopeTarget(0, 0));
    expect(replyEnvelopeTarget(1.3, 1)).toBeLessThanOrEqual(1);
  });

  it("binsLevel is the clamped voice-band mean", () => {
    expect(binsLevel(quiet)).toBe(0);
    expect(binsLevel(new Float32Array(32).fill(1))).toBe(1);
  });
});
