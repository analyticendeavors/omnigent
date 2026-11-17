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
import { VOICE_METER_KEY, writeVoiceMeter } from "@/lib/aeVoiceMeter";
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

  it("has no meter deaf reasons: a take with some life from the recognizer is never called deaf", async () => {
    setUserAgent(IOS_UA);
    const { onListeningChange } = await listenVoice();
    for (let i = 0; i < 6; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one beat of fake time per round
      await run(4000);
      act(() => instances[0].handlers.soundstart?.({}));
      act(() => instances[0].handlers.soundend?.({}));
    }
    expect(instances).toHaveLength(1);
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
    const log = formatVoiceLog();
    for (const reason of ["track muted", "context not running", "analyser silent"]) {
      expect(log).not.toContain(reason);
    }
  });

  it("recycles a recognizer with no activity 10 s after audiostart, silently and without calling it deaf", async () => {
    setUserAgent(IOS_UA);
    const { controller, onListeningChange } = await listenVoice();
    await run(9500);
    expect(instances).toHaveLength(1);
    await run(1000);
    expect(instances).toHaveLength(2);
    const log = formatVoiceLog();
    expect(log).toContain("mic idle recycle");
    expect(log).not.toContain("mic deaf");
    expect(log).not.toContain("mic stalled");
    expect(onListeningChange).not.toHaveBeenCalledWith(false);
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
    expect(controller.current?.isListening()).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(2);
    // The fresh recognizer is given the no-audiostart allowance, not judged at once.
    await run(3000);
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
  });

  it("any recognizer activity restarts the 10 s idle wait", async () => {
    setUserAgent(IOS_UA);
    await listenVoice();
    await run(8000);
    act(() => instances[0].handlers.soundstart?.({}));
    act(() => instances[0].handlers.soundend?.({}));
    await run(8000);
    expect(instances).toHaveLength(1);
  });

  it("stops after 6 idle recycles in a minute, logs it, and resumes after the next result", async () => {
    setUserAgent(IOS_UA);
    await listenVoice();
    let seen = 1;
    const reviveLatest = () => {
      const latest = instances[instances.length - 1];
      latest.handlers.start?.({});
      latest.handlers.audiostart?.({});
    };
    // Half-second beats keep every recycle exactly 10 s after the audiostart that followed the last.
    for (let beat = 0; beat < 180; beat += 1) {
      // oxlint-disable-next-line no-await-in-loop -- fake time advances one beat at a time
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
        if (instances.length > seen) {
          seen = instances.length;
          reviveLatest();
        }
      });
    }
    expect(instances).toHaveLength(7);
    const log = formatVoiceLog();
    expect(log.match(/mic idle recycle capped/g)).toHaveLength(1);
    expect(log.match(/mic idle recycle(?! capped)/g)).toHaveLength(6);
    // A result lifts the cap.
    act(() =>
      instances[6].handlers.result?.({
        resultIndex: 0,
        results: { length: 1, 0: { length: 1, isFinal: false, 0: { transcript: "hi" } } },
      }),
    );
    await run(11_000);
    expect(instances).toHaveLength(8);
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

  it("a cough (a short sound, then its end) with no result never stalls the take", async () => {
    setUserAgent(IOS_UA);
    await listenVoice();
    for (let i = 0; i < 3; i += 1) {
      act(() => instances[0].handlers.soundstart?.({}));
      // oxlint-disable-next-line no-await-in-loop -- one beat of fake time per round
      await run(300);
      act(() => instances[0].handlers.soundend?.({}));
      // oxlint-disable-next-line no-await-in-loop -- one beat of fake time per round
      await run(5000);
    }
    expect(instances).toHaveLength(1);
    expect(formatVoiceLog()).not.toContain("mic stalled");
  });

  it("speech heard and then nothing at all stalls after 6 s, with no end event", async () => {
    setUserAgent(IOS_UA);
    const { controller, onListeningChange } = await listenVoice();
    act(() => instances[0].handlers.speechstart?.({}));
    await run(5500);
    expect(instances).toHaveLength(1);
    await run(1000);
    expect(instances).toHaveLength(2);
    expect(formatVoiceLog()).toContain("mic stalled");
    expect(onListeningChange).not.toHaveBeenCalledWith(false);
    expect(controller.current?.isListening()).toBe(true);
  });

  it("event stalls restart silently every time and never call the mic deaf", async () => {
    setUserAgent(IOS_UA);
    const { onListeningChange } = await listenVoice();
    for (let i = 0; i < 6; i += 1) {
      const latest = instances[instances.length - 1];
      act(() => {
        latest.handlers.start?.({});
        latest.handlers.audiostart?.({});
        latest.handlers.speechstart?.({});
      });
      // oxlint-disable-next-line no-await-in-loop -- one stall per round
      await run(6500);
      expect(instances).toHaveLength(i + 2);
    }
    const log = formatVoiceLog();
    expect(log).not.toContain("stalled repeatedly");
    expect(log).not.toContain("mic deaf");
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
  });

  it("turning the Level meter on mid-take opens the second stream, and off closes it", async () => {
    setUserAgent(CHROME_UA);
    window.localStorage.setItem(VOICE_METER_KEY, "off");
    await listenVoice();
    expect(getUserMedia).not.toHaveBeenCalled();
    await act(async () => {
      writeVoiceMeter(true);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(audioContexts).toBe(1);
    expect(formatVoiceLog()).toContain("meter on");
    const stream = (await getUserMedia.mock.results[0].value) as FakeStream;
    await act(async () => {
      writeVoiceMeter(false);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stream.track.stop).toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(formatVoiceLog().match(/meter off/g)).toHaveLength(2);
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
