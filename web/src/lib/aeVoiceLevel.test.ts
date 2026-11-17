import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getVoiceBins,
  publishVoiceBins,
  resetVoiceBins,
  subscribeVoiceBins,
  syntheticVoiceBins,
  VOICE_BIN_COUNT,
} from "./aeVoiceLevel";

afterEach(() => resetVoiceBins());

describe("aeVoiceLevel", () => {
  it("stores byte data as 0 to 1 and clamps", () => {
    publishVoiceBins(Uint8Array.from([255, 51, 0]));
    const bins = getVoiceBins();
    expect(bins.length).toBe(VOICE_BIN_COUNT);
    expect(bins[0]).toBe(1);
    expect(bins[1]).toBeCloseTo(0.2);
    expect(bins[2]).toBe(0);
    publishVoiceBins([999, Number.NaN]);
    expect(getVoiceBins()[0]).toBe(1);
    expect(getVoiceBins()[1]).toBe(0);
  });

  it("notifies subscribers on write and reset, and stops after unsubscribe", () => {
    const cb = vi.fn();
    const off = subscribeVoiceBins(cb);
    publishVoiceBins([10]);
    resetVoiceBins();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(getVoiceBins()[0]).toBe(0);
    off();
    publishVoiceBins([10]);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe("syntheticVoiceBins", () => {
  it("is silent at level 0 and bumps the voice range at level 1, all within bytes", () => {
    expect(Array.from(syntheticVoiceBins(0, 123)).every((v) => v === 0)).toBe(true);
    const loud = syntheticVoiceBins(1, 123);
    expect(loud).toHaveLength(VOICE_BIN_COUNT);
    expect(Math.max(...loud)).toBeGreaterThan(120);
    expect(loud[6]).toBeGreaterThan(loud[VOICE_BIN_COUNT - 1]);
  });

  it("scales with the level, moves with time, and survives a bad level", () => {
    const quiet = syntheticVoiceBins(0.2, 0);
    const loud = syntheticVoiceBins(0.8, 0);
    expect(quiet.reduce((a, b) => a + b, 0)).toBeLessThan(loud.reduce((a, b) => a + b, 0));
    expect(Array.from(syntheticVoiceBins(0.8, 500))).not.toEqual(Array.from(loud));
    expect(Array.from(syntheticVoiceBins(Number.NaN, 0)).every((v) => v === 0)).toBe(true);
  });
});
