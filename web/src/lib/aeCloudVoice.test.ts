import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCloudSpeaker,
  fetchCloudVoiceList,
  fetchCloudVoices,
  resetCloudVoicesCache,
} from "./aeCloudVoice";
import {
  MIC_AUDIO_SETTLE_MS,
  MIC_SYNTH_POLL_MS,
  registerCloudReleaser,
  setCaptionHandler,
  setPlaybackHandler,
  type Speaker,
  type SpeakOptions,
  whenSynthIdle,
} from "./aeSpeakReplies";
import { clearPlaybackBlocked, isPlaybackBlocked, resumePlayback } from "./aeVoicePlayback";

const OPTS: SpeakOptions = { voiceURI: null, rate: 1, cloudVoiceId: "en-US-AvaMultilingualNeural" };

class FakeAudio {
  static last: FakeAudio | null = null;
  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  played: string[] = [];
  pauses = 0;
  loads = 0;
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
  load() {
    this.loads++;
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

describe("fetchCloudVoiceList", () => {
  it("tells a loaded empty list from a list not loaded", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ voices: [] }), { status: 200 }));
    expect(await fetchCloudVoiceList()).toEqual([]);
    resetCloudVoicesCache();
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 503 }));
    expect(await fetchCloudVoiceList()).toBeNull();
    resetCloudVoicesCache();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchCloudVoiceList()).toBeNull();
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

  it("releases the audio element once the queue drains and plays the next reply after", async () => {
    const speaker = createCloudSpeaker(new FakeDevice());
    speaker.speak("Hello there.", OPTS);
    await settle();
    pending[0].resolve(mp3());
    await settle();
    expect(FakeAudio.last?.loads).toBe(0);
    FakeAudio.last?.end();
    await settle();
    expect(speaker.speaking()).toBe(false);
    const el = FakeAudio.last;
    expect(el?.loads).toBe(1);
    expect(el?.src).toBe("");
    expect(el?.pauses).toBe(1);
    speaker.speak("Again.", OPTS);
    await settle();
    pending[1].resolve(mp3());
    await settle();
    expect(FakeAudio.last).toBe(el);
    expect(el?.played).toHaveLength(2);
  });

  describe("release before the mic", () => {
    const IPHONE =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const CHROME =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
    const setUa = (ua: string) =>
      Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
    const SAFARI_DESKTOP =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    afterEach(() => {
      vi.useRealTimers();
      registerCloudReleaser(null);
      delete (navigator as { userAgent?: unknown }).userAgent;
    });

    async function playOne(speaker: ReturnType<typeof createCloudSpeaker>) {
      speaker.speak("Hello there.", OPTS);
      await settle();
      pending[0].resolve(mp3());
      await settle();
    }

    it("WebKit: the mic callback runs after the source is cleared and load() ran, through the real releaser", async () => {
      setUa(IPHONE);
      const speaker = createCloudSpeaker(new FakeDevice());
      await playOne(speaker);
      const el = FakeAudio.last;
      el?.end();
      await settle();
      expect(el?.loads).toBe(1);
      registerCloudReleaser(
        () => speaker.releaseForMic?.() ?? 0,
        () => speaker.speaking(),
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let loadsAtMic = -1;
      let srcAtMic = "unset";
      whenSynthIdle(() => {
        loadsAtMic = el?.loads ?? -1;
        srcAtMic = el?.src ?? "none";
      });
      expect(loadsAtMic).toBe(-1);
      vi.advanceTimersByTime(MIC_AUDIO_SETTLE_MS);
      expect(loadsAtMic).toBe(1);
      expect(srcAtMic).toBe("");
    });

    it("WebKit: prime() then releaseForMic releases the silent clip and applies the settle", async () => {
      setUa(IPHONE);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const speaker = createCloudSpeaker(new FakeDevice());
      speaker.prime?.();
      const el = FakeAudio.last;
      expect(el?.src).not.toBe("");
      // The prime is still mid-play at mic start: released now, with the full settle.
      expect(speaker.releaseForMic?.()).toBe(MIC_AUDIO_SETTLE_MS);
      expect(el?.src).toBe("");
      expect(el?.loads).toBe(1);
      // The prime's own late release finds the element already free.
      await vi.advanceTimersByTimeAsync(0);
      expect(el?.loads).toBe(1);
    });

    it("WebKit: a prime that ended on its own counts as a release for the settle", async () => {
      setUa(IPHONE);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const speaker = createCloudSpeaker(new FakeDevice());
      speaker.prime?.();
      const el = FakeAudio.last;
      await vi.advanceTimersByTimeAsync(0);
      expect(el?.src).toBe("");
      expect(el?.loads).toBe(1);
      expect(speaker.releaseForMic?.()).toBe(MIC_AUDIO_SETTLE_MS);
      expect(el?.loads).toBe(1);
    });

    it("WebKit: the settle left is MIC_AUDIO_SETTLE_MS minus the time since the release", async () => {
      setUa(IPHONE);
      const speaker = createCloudSpeaker(new FakeDevice());
      await playOne(speaker);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      FakeAudio.last?.end();
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(100);
      expect(speaker.releaseForMic?.()).toBe(MIC_AUDIO_SETTLE_MS - 100);
      vi.advanceTimersByTime(MIC_AUDIO_SETTLE_MS);
      expect(speaker.releaseForMic?.()).toBe(0);
    });

    it("WebKit: a reply that starts during the settle makes the mic wait, then release and settle again", async () => {
      setUa(IPHONE);
      const speaker = createCloudSpeaker(new FakeDevice());
      await playOne(speaker);
      FakeAudio.last?.end();
      await settle();
      registerCloudReleaser(
        () => speaker.releaseForMic?.() ?? 0,
        () => speaker.speaking(),
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const go = vi.fn();
      whenSynthIdle(go);
      vi.advanceTimersByTime(50);
      speaker.speak("Again.", OPTS);
      vi.advanceTimersByTime(MIC_AUDIO_SETTLE_MS + 1000);
      expect(go).not.toHaveBeenCalled();
      speaker.stop();
      vi.advanceTimersByTime(MIC_SYNTH_POLL_MS);
      expect(go).not.toHaveBeenCalled();
      vi.advanceTimersByTime(MIC_AUDIO_SETTLE_MS);
      expect(go).toHaveBeenCalledTimes(1);
    });

    it("WebKit: cancelling while the mic waits for a reply never starts it", async () => {
      setUa(IPHONE);
      const speaker = createCloudSpeaker(new FakeDevice());
      await playOne(speaker);
      FakeAudio.last?.end();
      await settle();
      registerCloudReleaser(
        () => speaker.releaseForMic?.() ?? 0,
        () => speaker.speaking(),
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const go = vi.fn();
      const cancel = whenSynthIdle(go);
      speaker.speak("Again.", OPTS);
      vi.advanceTimersByTime(MIC_AUDIO_SETTLE_MS);
      cancel();
      speaker.stop();
      vi.advanceTimersByTime(MIC_SYNTH_POLL_MS + MIC_AUDIO_SETTLE_MS + 500);
      expect(go).not.toHaveBeenCalled();
    });

    it("desktop Safari: a barge-in stop clears the source and calls load()", async () => {
      setUa(SAFARI_DESKTOP);
      const speaker = createCloudSpeaker(new FakeDevice());
      await playOne(speaker);
      const el = FakeAudio.last;
      speaker.stop();
      expect(el?.src).toBe("");
      expect(el?.loads).toBe(1);
      expect(speaker.releaseForMic?.()).toBeGreaterThan(0);
    });

    it("WebKit: a barge-in stop clears the source and calls load()", async () => {
      setUa(IPHONE);
      const speaker = createCloudSpeaker(new FakeDevice());
      await playOne(speaker);
      const el = FakeAudio.last;
      speaker.stop();
      expect(el?.src).toBe("");
      expect(el?.loads).toBe(1);
      expect(speaker.releaseForMic?.()).toBeGreaterThan(0);
    });

    it("WebKit: a play error releases the element", async () => {
      setUa(IPHONE);
      const speaker = createCloudSpeaker(new FakeDevice());
      await playOne(speaker);
      const el = FakeAudio.last;
      el?.onerror?.();
      await settle();
      expect(el?.loads).toBeGreaterThanOrEqual(1);
      expect(el?.src).toBe("");
    });

    it("Chrome: a stop does not call load()", async () => {
      setUa(CHROME);
      const speaker = createCloudSpeaker(new FakeDevice());
      await playOne(speaker);
      const el = FakeAudio.last;
      speaker.stop();
      expect(el?.loads).toBe(0);
    });

    it("never releases a reply that is still speaking, and the next sentence plays again", async () => {
      setUa(IPHONE);
      const speaker = createCloudSpeaker(new FakeDevice());
      await playOne(speaker);
      const el = FakeAudio.last;
      expect(speaker.releaseForMic?.()).toBe(0);
      expect(el?.loads).toBe(0);
      el?.end();
      await settle();
      speaker.speak("Again.", OPTS);
      await settle();
      pending[1].resolve(mp3());
      await settle();
      expect(FakeAudio.last).toBe(el);
      expect(el?.played).toHaveLength(2);
      expect(el?.src).not.toBe("");
    });
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

  it("reports real playback on the audio's playing event and the end on stop", async () => {
    const seen: boolean[] = [];
    setPlaybackHandler((p) => seen.push(p));
    const speaker = createCloudSpeaker(new FakeDevice());
    speaker.speak("Hello there.", OPTS);
    await settle();
    // Queued but still being made: nothing plays yet.
    expect(seen).toEqual([]);
    pending[0].resolve(mp3());
    await settle();
    // Play was asked for, but the element has not reported playing yet.
    expect(FakeAudio.last?.played).toHaveLength(1);
    expect(seen).toEqual([]);
    FakeAudio.last?.onplaying?.();
    expect(seen).toEqual([true]);
    speaker.stop();
    expect(seen).toEqual([true, false]);
    setPlaybackHandler(null);
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
    FakeAudio.plays.push(
      Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })),
    );
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

  it("a late refusal after stop does not mark blocked again", async () => {
    const device = new FakeDevice();
    const speaker = createCloudSpeaker(device);
    speaker.speak(sentence("a"), OPTS);
    await settle();
    let reject: (e: unknown) => void = () => {};
    FakeAudio.plays.push(
      new Promise<void>((_, r) => {
        reject = r;
      }),
    );
    pending[0].resolve(mp3());
    await settle();
    speaker.stop();
    reject(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    await settle();
    expect(isPlaybackBlocked()).toBe(false);
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
    // Released afterwards, so WebKit lets go of the audio session for the mic.
    expect(el.src).toBe("");
    expect(el.loads).toBe(1);
    speaker.speak(sentence("a"), OPTS);
    const src = el.src;
    speaker.prime?.();
    expect(el.src).toBe(src);
  });
});
