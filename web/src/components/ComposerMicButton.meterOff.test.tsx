// @vitest-environment jsdom
// The level meter setting (omnigent-ae): off on iOS WebKit by default, where a second capture
// can take the mic from the recognizer. Off means no getUserMedia or AudioContext for the
// meter, the ring and bars driven by recognizer events, and the stall check on those events.
import type { AeMicController } from "@/lib/aeVoiceMode";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enterVoiceAudioSession,
  leaveVoiceAudioSession,
  resetAudioSessionState,
} from "@/lib/aeAudioSession";
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

let instances: {
  own: Handlers;
  stop: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  interimResults: boolean;
}[];
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

/** Like WebKit: a recognizer with interimResults off never reports an interim result. */
function emitInterim(instance: (typeof instances)[number], text: string) {
  if (!instance.interimResults) return;
  act(() =>
    instance.own.result?.({
      resultIndex: 0,
      results: { length: 1, 0: { length: 1, isFinal: false, 0: { transcript: text } } },
    }),
  );
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
      instances.push(this as unknown as (typeof instances)[number] & { own: Handlers });
    }
    listeners: Record<string, Set<(event: unknown) => void>> = {};
    addEventListener(type: string, handler: (event: unknown) => void) {
      const set = (this.listeners[type] ??= new Set());
      set.add(handler);
      // `own[type]` fires every listener still attached, like a real recognizer.
      this.own[type] = (event) => {
        for (const h of [...set]) h(event);
      };
    }
    removeEventListener(type: string, handler: (event: unknown) => void) {
      this.listeners[type]?.delete(handler);
    }
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
  // These tests cover the browser path on iOS; the server path has its own file.
  window.localStorage.setItem("omnigent:ae-voice-server-stt", "off");
});

afterEach(() => {
  resetAudioSessionState();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.removeItem(VOICE_METER_KEY);
  window.localStorage.removeItem("omnigent:ae-voice-server-stt");
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  if (originalUa) Object.defineProperty(navigator, "userAgent", originalUa);
  else delete (navigator as { userAgent?: unknown }).userAgent;
});

async function listenVoice() {
  const controller = { current: null as AeMicController | null };
  const onListeningChange = vi.fn();
  const view = render(
    <ComposerMicButton
      onTranscript={vi.fn()}
      controller={controller}
      onListeningChange={onListeningChange}
    />,
  );
  act(() => controller.current?.start());
  await act(async () => {
    instances[0].own.start?.({});
    instances[0].own.audiostart?.({});
    await vi.advanceTimersByTimeAsync(0);
  });
  return { controller, onListeningChange, view };
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
    act(() => instances[0].own.speechstart?.({}));
    await run(500);
    expect(binsSum()).toBeGreaterThan(0);
    expect(getMicLevel()).toBeGreaterThan(0.2);
    act(() => {
      instances[0].own.speechend?.({});
      instances[0].own.soundend?.({});
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
      act(() => instances[0].own.soundstart?.({}));
      act(() => instances[0].own.soundend?.({}));
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
    // WebKit: the fresh recognizer starts once the old one has ended.
    expect(startSpy).toHaveBeenCalledTimes(1);
    act(() => instances[0].own.end?.({}));
    expect(startSpy).toHaveBeenCalledTimes(2);
    // The fresh recognizer is given the no-audiostart allowance, not judged at once.
    await run(3000);
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
  });

  it("with no events at all for 10 s the idle recycle stops the old recognizer instead of aborting it", async () => {
    setUserAgent(IOS_UA);
    vi.stubGlobal("speechSynthesis", { speaking: false, pending: false });
    await listenVoice();
    await run(10_500);
    expect(instances).toHaveLength(2);
    expect(instances[0].stop).toHaveBeenCalled();
    expect(instances[0].abort).not.toHaveBeenCalled();
    expect(formatVoiceLog()).toContain("mic idle recycle");
    expect(formatVoiceLog()).toContain("speaking=");
  });

  it("on WebKit a take with only start and audiostart, then interim results, keeps its recognizer until the final at 12 s", async () => {
    setUserAgent(IOS_UA);
    const onTranscript = vi.fn();
    const controller = { current: null as AeMicController | null };
    render(
      <ComposerMicButton
        onTranscript={onTranscript}
        controller={controller}
        onListeningChange={vi.fn()}
      />,
    );
    act(() => controller.current?.start());
    expect(instances[0].interimResults).toBe(true);
    await act(async () => {
      instances[0].own.start?.({});
      instances[0].own.audiostart?.({});
      await vi.advanceTimersByTimeAsync(0);
    });
    const interim = (text: string) => emitInterim(instances[0], text);
    await run(6000);
    interim("hello");
    await run(5000);
    interim("hello there");
    await run(1000);
    expect(instances).toHaveLength(1);
    expect(instances[0].abort).not.toHaveBeenCalled();
    expect(instances[0].stop).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    act(() =>
      instances[0].own.result?.({
        resultIndex: 0,
        results: {
          length: 1,
          0: { length: 1, isFinal: true, 0: { transcript: "hello there friend" } },
        },
      }),
    );
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("hello there friend");
    expect(formatVoiceLog()).not.toContain("mic idle recycle");
  });

  it("an idle recycle mid-utterance still delivers the old recognizer's final from 2 s later, once", async () => {
    setUserAgent(IOS_UA);
    const onTranscript = vi.fn();
    const controller = { current: null as AeMicController | null };
    render(
      <ComposerMicButton
        onTranscript={onTranscript}
        controller={controller}
        onListeningChange={vi.fn()}
      />,
    );
    act(() => controller.current?.start());
    await act(async () => {
      instances[0].own.start?.({});
      instances[0].own.audiostart?.({});
      await vi.advanceTimersByTimeAsync(0);
    });
    await run(500);
    emitInterim(instances[0], "hello");
    await run(10_500);
    expect(instances).toHaveLength(2);
    expect(instances[0].stop).toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    await run(2000);
    const final = {
      resultIndex: 0,
      results: { length: 1, 0: { length: 1, isFinal: true, 0: { transcript: "hello there" } } },
    };
    act(() => instances[0].own.result?.(final));
    act(() => instances[0].own.result?.(final));
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("hello there");
  });

  it("on Chrome the recognizer keeps interim results off", async () => {
    setUserAgent(CHROME_UA);
    await listenVoice();
    expect(instances[0].interimResults).toBe(false);
  });

  it("any recognizer activity restarts the 10 s idle wait", async () => {
    setUserAgent(IOS_UA);
    await listenVoice();
    await run(8000);
    act(() => instances[0].own.soundstart?.({}));
    act(() => instances[0].own.soundend?.({}));
    await run(8000);
    expect(instances).toHaveLength(1);
  });

  it("stops after 6 idle recycles in a minute, logs it, and resumes after the next result", async () => {
    setUserAgent(IOS_UA);
    await listenVoice();
    let seen = 1;
    const reviveLatest = () => {
      const latest = instances[instances.length - 1];
      latest.own.start?.({});
      latest.own.audiostart?.({});
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
    emitInterim(instances[6], "hi");
    await run(11_000);
    expect(instances).toHaveLength(8);
  });

  it("calls a stall from recognizer events: sound heard, then 3.5 s with no result after it ends", async () => {
    setUserAgent(IOS_UA);
    const { controller, onListeningChange } = await listenVoice();
    act(() => instances[0].own.soundstart?.({}));
    await run(1000);
    act(() => instances[0].own.soundend?.({}));
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
    act(() => instances[0].own.speechstart?.({}));
    await run(500);
    act(() => instances[0].own.speechend?.({}));
    await run(2000);
    emitInterim(instances[0], "hi");
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
      act(() => instances[0].own.soundstart?.({}));
      // oxlint-disable-next-line no-await-in-loop -- one beat of fake time per round
      await run(300);
      act(() => instances[0].own.soundend?.({}));
      // oxlint-disable-next-line no-await-in-loop -- one beat of fake time per round
      await run(5000);
    }
    expect(instances).toHaveLength(1);
    expect(formatVoiceLog()).not.toContain("mic stalled");
  });

  it("speech heard and then nothing at all stalls only after 20 s, with no end event", async () => {
    setUserAgent(IOS_UA);
    const { controller, onListeningChange } = await listenVoice();
    act(() => instances[0].own.speechstart?.({}));
    await run(12_000);
    expect(instances).toHaveLength(1);
    await run(7500);
    expect(instances).toHaveLength(1);
    await run(1000);
    expect(instances).toHaveLength(2);
    expect(formatVoiceLog()).toContain("mic stalled");
    expect(onListeningChange).not.toHaveBeenCalledWith(false);
    expect(controller.current?.isListening()).toBe(true);
  });

  async function stallRound() {
    const latest = instances[instances.length - 1];
    const before = instances.length;
    act(() => {
      latest.own.start?.({});
      latest.own.audiostart?.({});
      latest.own.speechstart?.({});
    });
    await run(300);
    act(() => latest.own.speechend?.({}));
    await run(4000);
    // WebKit starts the swapped-in recognizer once the old one has ended.
    if (instances.length > before) act(() => latest.own.end?.({}));
  }

  it("caps event stall restarts at 4 a minute, never calls the mic deaf, and resumes after a result", async () => {
    setUserAgent(IOS_UA);
    const { onListeningChange } = await listenVoice();
    for (let i = 0; i < 4; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one stall per round
      await stallRound();
      expect(instances).toHaveLength(i + 2);
    }
    await stallRound();
    expect(instances).toHaveLength(5);
    await stallRound();
    expect(instances).toHaveLength(5);
    const log = formatVoiceLog();
    expect(log.match(/mic stall restart capped/g)).toHaveLength(1);
    expect(log).not.toContain("stalled repeatedly");
    expect(log).not.toContain("mic deaf");
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
    // A result lifts the cap.
    emitInterim(instances[4], "hi");
    await stallRound();
    expect(instances).toHaveLength(6);
  });

  it("an event stall restart followed by a slow audiostart (4 s) does not report deaf", async () => {
    setUserAgent(IOS_UA);
    const { onListeningChange } = await listenVoice();
    await run(2000);
    act(() => instances[0].own.speechstart?.({}));
    await run(300);
    act(() => instances[0].own.speechend?.({}));
    await run(4000);
    expect(instances).toHaveLength(2);
    // The fresh recognizer is silent for 4 s, inside its own 5 s no-audiostart window.
    await run(4000);
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
    expect(formatVoiceLog()).not.toContain("no audiostart");
    act(() => instances[1].own.audiostart?.({}));
    await run(1000);
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

describe("ComposerMicButton (audio session)", () => {
  it("on WebKit with Voice mode on, pins play-and-record before the mic starts and logs it", async () => {
    setUserAgent(IOS_UA);
    const audioSession = { type: "auto" };
    Object.defineProperty(navigator, "audioSession", { configurable: true, value: audioSession });
    enterVoiceAudioSession();
    audioSession.type = "playback";
    await listenVoice();
    expect(audioSession.type).toBe("play-and-record");
    expect(formatVoiceLog()).toContain("audioSession=playback");
    leaveVoiceAudioSession();
    delete (navigator as { audioSession?: unknown }).audioSession;
  });

  it("on Chrome never touches audioSession", async () => {
    setUserAgent(CHROME_UA);
    const audioSession = { type: "playback" };
    Object.defineProperty(navigator, "audioSession", { configurable: true, value: audioSession });
    enterVoiceAudioSession();
    await listenVoice();
    expect(audioSession.type).toBe("playback");
    expect(formatVoiceLog()).toContain("audioSession=none");
    leaveVoiceAudioSession();
    delete (navigator as { audioSession?: unknown }).audioSession;
  });
});

describe("ComposerMicButton (restart race)", () => {
  it("on WebKit an idle recycle starts the new recognizer only after the old one fires end", async () => {
    setUserAgent(IOS_UA);
    await listenVoice();
    await run(10_500);
    expect(instances).toHaveLength(2);
    expect(instances[0].stop).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalledTimes(1);
    await run(500);
    expect(startSpy).toHaveBeenCalledTimes(1);
    act(() => instances[0].own.end?.({}));
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("on WebKit the new recognizer starts anyway 1500 ms after the stop when end never comes", async () => {
    setUserAgent(IOS_UA);
    await listenVoice();
    await run(10_000);
    await run(1000);
    expect(instances).toHaveLength(2);
    expect(startSpy).toHaveBeenCalledTimes(1);
    await run(700);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(formatVoiceLog()).toContain("mic old end wait capped");
  });

  it("an aborted error right after a silent restart retries once and never pauses Voice mode", async () => {
    setUserAgent(IOS_UA);
    const { controller, onListeningChange } = await listenVoice();
    await run(10_500);
    act(() => instances[0].own.end?.({}));
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(instances).toHaveLength(2);
    act(() => {
      instances[1].own.start?.({});
      instances[1].own.error?.({ error: "aborted", message: "Another request is started" });
    });
    expect(instances).toHaveLength(3);
    expect(formatVoiceLog()).toContain("mic restart aborted");
    act(() => instances[1].own.end?.({}));
    expect(startSpy).toHaveBeenCalledTimes(3);
    expect(onListeningChange).not.toHaveBeenCalledWith(false);
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
    expect(controller.current?.isListening()).toBe(true);
  });

  it("logs the browser's error message with the error", async () => {
    setUserAgent(CHROME_UA);
    await listenVoice();
    act(() => instances[0].own.error?.({ error: "audio-capture", message: "Mic is busy" }));
    expect(formatVoiceLog()).toContain("audio-capture: Mic is busy");
  });

  it("on Chrome a restart starts the new recognizer immediately", async () => {
    setUserAgent(CHROME_UA);
    writeVoiceMeter(false);
    await listenVoice();
    await run(10_500);
    expect(instances).toHaveLength(2);
    expect(startSpy).toHaveBeenCalledTimes(2);
  });
});

/** A WebKit idle recycle is under way: instances[1] waits for instances[0] to end. */
async function pendingRestart() {
  setUserAgent(IOS_UA);
  const listening = await listenVoice();
  await run(10_500);
  expect(instances).toHaveLength(2);
  expect(startSpy).toHaveBeenCalledTimes(1);
  return listening;
}

describe("ComposerMicButton (stop during the old end wait)", () => {
  it("the button stop ends the take and never starts the new recognizer", async () => {
    const { onListeningChange, view } = await pendingRestart();
    act(() => {
      fireEvent.click(view.getByRole("button"));
    });
    expect(onListeningChange).toHaveBeenCalledWith(false);
    act(() => instances[0].own.end?.({}));
    await run(5000);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Esc discards the take and never starts the new recognizer", async () => {
    const { onListeningChange } = await pendingRestart();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onListeningChange).toHaveBeenCalledWith(false);
    act(() => instances[0].own.end?.({}));
    await run(5000);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("controller.stop ends the take at once, without the stop watchdog", async () => {
    const { controller, onListeningChange } = await pendingRestart();
    act(() => controller.current?.stop());
    expect(onListeningChange).toHaveBeenCalledWith(false);
    expect(controller.current?.isListening()).toBe(false);
    act(() => instances[0].own.end?.({}));
    await run(5000);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(formatVoiceLog()).not.toContain("mic stop watchdog");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an unmount during the wait leaves no timer behind", async () => {
    const { view } = await pendingRestart();
    view.unmount();
    // Only the old recognizer's late-final timer (self-expiring) may remain; no wait timer starts.
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("a second restart during a pending start waits on the real old recognizer", async () => {
    await pendingRestart();
    // The pending recognizer reports a final: another recycle replaces it before it ever started.
    act(() =>
      instances[1].own.result?.({
        resultIndex: 0,
        results: { length: 1, 0: { length: 1, isFinal: true, 0: { transcript: "hi" } } },
      }),
    );
    expect(instances).toHaveLength(3);
    expect(startSpy).toHaveBeenCalledTimes(1);
    // The never-started recognizer is not waited on: the real one ends and the newest starts.
    act(() => instances[0].own.end?.({}));
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("a late end after the cap is ignored", async () => {
    await pendingRestart();
    await run(1500);
    expect(startSpy).toHaveBeenCalledTimes(2);
    act(() => instances[0].own.end?.({}));
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("on Chrome an aborted error right after a restart still reports a deaf take", async () => {
    setUserAgent(CHROME_UA);
    writeVoiceMeter(false);
    const { onListeningChange } = await listenVoice();
    await run(10_500);
    expect(instances).toHaveLength(2);
    expect(startSpy).toHaveBeenCalledTimes(2);
    act(() => instances[1].own.error?.({ error: "aborted", message: "x" }));
    expect(formatVoiceLog()).not.toContain("mic restart aborted");
    expect(onListeningChange).toHaveBeenCalledWith(false, "deaf");
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
