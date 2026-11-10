import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudSpeaker, fetchCloudVoices, resetCloudVoicesCache } from "./aeCloudVoice";
import { setCaptionHandler, type Speaker, type SpeakOptions } from "./aeSpeakReplies";
import { clearPlaybackBlocked, isPlaybackBlocked, resumePlayback } from "./aeVoicePlayback";

const OPTS: SpeakOptions = { voiceURI: null, rate: 1, cloudVoiceId: "en-US-AvaMultilingualNeural" };

class FakeAudio {
  static last: FakeAudio | null = null;
  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  played: string[] = [];
  pauses = 0;
  sinkId = "";
  sinks: string[] = [];
  static sinkFail = false;
  static sinkGate: Promise<void> | null = null;
  setSinkId(id: string) {
    if (FakeAudio.sinkGate) {
      return FakeAudio.sinkGate.then(() => {
        this.sinks.push(id);
        this.sinkId = id;
      });
    }
    if (FakeAudio.sinkFail && id !== "") return Promise.reject(new Error("sink"));
    this.sinks.push(id);
    this.sinkId = id;
    return Promise.resolve();
  }
  constructor() {
    FakeAudio.last = this;
  }
  static plays: Promise<void>[] = [];
  play() {
    this.played.push(this.src);
    return FakeAudio.plays.shift() ?? Promise.resolve();
  }
  pause() {
    this.pauses++;
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  end() {
    this.onended?.();
  }
}

class FakeDevice implements Speaker {
  texts: string[] = [];
  stops = 0;
  on = false;
  listeners = new Set<() => void>();
  speak = (text: string) => {
    this.texts.push(text);
    this.on = true;
    this.listeners.forEach((cb) => cb());
  };
  stop = () => {
    this.stops++;
    this.on = false;
    this.listeners.forEach((cb) => cb());
  };
  speaking = () => this.on;
  retained = () => 0;
  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  finish() {
    this.on = false;
    this.listeners.forEach((cb) => cb());
  }
}

interface Pending {
  text: string;
  signal: AbortSignal | null | undefined;
  resolve: (r: Response) => void;
}

let pending: Pending[];
let fetchMock: ReturnType<typeof vi.fn>;
let urls: string[];

const mp3 = () =>
  new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "Content-Type": "audio/mpeg" },
  });
const tick = () =>
  new Promise<void>((r) => {
    setTimeout(r, 0);
  });
async function settle() {
  await tick();
  await tick();
  await tick();
  await tick();
}

beforeEach(() => {
  pending = [];
  urls = [];
  FakeAudio.last = null;
  FakeAudio.plays = [];
  resetCloudVoicesCache();
  fetchMock = vi.fn((input: string, init?: RequestInit) => {
    if (String(input).endsWith("/tts/voices")) {
      return Promise.resolve(
        new Response(JSON.stringify({ voices: [{ id: "a", name: "Ava" }] }), { status: 200 }),
      );
    }
    return new Promise<Response>((resolve, reject) => {
      const body = JSON.parse(String(init?.body)) as { text: string };
      pending.push({ text: body.text, signal: init?.signal, resolve });
      init?.signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Audio", FakeAudio);
  let n = 0;
  vi.stubGlobal("URL", {
    createObjectURL: () => {
      const u = `blob:${n++}`;
      urls.push(u);
      return u;
    },
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  window.localStorage.clear();
  FakeAudio.sinkGate = null;
  vi.unstubAllGlobals();
});

describe("fetchCloudVoices", () => {
  it("returns the voices once and caches them", async () => {
    expect(await fetchCloudVoices()).toEqual([{ id: "a", name: "Ava" }]);
    await fetchCloudVoices();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is empty on a non-200 or a thrown fetch", async () => {
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 503 }));
    expect(await fetchCloudVoices()).toEqual([]);
    resetCloudVoicesCache();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchCloudVoices()).toEqual([]);
  });
});

describe("fetchCloudVoices retry", () => {
  it("does not cache a 503: the next call fetches again", async () => {
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 503 }));
    expect(await fetchCloudVoices()).toEqual([]);
    expect(await fetchCloudVoices()).toEqual([{ id: "a", name: "Ava" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps one request in flight", async () => {
    await Promise.all([fetchCloudVoices(), fetchCloudVoices()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createCloudSpeaker", () => {
  // 220 char chunks: use long sentences so each is its own chunk.
  const sentence = (c: string) => `${c.repeat(150)}.`;
  const text = [sentence("a"), sentence("b"), sentence("c")].join(" ");

  it("plays chunks in order, fetching the next while one plays, at most two in flight", async () => {
    const speaker = createCloudSpeaker(new FakeDevice());
    speaker.speak(text, OPTS);
    expect(speaker.speaking()).toBe(true);
    await settle();
    expect(pending.map((p) => p.text[0])).toEqual(["a", "b"]);
    pending[1].resolve(mp3());
    await settle();
    expect(FakeAudio.last?.played ?? []).toEqual([]);
    pending[0].resolve(mp3());
    await settle();
    expect(FakeAudio.last?.played).toEqual(["blob:0"]);
    expect(pending.map((p) => p.text[0])).toEqual(["a", "b"]);
    FakeAudio.last?.end();
    await settle();
    expect(pending.map((p) => p.text[0])).toEqual(["a", "b", "c"]);
    expect(FakeAudio.last?.played).toEqual(["blob:0", "blob:1"]);
    pending[2].resolve(mp3());
    FakeAudio.last?.end();
    await settle();
    expect(FakeAudio.last?.played).toEqual(["blob:0", "blob:1", "blob:2"]);
    FakeAudio.last?.end();
    await settle();
    expect(speaker.speaking()).toBe(false);
  });

  it("sends the text, voice and rate as JSON", async () => {
    const speaker = createCloudSpeaker(new FakeDevice());
    speaker.speak("Hello there.", { ...OPTS, rate: 1.25 });
    await settle();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/v1/ae/tts"));
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      text: "Hello there.",
      voice: "en-US-AvaMultilingualNeural",
      rate: 1.25,
    });
  });

  it("stop aborts requests, pauses the audio and empties the queue", async () => {
    const device = new FakeDevice();
    const speaker = createCloudSpeaker(device);
    speaker.speak(text, OPTS);
    await settle();
    pending[0].resolve(mp3());
    await settle();
    const calls = fetchMock.mock.calls.length;
    speaker.stop();
    await settle();
    expect(pending[1].signal?.aborted).toBe(true);
    expect(FakeAudio.last?.pauses).toBe(1);
    expect(speaker.speaking()).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(device.stops).toBe(1);
  });

  it("reads a failed chunk through the device speaker, in order", async () => {
    const device = new FakeDevice();
    const speaker = createCloudSpeaker(device);
    speaker.speak(text, OPTS);
    await settle();
    pending[0].resolve(new Response("down", { status: 503 }));
    pending[1].resolve(mp3());
    await settle();
    expect(device.texts).toEqual([sentence("a")]);
    expect(FakeAudio.last?.played ?? []).toEqual([]);
    device.finish();
    await settle();
    expect(FakeAudio.last?.played).toEqual(["blob:0"]);
  });

  it("falls back when the request throws", async () => {
    const device = new FakeDevice();
    const speaker = createCloudSpeaker(device);
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    speaker.speak("Hi there.", OPTS);
    await settle();
    expect(device.texts).toEqual(["Hi there."]);
    device.finish();
    await settle();
    expect(speaker.speaking()).toBe(false);
  });

  it("notifies subscribers when speaking changes and ignores empty text", async () => {
    const speaker = createCloudSpeaker(new FakeDevice());
    const cb = vi.fn();
    const off = speaker.subscribe(cb);
    speaker.speak("   ", OPTS);
    expect(cb).not.toHaveBeenCalled();
    speaker.speak("Hi there.", OPTS);
    expect(cb).toHaveBeenCalledTimes(1);
    speaker.stop();
    expect(cb).toHaveBeenCalledTimes(2);
    off();
  });
  it("a stopped playback's late play() rejection leaves the next playback alone", async () => {
    const speaker = createCloudSpeaker(new FakeDevice());
    let rejectOld: (e: Error) => void = () => {};
    FakeAudio.plays.push(
      new Promise<void>((_, reject) => {
        rejectOld = reject;
      }),
    );
    speaker.speak("First.", OPTS);
    await settle();
    pending[0].resolve(mp3());
    await settle();
    speaker.stop();
    speaker.speak("Second.", OPTS);
    await settle();
    pending[1].resolve(mp3());
    await settle();
    expect(FakeAudio.last?.played.length).toBe(2);
    rejectOld(new Error("interrupted"));
    await settle();
    FakeAudio.last?.end();
    await settle();
    expect(speaker.speaking()).toBe(false);
  });

  it("routes to the saved speaker before play and falls back to the default on a sink failure", async () => {
    window.localStorage.setItem("omnigent:ae-speaker-device", "spk1");
    const speaker = createCloudSpeaker(new FakeDevice());
    speaker.speak(sentence("a"), OPTS);
    await settle();
    pending[0].resolve(mp3());
    await settle();
    expect(FakeAudio.last?.sinks).toEqual(["spk1"]);
    expect(FakeAudio.last?.played).toEqual(["blob:0"]);
    FakeAudio.last?.end();
    await settle();
    FakeAudio.sinkFail = true;
    window.localStorage.setItem("omnigent:ae-speaker-device", "spk2");
    speaker.speak(sentence("b"), OPTS);
    await settle();
    pending[pending.length - 1].resolve(mp3());
    await settle();
    expect(FakeAudio.last?.sinkId).toBe("");
    expect(FakeAudio.last?.played.length).toBe(2);
    FakeAudio.sinkFail = false;
  });

  it("waits for a slow setSinkId before playing, then plays both sentences once in order", async () => {
    window.localStorage.setItem("omnigent:ae-speaker-device", "spk1");
    let open!: () => void;
    FakeAudio.sinkGate = new Promise<void>((r) => {
      open = r;
    });
    const speaker = createCloudSpeaker(new FakeDevice());
    speaker.speak(`${sentence("a")} ${sentence("b")}`, OPTS);
    await settle();
    pending[0].resolve(mp3());
    pending[1].resolve(mp3());
    await settle();
    expect(FakeAudio.last?.played ?? []).toEqual([]);
    FakeAudio.sinkGate = null;
    open();
    await settle();
    expect(FakeAudio.last?.played).toEqual(["blob:0"]);
    FakeAudio.last?.end();
    await settle();
    expect(FakeAudio.last?.played).toEqual(["blob:0", "blob:1"]);
  });

  it("applies a speaker change between two sentences to the second only", async () => {
    window.localStorage.setItem("omnigent:ae-speaker-device", "spk1");
    const speaker = createCloudSpeaker(new FakeDevice());
    speaker.speak(`${sentence("a")} ${sentence("b")}`, OPTS);
    await settle();
    pending[0].resolve(mp3());
    pending[1].resolve(mp3());
    await settle();
    expect(FakeAudio.last?.sinks).toEqual(["spk1"]);
    window.localStorage.setItem("omnigent:ae-speaker-device", "spk2");
    FakeAudio.last?.end();
    await settle();
    expect(FakeAudio.last?.sinks).toEqual(["spk1", "spk2"]);
    expect(FakeAudio.last?.played).toEqual(["blob:0", "blob:1"]);
  });
});

describe("cloud playback refused by the browser", () => {
  const sentence = (c: string) => `${c.repeat(150)}.`;

  afterEach(() => {
    setCaptionHandler(null);
    clearPlaybackBlocked();
  });

  async function playRefused() {
    const device = new FakeDevice();
    const speaker = createCloudSpeaker(device);
    speaker.speak(sentence("a"), OPTS);
    await settle();
    FakeAudio.plays.push(Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })));
    pending[0].resolve(mp3());
    await settle();
    return { speaker, device };
  }

  it("marks blocked, keeps the item current and does not fall back to the device", async () => {
    const { speaker, device } = await playRefused();
    expect(isPlaybackBlocked()).toBe(true);
    expect(speaker.speaking()).toBe(true);
    expect(device.texts).toEqual([]);
  });

  it("resume plays again inside the tap, clears blocked, and the end finishes the item", async () => {
    const { speaker } = await playRefused();
    const el = FakeAudio.last as FakeAudio;
    resumePlayback();
    await settle();
    expect(el.played.length).toBe(2);
    expect(isPlaybackBlocked()).toBe(false);
    el.end();
    await settle();
    expect(speaker.speaking()).toBe(false);
  });

  it("stop clears blocked", async () => {
    const { speaker } = await playRefused();
    speaker.stop();
    expect(isPlaybackBlocked()).toBe(false);
    expect(speaker.speaking()).toBe(false);
  });

  it("another play error still falls back to the device", async () => {
    const device = new FakeDevice();
    const speaker = createCloudSpeaker(device);
    speaker.speak(sentence("a"), OPTS);
    await settle();
    FakeAudio.plays.push(Promise.reject(new Error("decode")));
    pending[0].resolve(mp3());
    await settle();
    expect(isPlaybackBlocked()).toBe(false);
    expect(device.texts.length).toBe(1);
  });

  it("captions the sentence that plays and clears at the end", async () => {
    const captions: string[] = [];
    setCaptionHandler((t) => captions.push(t));
    const speaker = createCloudSpeaker(new FakeDevice());
    speaker.speak(sentence("a"), OPTS);
    await settle();
    pending[0].resolve(mp3());
    await settle();
    expect(captions).toEqual([sentence("a")]);
    FakeAudio.last?.end();
    await settle();
    expect(captions).toEqual([sentence("a"), ""]);
  });

  it("prime plays a silent wav, then pauses; it leaves a queued sentence alone", async () => {
    const speaker = createCloudSpeaker(new FakeDevice());
    speaker.prime?.();
    await settle();
    const el = FakeAudio.last as FakeAudio;
    expect(el.played[0]).toMatch(/^data:audio\/wav;base64,UklGR/);
    expect(el.pauses).toBe(1);
    speaker.speak(sentence("a"), OPTS);
    const src = el.src;
    speaker.prime?.();
    expect(el.src).toBe(src);
  });
});
