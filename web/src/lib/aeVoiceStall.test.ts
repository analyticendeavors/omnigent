import { afterEach, describe, expect, it } from "vitest";
import {
  createEventStallDetector,
  EVENT_HEARD_MIN_SOUND_MS,
  EVENT_NO_END_STALL_MS,
  EVENT_OPEN_SPEECH_STALL_MS,
  createStallDetector,
  isWebKitSpeech,
  MAX_FRAME_MS,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  STALL_MIN_SPEECH_MS,
  STALL_QUIET_MS,
} from "./aeVoiceStall";

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

  it("steady 0.2 noise for 10 s then silence is not a stall", () => {
    const d = createStallDetector();
    d.reset(0);
    let t = feedFor(d, 0.2, 50, 10_000);
    expect(d.evaluate(t)).toBeNull();
    t = feedFor(d, 0.01, t, STALL_QUIET_MS + 1000);
    expect(d.evaluate(t)).toBeNull();
    expect(d.threshold()).toBeGreaterThan(MIN_THRESHOLD);
  });

  it("a blip shorter than the minimum speech, then a long gap, resets", () => {
    const d = createStallDetector();
    d.reset(0);
    let t = feedFor(d, 0.6, 50, 300);
    t = feedFor(d, 0.01, t, 2000);
    t = feedFor(d, 0.6, t, 300);
    t = feedFor(d, 0.01, t, STALL_QUIET_MS + 200);
    expect(d.evaluate(t)).toBeNull();
  });

  it("the threshold is clamped between its limits", () => {
    const quiet = createStallDetector();
    quiet.reset(0);
    feedFor(quiet, 0, 50, 20_000);
    expect(quiet.threshold()).toBe(MIN_THRESHOLD);
    const loud = createStallDetector();
    loud.reset(0);
    feedFor(loud, 0.3, 50, 1000);
    for (let i = 0; i < 2000; i += 1) loud.feed(0.34, 100_000 + i * 50);
    expect(loud.threshold()).toBeLessThanOrEqual(MAX_THRESHOLD);
  });

  it("one frame never counts for more than MAX_FRAME_MS", () => {
    const d = createStallDetector();
    d.reset(0);
    d.feed(0.6, 100);
    d.feed(0.6, 100 + 60_000);
    expect(STALL_MIN_SPEECH_MS).toBeGreaterThan(MAX_FRAME_MS);
    expect(d.evaluate(100 + 60_000 + STALL_QUIET_MS + 10)).toBeNull();
  });

  it("the quiet window counts from speechEnd when that is later", () => {
    const d = createStallDetector();
    d.reset(0);
    let t = feedFor(d, 0.6, 50, 1000);
    t = feedFor(d, 0.02, t, 2000);
    d.speechEnd(t);
    expect(d.evaluate(t + STALL_QUIET_MS - 100)).toBeNull();
    expect(d.evaluate(t + STALL_QUIET_MS + 100)).not.toBeNull();
  });

  it("a loud room raises the threshold above its own floor", () => {
    const d = createStallDetector();
    d.reset(0);
    feedFor(d, 0.1, 50, 20_000);
    expect(d.threshold()).toBeGreaterThan(0.12);
  });
});

describe("isWebKitSpeech", () => {
  const set = (ua: string, touch = 0) => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: touch });
  };
  afterEach(() => {
    delete (navigator as { userAgent?: unknown }).userAgent;
    delete (navigator as { maxTouchPoints?: unknown }).maxTouchPoints;
  });
  const cases: [string, string, number, boolean][] = [
    [
      "iPhone Safari",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1",
      5,
      true,
    ],
    [
      "iPhone Chrome (CriOS)",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1",
      5,
      true,
    ],
    [
      "iPadOS desktop site",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      5,
      true,
    ],
    [
      "desktop Safari",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      0,
      true,
    ],
    [
      "Android Chrome",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
      5,
      false,
    ],
    [
      "desktop Chrome",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      0,
      false,
    ],
    [
      "Electron",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) omnigent/1.0 Chrome/130.0 Electron/33.0 Safari/537.36",
      0,
      false,
    ],
  ];
  for (const [name, ua, touch, expected] of cases) {
    it(`${name} is ${expected ? "" : "not "}WebKit speech`, () => {
      set(ua, touch);
      expect(isWebKitSpeech()).toBe(expected);
    });
  }
});

describe("event stall detector (meter off)", () => {
  it("fires once: speech heard, speech ended, then STALL_QUIET_MS with no result", () => {
    const d = createEventStallDetector();
    d.reset(0);
    d.speechStart(1000);
    d.ended(2000);
    expect(d.evaluate(2000 + STALL_QUIET_MS - 1)).toBeNull();
    expect(d.evaluate(2000 + STALL_QUIET_MS)).toBe(2000 + STALL_QUIET_MS);
    expect(d.evaluate(2000 + STALL_QUIET_MS + 1000)).toBeNull();
  });

  it("a soundstart that lasted long enough counts as heard at its soundend", () => {
    const d = createEventStallDetector();
    d.reset(0);
    d.soundStart(1000);
    d.soundEnd(1000 + EVENT_HEARD_MIN_SOUND_MS);
    const end = 1000 + EVENT_HEARD_MIN_SOUND_MS;
    expect(d.evaluate(end + STALL_QUIET_MS - 1)).toBeNull();
    expect(d.evaluate(end + STALL_QUIET_MS)).toBe(end + STALL_QUIET_MS);
  });

  it("a cough-like soundstart and soundend with no result never stalls", () => {
    const d = createEventStallDetector();
    d.reset(0);
    d.soundStart(1000);
    d.soundEnd(1000 + EVENT_HEARD_MIN_SOUND_MS - 1);
    for (const t of [5000, 20_000, 120_000]) expect(d.evaluate(t)).toBeNull();
    // Repeated coughs in a long quiet take are no different.
    for (let i = 0; i < 20; i += 1) {
      d.soundStart(130_000 + i * 5000);
      d.soundEnd(130_000 + i * 5000 + 200);
      expect(d.evaluate(130_000 + i * 5000 + 200 + EVENT_NO_END_STALL_MS)).toBeNull();
    }
  });

  it("a soundstart with no soundend yet is not heard", () => {
    const d = createEventStallDetector();
    d.reset(0);
    d.soundStart(1000);
    expect(d.evaluate(1000 + EVENT_NO_END_STALL_MS + STALL_QUIET_MS)).toBeNull();
  });

  it("speechstart and then nothing stalls after the open-speech limit, with no end event", () => {
    const d = createEventStallDetector();
    d.reset(0);
    d.speechStart(1000);
    expect(d.evaluate(1000 + EVENT_OPEN_SPEECH_STALL_MS - 1)).toBeNull();
    expect(d.evaluate(1000 + EVENT_OPEN_SPEECH_STALL_MS)).toBe(1000 + EVENT_OPEN_SPEECH_STALL_MS);
    expect(d.evaluate(1000 + EVENT_OPEN_SPEECH_STALL_MS + 1000)).toBeNull();
  });

  it("12 s of continuous speech with no events does not stall; 21 s does", () => {
    const d = createEventStallDetector();
    d.reset(0);
    d.speechStart(1000);
    expect(d.evaluate(13_000)).toBeNull();
    expect(d.evaluate(20_999)).toBeNull();
    expect(d.evaluate(21_000)).toBe(21_000);
  });

  it("a speechend after a long open speech returns to the 3.5 s rule", () => {
    const d = createEventStallDetector();
    d.reset(0);
    d.speechStart(1000);
    d.ended(13_000);
    expect(d.evaluate(13_000 + STALL_QUIET_MS - 1)).toBeNull();
    expect(d.evaluate(13_000 + STALL_QUIET_MS)).toBe(13_000 + STALL_QUIET_MS);
  });

  it("the no-end window counts from the last sound or speech event", () => {
    const d = createEventStallDetector();
    d.reset(0);
    d.speechStart(1000);
    d.ended(2000);
    d.soundStart(5000);
    expect(d.evaluate(5000 + EVENT_NO_END_STALL_MS - 1)).toBeNull();
    expect(d.evaluate(5000 + EVENT_NO_END_STALL_MS)).not.toBeNull();
  });

  it("a result clears it, and an end with nothing heard is nothing", () => {
    const d = createEventStallDetector();
    d.reset(0);
    d.ended(500);
    expect(d.evaluate(500 + STALL_QUIET_MS + 1)).toBeNull();
    d.speechStart(1000);
    d.ended(2000);
    d.result(3000);
    expect(d.evaluate(2000 + STALL_QUIET_MS + 1)).toBeNull();
    expect(d.evaluate(1000 + EVENT_NO_END_STALL_MS + 1)).toBeNull();
  });

  it("new speech after an end cancels the pending quiet stall; reset forgets everything", () => {
    const d = createEventStallDetector();
    d.reset(0);
    d.speechStart(1000);
    d.ended(2000);
    d.speechStart(3000);
    expect(d.evaluate(2000 + STALL_QUIET_MS + 1)).toBeNull();
    d.ended(4000);
    d.reset(5000);
    expect(d.evaluate(4000 + STALL_QUIET_MS + 1)).toBeNull();
    expect(d.evaluate(60_000)).toBeNull();
  });
});
