import { describe, expect, it } from "vitest";
import { createStallDetector, isWebKitSpeech, STALL_QUIET_MS } from "./aeVoiceStall";

function feedFor(
  d: ReturnType<typeof createStallDetector>,
  level: number,
  from: number,
  ms: number,
) {
  let t = from;
  for (; t < from + ms; t += 50) d.feed(level, t);
  return t;
}

describe("stall detector", () => {
  it("fires once after sustained speech and a quiet spell", () => {
    const d = createStallDetector();
    d.reset(0);
    let t = feedFor(d, 0.6, 50, 1000);
    t = feedFor(d, 0.02, t, STALL_QUIET_MS - 200);
    expect(d.evaluate(t)).toBeNull();
    t = feedFor(d, 0.02, t, 400);
    expect(d.evaluate(t)).toBe(t);
    expect(d.evaluate(t + 100)).toBeNull();
  });

  it("a result clears the unanswered speech", () => {
    const d = createStallDetector();
    d.reset(0);
    let t = feedFor(d, 0.6, 50, 1000);
    d.result(t);
    t = feedFor(d, 0.02, t, 4000);
    expect(d.evaluate(t)).toBeNull();
  });

  it("a loud room raises the threshold above its own floor", () => {
    const d = createStallDetector();
    d.reset(0);
    feedFor(d, 0.1, 50, 20_000);
    expect(d.threshold()).toBeGreaterThan(0.12);
  });
});

describe("isWebKitSpeech", () => {
  it("is false in plain jsdom", () => {
    expect(isWebKitSpeech()).toBe(false);
  });
});
