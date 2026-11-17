// @vitest-environment jsdom
// The level meter setting (omnigent-ae): off on iOS WebKit by default, where a second capture
// can take the mic from the recognizer. Off means no getUserMedia or AudioContext for the
// meter, the ring and bars driven by recognizer events, and the stall check on those events.
import type { AeMicController } from "@/lib/aeVoiceMode";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMicLevel, resetMicLevel } from "@/lib/aeMicLevel";
import { getVoiceBins, resetVoiceBins } from "@/lib/aeVoiceLevel";
import { formatVoiceLog, resetVoiceLog } from "@/lib/aeVoiceLog";
import { VOICE_METER_KEY } from "@/lib/aeVoiceMeter";
import { ComposerMicButton } from "./ComposerMicButton";

type Handlers = Record<string, (event: unknown) => void>;
const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

let instances: { handlers: Handlers }[];
let startSpy: ReturnType<typeof vi.fn>;
let frames: (() => void)[];
let getUserMedia: ReturnType<typeof vi.fn>;
let audioContexts: number;
let originalUa: PropertyDescriptor | undefined;

class FakeTrack {
  muted = false;
  stop = vi.fn();
  addEventListener() {}
}
class FakeStream {
  track = new FakeTrack();
  getTracks() {
    return [this.track];
  }
}
class FakeCtx {
  state = "running";
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn();
  constructor() {
    audioContexts += 1;
  }
  addEventListener() {}
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 32,
      getByteFrequencyData: (data: Uint8Array) => data.fill(0),
    };
  }
}

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
}

beforeEach(() => {
  instances = [];
  startSpy = vi.fn();
  frames = [];
  audioContexts = 0;
  originalUa = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  class FakeRecognition {
    continuous = false;
    interimResults = false;
    lang = "en-US";
    start = startSpy;
    stop = vi.fn();
    abort = vi.fn();
    own: Handlers = {};
    constructor() {
      instances.push({ handlers: this.own });
    }
    addEventListener(type: string, handler: (event: unknown) => void) {
      this.own[type] = handler;
    }
    removeEventListener() {}
  }
  getUserMedia = vi.fn(() => Promise.resolve(new FakeStream()));
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  vi.stubGlobal("AudioContext", FakeCtx);
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  vi.useFakeTimers();
  resetVoiceLog();
  resetMicLevel();
  resetVoiceBins();
  window.localStorage.removeItem(VOICE_METER_KEY);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.removeItem(VOICE_METER_KEY);
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  if (originalUa) Object.defineProperty(navigator, "userAgent", originalUa);
  else delete (navigator as { userAgent?: unknown }).userAgent;
});

async function listenVoice() {
  const controller = { current: null as AeMicController | null };
  const onListeningChange = vi.fn();
  render(
    <ComposerMicButton
      onTranscript={vi.fn()}
      controller={controller}
      onListeningChange={onListeningChange}
    />,
  );
  act(() => controller.current?.start());
  await act(async () => {
    instances[0].handlers.start?.({});
    instances[0].handlers.audiostart?.({});
    await vi.advanceTimersByTimeAsync(0);
  });
  return { controller, onListeningChange };
}

/** Animation frames every 100 ms for `ms` of fake time. */
async function run(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    // oxlint-disable-next-line no-await-in-loop -- fake time advances one frame at a time
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      for (const cb of frames.splice(0)) cb();
    });
  }
}

function binsSum() {
  return getVoiceBins().reduce((a, b) => a + b, 0);
}

describe("ComposerMicButton (level meter off)", () => {
  it("on an iPhone user agent never opens a second capture or an AudioContext", async () => {
    setUserAgent(IOS_UA);
    await listenVoice();
    await run(1000);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(audioContexts).toBe(0);
    expect(formatVoiceLog()).toContain("meter off");
    expect(formatVoiceLog()).not.toContain("meter on");
  });

  it("publishes synthetic bins and a level from recognizer events, and lets them decay", async () => {
    setUserAgent(IOS_UA);
    await listenVoice();
    await run(300);
    expect(binsSum()).toBe(0);
    act(() => instances[0].handlers.speechstart?.({}));
    await run(500);
    expect(binsSum()).toBeGreaterThan(0);
    expect(getMicLevel()).toBeGreaterThan(0.2);
    act(() => {
      instances[0].handlers.speechend?.({});
      instances[0].handlers.soundend?.({});
    });
    await run(3000);
    expect(getMicLevel()).toBeLessThan(0.05);
  });

  it("has no meter deaf reasons: a quiet take with life from the recognizer is never called deaf", async () => {
    setUserAgent(IOS_UA);
    const { onListeningChange } = await listenVoice();
    await run(20_000);
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
    const log = formatVoiceLog();
    for (const reason of ["track muted", "context not running", "analyser silent"]) {
      expect(log).not.toContain(reason);
    }
  });

  it("calls a stall from recognizer events: sound heard, then 3.5 s with no result after it ends", async () => {
    setUserAgent(IOS_UA);
    const { controller, onListeningChange } = await listenVoice();
    act(() => instances[0].handlers.soundstart?.({}));
    await run(1000);
    act(() => instances[0].handlers.soundend?.({}));
    await run(3000);
    expect(instances).toHaveLength(1);
    await run(1500);
    expect(instances).toHaveLength(2);
    expect(formatVoiceLog()).toContain("mic stalled");
    expect(onListeningChange).not.toHaveBeenCalledWith(false);
    expect(controller.current?.isListening()).toBe(true);
  });

  it("a result before the quiet window ends means no stall, and no sound means none either", async () => {
    setUserAgent(IOS_UA);
    await listenVoice();
    act(() => instances[0].handlers.speechstart?.({}));
    await run(500);
    act(() => instances[0].handlers.speechend?.({}));
    await run(2000);
    act(() =>
      instances[0].handlers.result?.({
        resultIndex: 0,
        results: { length: 1, 0: { length: 1, isFinal: false, 0: { transcript: "hi" } } },
      }),
    );
    await run(6000);
    expect(instances).toHaveLength(1);
    cleanup();
    instances.length = 0;
    await listenVoice();
    await run(8000);
    expect(instances).toHaveLength(1);
  });

  it("an explicit On on an iPhone runs the meter; an explicit Off elsewhere does not", async () => {
    setUserAgent(IOS_UA);
    window.localStorage.setItem(VOICE_METER_KEY, "on");
    await listenVoice();
    expect(getUserMedia).toHaveBeenCalled();
    expect(formatVoiceLog()).toContain("meter on");
    cleanup();
    getUserMedia.mockClear();
    resetVoiceLog();
    instances.length = 0;
    setUserAgent(CHROME_UA);
    window.localStorage.setItem(VOICE_METER_KEY, "off");
    await listenVoice();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(formatVoiceLog()).toContain("meter off");
  });
});

describe("ComposerMicButton (level meter on elsewhere)", () => {
  it("a desktop browser keeps the meter: second capture, context and the meter log line", async () => {
    setUserAgent(CHROME_UA);
    await listenVoice();
    await run(300);
    expect(getUserMedia).toHaveBeenCalled();
    expect(audioContexts).toBe(1);
    expect(formatVoiceLog()).toContain("meter on");
  });
});
