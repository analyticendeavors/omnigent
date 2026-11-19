// @vitest-environment jsdom
// DictationSession on iOS (omnigent-ae): no sample-rate hint, a capped resume() on the context,
// the tap-unlocked shared context reused and parked between takes, and the deaf check.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatVoiceLog, resetVoiceLog } from "./aeVoiceLog";
import {
  resetSharedVoiceAudioContext,
  unlockVoiceAudioContext,
  VOICE_SERVER_STT_KEY,
} from "./aeVoiceServerStt";
import { DEAF_SILENT_MS, DictationSession } from "./dictation";

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const getMicStreamMock = vi.fn();
vi.mock("@/lib/aeAudioDevices", () => ({
  getMicStream: (...args: unknown[]) => getMicStreamMock(...args),
}));
vi.mock("@/lib/host", () => ({
  getOmnigentHostConfig: () => ({}),
  resolveWebSocketUrl: (p: string) => `ws://test${p}`,
}));
vi.mock("@/lib/sessionHost", () => ({ modalHostId: () => null }));

let ctxArgs: unknown[][];
let contexts: FakeCtx[];
let nodes: FakeWorklet[];
let sockets: FakeWs[];
let originalUa: PropertyDescriptor | undefined;

class FakeCtx {
  state = "suspended";
  sampleRate = 48000;
  destination = {};
  resume = vi.fn(() => {
    this.state = "running";
    return Promise.resolve();
  });
  suspend = vi.fn(() => {
    this.state = "suspended";
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.state = "closed";
    return Promise.resolve();
  });
  audioWorklet = { addModule: vi.fn(() => Promise.resolve()) };
  constructor(...args: unknown[]) {
    ctxArgs.push(args);
    contexts.push(this);
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  }
}
class FakeWorklet {
  port: { onmessage: ((m: { data: unknown }) => void) | null; postMessage: () => void } = {
    onmessage: null,
    postMessage: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() {
    nodes.push(this);
  }
}
class FakeWs {
  static OPEN = 1;
  readyState = 1;
  binaryType = "";
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  constructor() {
    sockets.push(this);
    queueMicrotask(() => this.onmessage?.({ data: '{"type":"ready"}' }));
  }
  addEventListener() {}
  removeEventListener() {}
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
}

class FakeTrack {
  muted = false;
  listeners: Record<string, () => void> = {};
  stop = vi.fn();
  addEventListener(type: string, cb: () => void) {
    this.listeners[type] = cb;
  }
}
function makeStream() {
  const track = new FakeTrack();
  return { track, getTracks: () => [track] };
}

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
}
const events = () => ({
  onPartial: vi.fn(),
  onFinal: vi.fn(),
  onError: vi.fn(),
  onDeaf: vi.fn(),
});
const chunk = (...samples: number[]) => ({ data: new Int16Array(samples) });

beforeEach(() => {
  ctxArgs = [];
  contexts = [];
  nodes = [];
  sockets = [];
  getMicStreamMock.mockReset();
  getMicStreamMock.mockImplementation(() => Promise.resolve(makeStream()));
  originalUa = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  vi.stubGlobal("AudioContext", FakeCtx);
  vi.stubGlobal("AudioWorkletNode", FakeWorklet);
  vi.stubGlobal("WebSocket", FakeWs);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x" }));
  window.localStorage.removeItem(VOICE_SERVER_STT_KEY);
  resetSharedVoiceAudioContext();
  resetVoiceLog();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.removeItem(VOICE_SERVER_STT_KEY);
  if (originalUa) Object.defineProperty(navigator, "userAgent", originalUa);
  else delete (navigator as { userAgent?: unknown }).userAgent;
});

describe("DictationSession on iOS", () => {
  it("skips the sample-rate hint, resumes the context and logs its state", async () => {
    setUserAgent(IOS_UA);
    const session = await DictationSession.start(events());
    expect(ctxArgs[0]).toEqual([]);
    expect(contexts[0].resume).toHaveBeenCalled();
    expect(formatVoiceLog()).toContain("dictation ctx");
    expect(formatVoiceLog()).toContain("running 48000 Hz");
    expect(session.stream).toBeDefined();
    session.cancel();
    expect(contexts[0].close).toHaveBeenCalled();
  });

  it("still asks for 16 kHz elsewhere", async () => {
    setUserAgent(CHROME_UA);
    await DictationSession.start(events());
    expect(ctxArgs[0]).toEqual([{ sampleRate: 16000 }]);
  });

  it("does not wait past the cap on a context whose resume never settles", async () => {
    setUserAgent(IOS_UA);
    vi.useFakeTimers();
    vi.stubGlobal(
      "AudioContext",
      class extends FakeCtx {
        override resume = vi.fn(() => new Promise<void>(() => {}));
      },
    );
    const p = DictationSession.start(events());
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toBeDefined();
  });

  it("reuses the tap-unlocked context and parks it between takes", async () => {
    setUserAgent(IOS_UA);
    unlockVoiceAudioContext();
    expect(contexts).toHaveLength(1);
    const first = await DictationSession.start(events());
    expect(contexts).toHaveLength(1);
    first.cancel();
    expect(contexts[0].close).not.toHaveBeenCalled();
    expect(contexts[0].suspend).toHaveBeenCalled();
    const second = await DictationSession.start(events());
    expect(contexts).toHaveLength(1);
    // The module is added once per context; resume() ran again for the second take.
    expect(contexts[0].audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(contexts[0].resume.mock.calls.length).toBeGreaterThanOrEqual(3);
    second.cancel();
  });

  it("makes no shared context when the setting is off", () => {
    setUserAgent(IOS_UA);
    window.localStorage.setItem(VOICE_SERVER_STT_KEY, "off");
    unlockVoiceAudioContext();
    expect(contexts).toHaveLength(0);
  });
});

describe("DictationSession deaf check", () => {
  it("reports silence after the constant, but not while sound arrives", async () => {
    setUserAgent(IOS_UA);
    vi.useFakeTimers();
    const ev = events();
    const p = DictationSession.start(ev, { deafCheck: true });
    await vi.advanceTimersByTimeAsync(0);
    const session = await p;
    const port = nodes[0].port;
    // Sound at 3 s keeps the take alive past 4 s.
    await vi.advanceTimersByTimeAsync(3000);
    port.onmessage?.(chunk(0, 5, 0));
    await vi.advanceTimersByTimeAsync(DEAF_SILENT_MS - 1000);
    expect(ev.onDeaf).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(ev.onDeaf).toHaveBeenCalledWith("silent");
    expect(ev.onDeaf).toHaveBeenCalledTimes(1);
    session.cancel();
  });

  it("reports a track that stays muted", async () => {
    setUserAgent(IOS_UA);
    vi.useFakeTimers();
    const ev = events();
    const stream = makeStream();
    getMicStreamMock.mockResolvedValueOnce(stream);
    const p = DictationSession.start(ev, { deafCheck: true });
    await vi.advanceTimersByTimeAsync(0);
    const session = await p;
    stream.track.listeners.mute?.();
    // Keep audio non-zero so only the mute can trigger it.
    const tick = setInterval(() => nodes[0].port.onmessage?.(chunk(1, 2)), 200);
    await vi.advanceTimersByTimeAsync(DEAF_SILENT_MS + 600);
    clearInterval(tick);
    expect(ev.onDeaf).toHaveBeenCalledWith("muted");
    session.cancel();
  });

  it("is off unless asked for", async () => {
    setUserAgent(IOS_UA);
    vi.useFakeTimers();
    const ev = events();
    const p = DictationSession.start(ev);
    await vi.advanceTimersByTimeAsync(0);
    await p;
    await vi.advanceTimersByTimeAsync(DEAF_SILENT_MS * 2);
    expect(ev.onDeaf).not.toHaveBeenCalled();
  });

  it("logs the take's counts and peak at cancel", async () => {
    setUserAgent(IOS_UA);
    const session = await DictationSession.start(events());
    nodes[0].port.onmessage?.(chunk(0, 16384, 0));
    session.cancel();
    expect(formatVoiceLog()).toContain("dictation take");
    expect(formatVoiceLog()).toContain("peak=0.500");
    expect(formatVoiceLog()).toContain("dictation first sound");
  });
});
