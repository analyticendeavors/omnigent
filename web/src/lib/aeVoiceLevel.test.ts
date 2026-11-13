import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getVoiceBins,
  publishVoiceBins,
  resetVoiceBins,
  subscribeVoiceBins,
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
