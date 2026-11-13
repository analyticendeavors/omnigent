// @vitest-environment jsdom
// Voice mode stall watchdog and the WebKit recycle after a final (omnigent-ae).
import type { AeMicController } from "@/lib/aeVoiceMode";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatVoiceLog, resetVoiceLog } from "@/lib/aeVoiceLog";
import { ComposerMicButton } from "./ComposerMicButton";

type Handlers = Record<string, (event: unknown) => void>;
let instances: { handlers: Handlers }[];
let startSpy: ReturnType<typeof vi.fn>;
let abortSpy: ReturnType<typeof vi.fn>;
let stopSpy: ReturnType<typeof vi.fn>;
let frames: (() => void)[];
/** The byte every analyser bin reads: ~140 is speech, ~5 is a quiet room. */
let binValue: number;
const SPEECH = 140;
const QUIET = 5;
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
  addEventListener() {}
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 32,
      getByteFrequencyData: (data: Uint8Array) => data.fill(binValue),
    };
  }
}

function resultEvent(transcript: string) {
  return {
    resultIndex: 0,
    results: { length: 1, 0: { length: 1, isFinal: true, 0: { transcript } } },
  };
}

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
}

beforeEach(() => {
  instances = [];
  startSpy = vi.fn();
  abortSpy = vi.fn();
  stopSpy = vi.fn();
  frames = [];
  binValue = QUIET;
  originalUa = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  class FakeRecognition {
    continuous = false;
    interimResults = false;
    lang = "en-US";
    start = startSpy;
    stop = stopSpy;
    abort = abortSpy;
    own: Handlers = {};
    constructor() {
      instances.push({ handlers: this.own });
    }
    addEventListener(type: string, handler: (event: unknown) => void) {
      this.own[type] = handler;
    }
    removeEventListener() {}
  }
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
      getUserMedia: vi.fn(() => Promise.resolve(new FakeStream())),
      enumerateDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  vi.useFakeTimers();
  resetVoiceLog();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  if (originalUa) Object.defineProperty(navigator, "userAgent", originalUa);
  else delete (navigator as { userAgent?: unknown }).userAgent;
});

async function listenVoice() {
  const controller = { current: null as AeMicController | null };
  const onListeningChange = vi.fn();
  const onTranscript = vi.fn();
  const onVoiceStart = vi.fn();
  render(
    <ComposerMicButton
      onTranscript={onTranscript}
      onVoiceStart={onVoiceStart}
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
  return { controller, onListeningChange, onTranscript, onVoiceStart };
}

/** Meter frames every 100 ms at `value`, for `ms`. */
async function run(value: number, ms: number) {
  binValue = value;
  for (let t = 0; t < ms; t += 100) {
    // oxlint-disable-next-line no-await-in-loop -- fake time advances one frame at a time
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      for (const cb of frames.splice(0)) cb();
    });
  }
}

/** The live recognizer shows life, as a healthy fresh one does. */
function revive() {
  const live = instances[instances.length - 1].handlers;
  act(() => {
    live.start?.({});
    live.audiostart?.({});
  });
}

describe("ComposerMicButton (stall watchdog)", () => {
  it("speech energy then 3.5 s quiet with no result swaps the recognizer without a stop report", async () => {
    const { controller, onListeningChange, onVoiceStart } = await listenVoice();
    await run(SPEECH, 1000);
    await run(QUIET, 4000);
    expect(instances).toHaveLength(2);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(abortSpy).not.toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(onListeningChange).not.toHaveBeenCalledWith(false);
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
    expect(controller.current?.isListening()).toBe(true);
    expect(formatVoiceLog()).toContain("mic stalled");
    // The new recognizer's start is not a new take: no second snapshot for Esc.
    revive();
    expect(onVoiceStart).toHaveBeenCalledTimes(1);
  });

  it("a result inside the window means no restart", async () => {
    const { onTranscript } = await listenVoice();
    await run(SPEECH, 1000);
    await run(QUIET, 1500);
    act(() => instances[0].handlers.result?.(resultEvent("hello there")));
    await run(QUIET, 4000);
    expect(onTranscript).toHaveBeenCalledWith("hello there");
    expect(instances).toHaveLength(1);
    expect(formatVoiceLog()).not.toContain("mic stalled");
  });

  it("a quiet room with no speech energy never restarts", async () => {
    await listenVoice();
    await run(QUIET, 4500);
    expect(instances).toHaveLength(1);
  });

  it("a short noise blip is not speech", async () => {
    await listenVoice();
    await run(SPEECH, 300);
    await run(QUIET, 4000);
    expect(instances).toHaveLength(1);
  });

  it("the fourth stall inside a minute goes the deaf way", async () => {
    const { onListeningChange } = await listenVoice();
    for (let i = 0; i < 3; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each stall needs its own clock
      await run(SPEECH, 1000);
      // oxlint-disable-next-line no-await-in-loop
      await run(QUIET, 4000);
      expect(instances).toHaveLength(i + 2);
      revive();
    }
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
    await run(SPEECH, 1000);
    await run(QUIET, 4000);
    expect(onListeningChange.mock.calls.filter((c) => c[0] === false)).toEqual([[false, "deaf"]]);
    expect(formatVoiceLog()).toContain("mic deaf stalled repeatedly");
  });
});

describe("ComposerMicButton (slow finals and restart failures)", () => {
  it("a final at 2.6 s or 3 s is delivered once and no stall fires", async () => {
    for (const quietMs of [2600, 3000]) {
      cleanup();
      instances.length = 0;
      // oxlint-disable-next-line no-await-in-loop -- one take per case
      const { onTranscript } = await listenVoice();
      // oxlint-disable-next-line no-await-in-loop
      await run(SPEECH, 1000);
      // oxlint-disable-next-line no-await-in-loop
      await run(QUIET, quietMs);
      act(() => instances[0].handlers.result?.(resultEvent("slow one")));
      // oxlint-disable-next-line no-await-in-loop
      await run(QUIET, 4000);
      expect(onTranscript).toHaveBeenCalledTimes(1);
      expect(instances).toHaveLength(1);
      expect(formatVoiceLog()).not.toContain("mic stalled");
    }
  });

  it("a final from the old recognizer inside the late window is delivered once", async () => {
    const { onTranscript } = await listenVoice();
    await run(SPEECH, 1000);
    await run(QUIET, 3700);
    expect(instances).toHaveLength(2);
    expect(onTranscript).not.toHaveBeenCalled();
    act(() => instances[0].handlers.result?.(resultEvent("late words")));
    act(() => instances[0].handlers.result?.(resultEvent("late words")));
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("late words");
    expect(formatVoiceLog()).toContain("mic late final delivered");
  });

  it("audioend counts as the end of the speech for the quiet window", async () => {
    await listenVoice();
    await run(SPEECH, 1000);
    await run(QUIET, 1500);
    act(() => instances[0].handlers.audioend?.({}));
    await run(QUIET, 3000);
    expect(instances).toHaveLength(1);
    await run(QUIET, 1000);
    expect(instances).toHaveLength(2);
  });

  it("a replacement that ends before it starts reports deaf, not a manual stop", async () => {
    const { controller, onListeningChange } = await listenVoice();
    await run(SPEECH, 1000);
    await run(QUIET, 4000);
    expect(instances).toHaveLength(2);
    act(() => instances[1].handlers.end?.({}));
    expect(onListeningChange.mock.calls.filter((c) => c[0] === false)).toEqual([[false, "deaf"]]);
    expect(formatVoiceLog()).toContain("mic deaf stall restart failed");
    expect(controller.current?.isListening()).toBe(false);
  });

  it("a replacement that errors before it starts reports deaf too", async () => {
    const { onListeningChange } = await listenVoice();
    await run(SPEECH, 1000);
    await run(QUIET, 4000);
    act(() => instances[1].handlers.error?.({ error: "audio-capture" }));
    expect(onListeningChange.mock.calls.filter((c) => c[0] === false)).toEqual([[false, "deaf"]]);
  });
});

describe("ComposerMicButton (assistant audio, budget, hidden tab)", () => {
  it("playback energy with no results never stalls", async () => {
    const { controller } = await listenVoice();
    act(() => controller.current?.setAssistantAudible?.(true));
    await run(SPEECH, 3000);
    await run(QUIET, 5000);
    expect(instances).toHaveLength(1);
    act(() => controller.current?.setAssistantAudible?.(false));
    await run(SPEECH, 500);
    await run(QUIET, 5000);
    expect(instances).toHaveLength(1);
    // The user speaking after the tail still counts.
    await run(SPEECH, 1000);
    await run(QUIET, 4000);
    expect(instances).toHaveLength(2);
  });

  it("a new Voice mode take makes the stall budget whole again", async () => {
    const { controller, onListeningChange } = await listenVoice();
    for (let i = 0; i < 3; i += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await run(SPEECH, 1000);
      // oxlint-disable-next-line no-await-in-loop
      await run(QUIET, 4000);
      revive();
    }
    expect(instances).toHaveLength(4);
    act(() => controller.current?.stop());
    act(() => instances[instances.length - 1].handlers.end?.({}));
    act(() => controller.current?.start());
    act(() => {
      const live = instances[instances.length - 1].handlers;
      live.start?.({});
      live.audiostart?.({});
    });
    await run(SPEECH, 1000);
    await run(QUIET, 4000);
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
    expect(instances.length).toBeGreaterThanOrEqual(5);
  });

  it("a hidden tab starts the detector clean", async () => {
    await listenVoice();
    await run(SPEECH, 1000);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await run(QUIET, 5000);
    expect(instances).toHaveLength(1);
  });
});

describe("ComposerMicButton (WebKit recycle after a final)", () => {
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";
  const CHROME =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

  it("a final on WebKit starts a fresh recognizer, delivers once and reports nothing", async () => {
    setUserAgent(IPHONE);
    const { controller, onListeningChange, onTranscript } = await listenVoice();
    act(() => instances[0].handlers.result?.(resultEvent("How's")));
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("How's");
    expect(instances).toHaveLength(2);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(onListeningChange).not.toHaveBeenCalledWith(false);
    expect(controller.current?.isListening()).toBe(true);
    const log = formatVoiceLog();
    expect(log).toContain("mic result final 5");
    expect(log).toContain("mic recycle after final");
    // Events from the recycled recognizer change nothing.
    act(() => {
      instances[0].handlers.result?.(resultEvent("stale"));
      instances[0].handlers.end?.({});
      instances[0].handlers.error?.({ error: "aborted" });
    });
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(controller.current?.isListening()).toBe(true);
    expect(onListeningChange).not.toHaveBeenCalledWith(false);
    // The fresh recognizer carries on and delivers the next phrase.
    revive();
    act(() => instances[1].handlers.result?.(resultEvent("are you")));
    expect(onTranscript).toHaveBeenCalledTimes(2);
    expect(instances).toHaveLength(3);
  });

  it("Chrome keeps one recognizer after a final", async () => {
    setUserAgent(CHROME);
    const { onTranscript } = await listenVoice();
    act(() => instances[0].handlers.result?.(resultEvent("How's")));
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(formatVoiceLog()).not.toContain("mic recycle after final");
  });
});
