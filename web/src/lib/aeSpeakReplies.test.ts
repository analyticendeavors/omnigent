import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeSynth, installFakeSpeech, makeVoice, removeFakeSpeech } from "@/test/fakeSpeech";
import {
  clearFastAnswersState,
  createSpeaker,
  isSpeechSupported,
  listVoices,
  onVoicesChanged,
  pickDefaultVoice,
  primeVoicePlayback,
  resetPrimeSpeaking,
  rankVoices,
  registerCloudPrimer,
  setCaptionHandler,
  readFastAnswersState,
  readFastEnabled,
  readRate,
  readSpeakReplies,
  readVoiceChoice,
  voiceLabel,
  whenSynthIdle,
  MIC_SYNTH_WAIT_CAP_MS,
  writeFastAnswersState,
  writeFastEnabled,
  writeRate,
  writeSpeakReplies,
  writeVoiceChoice,
} from "./aeSpeakReplies";
import { clearPlaybackBlocked, isPlaybackBlocked, resumePlayback } from "./aeVoicePlayback";

let synth: FakeSynth;

beforeEach(() => {
  window.localStorage.clear();
  synth = installFakeSpeech();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  removeFakeSpeech();
});

const OPTS = { voiceURI: null, rate: 1 };

describe("the speaker", () => {
  it("queues one utterance per chunk, in order", () => {
    const speaker = createSpeaker();
    speaker.speak("First one. Second one.", { voiceURI: null, rate: 1.25 });
    speaker.speak("x".repeat(150) + ". " + "y".repeat(150) + ".", OPTS);
    vi.runAllTimers();
    expect(synth.texts()[0]).toBe("First one. Second one.");
    expect(synth.texts().length).toBe(3);
    expect(synth.spoken[0].rate).toBe(1.25);
  });

  it("is speaking until the last utterance ends", () => {
    const speaker = createSpeaker();
    const seen: boolean[] = [];
    speaker.subscribe(() => seen.push(speaker.speaking()));
    speaker.speak("One. " + "z".repeat(230) + ".", OPTS);
    expect(speaker.speaking()).toBe(true);
    vi.runAllTimers();
    synth.finishNext();
    expect(speaker.speaking()).toBe(true);
    synth.spoken.forEach((u) => u.onend?.());
    expect(speaker.speaking()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("keeps queued utterances referenced until they end", () => {
    synth.retain = false;
    const speaker = createSpeaker();
    speaker.speak("One. " + "z".repeat(230) + ".", OPTS);
    vi.runAllTimers();
    const count = synth.ends.length;
    expect(count).toBeGreaterThan(1);
    expect(speaker.retained()).toBe(count);
    synth.ends[0]();
    expect(speaker.retained()).toBe(count - 1);
    synth.ends.slice(1).forEach((end) => end());
    expect(speaker.retained()).toBe(0);
    speaker.speak("Again.", OPTS);
    vi.runAllTimers();
    expect(speaker.retained()).toBe(1);
    speaker.stop();
    expect(speaker.retained()).toBe(0);
  });

  it("stop cancels and drops utterances not yet queued", () => {
    const speaker = createSpeaker();
    speaker.speak("Hello there.", OPTS);
    speaker.stop();
    vi.runAllTimers();
    expect(synth.cancelCount).toBe(1);
    expect(synth.spoken).toEqual([]);
    expect(speaker.speaking()).toBe(false);
  });

  it("uses the chosen voice by uri, else the default pick", () => {
    synth.voices = [
      makeVoice({ name: "Plain", lang: "en-US" }),
      makeVoice({ name: "Microsoft Aria Online (Natural)", lang: "en-US", voiceURI: "aria" }),
    ];
    const speaker = createSpeaker();
    speaker.speak("One.", { voiceURI: "Plain", rate: 1 });
    speaker.speak("Two.", OPTS);
    vi.runAllTimers();
    expect((synth.spoken[0].voice as { name: string }).name).toBe("Plain");
    expect((synth.spoken[1].voice as { name: string }).name).toContain("Aria");
    expect(synth.spoken[1].lang).toBe("en-US");
  });
});

describe("voices", () => {
  it("ranks a Natural voice above a plain one of the same language", () => {
    const plain = makeVoice({ name: "Plain", lang: "en-US", default: true });
    const natural = makeVoice({ name: "Aria Online (Natural)", lang: "en-GB" });
    expect(rankVoices([plain, natural], "en-US")[0]).toBe(natural);
  });

  it("ranks a same-language plain voice above a Natural one of another language", () => {
    const plain = makeVoice({ name: "Plain", lang: "en-US" });
    const natural = makeVoice({ name: "Denise Online (Natural)", lang: "fr-FR" });
    expect(rankVoices([natural, plain], "en-US")[0]).toBe(plain);
    expect(pickDefaultVoice([natural, plain], "en-US")).toBe(plain);
    expect(pickDefaultVoice([], "en-US")).toBeNull();
  });

  it("orders Google, then Premium, then default, then name", () => {
    const voices = [
      makeVoice({ name: "Zed", lang: "en-US", default: true }),
      makeVoice({ name: "Alice Premium", lang: "en-US" }),
      makeVoice({ name: "Google US English", lang: "en-US" }),
      makeVoice({ name: "Bob", lang: "en-US" }),
    ];
    expect(rankVoices(voices, "en-US").map((v) => v.name)).toEqual([
      "Google US English",
      "Alice Premium",
      "Zed",
      "Bob",
    ]);
  });

  it("shortens labels", () => {
    expect(voiceLabel({ name: "Microsoft Aria Online (Natural) - English (United States)" })).toBe(
      "Aria (Natural)",
    );
    expect(voiceLabel({ name: "Google US English" })).toBe("US English");
    expect(voiceLabel({ name: "Google" })).toBe("Google");
    expect(voiceLabel({ name: "Samantha" })).toBe("Samantha");
  });

  it("lists voices and reports voiceschanged", () => {
    synth.voices = [makeVoice({ name: "A", lang: "en-US" })];
    expect(listVoices()).toHaveLength(1);
    const cb = vi.fn();
    const off = onVoicesChanged(cb);
    synth.emitVoicesChanged();
    off();
    synth.emitVoicesChanged();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("preferences", () => {
  it("defaults and round trips", () => {
    expect(readSpeakReplies("c1")).toBe(false);
    writeSpeakReplies("c1", true);
    expect(readSpeakReplies("c1")).toBe(true);
    expect(readSpeakReplies("c2")).toBe(false);
    writeSpeakReplies("c1", false);
    expect(window.localStorage.length).toBe(0);

    expect(readFastAnswersState("c1")).toBeNull();
    writeFastAnswersState("c1", { previousEffort: "high" });
    expect(readFastAnswersState("c1")).toEqual({ previousEffort: "high" });
    writeFastAnswersState("c1", { previousEffort: null });
    expect(readFastAnswersState("c1")).toEqual({ previousEffort: null });
    clearFastAnswersState("c1");
    expect(readFastAnswersState("c1")).toBeNull();

    expect(readFastEnabled()).toBe(true);
    writeFastEnabled(false);
    expect(readFastEnabled()).toBe(false);
    writeFastEnabled(true);
    expect(readFastEnabled()).toBe(true);

    expect(readVoiceChoice()).toBeNull();
    writeVoiceChoice({ kind: "device", id: "v1" });
    expect(readVoiceChoice()).toEqual({ kind: "device", id: "v1" });
    writeVoiceChoice({ kind: "cloud", id: "en-US-AvaMultilingualNeural" });
    expect(window.localStorage.getItem("omnigent:ae-speak-voice")).toBe(
      "cloud:en-US-AvaMultilingualNeural",
    );
    expect(readVoiceChoice()).toEqual({ kind: "cloud", id: "en-US-AvaMultilingualNeural" });
    window.localStorage.setItem("omnigent:ae-speak-voice", "Microsoft Aria");
    expect(readVoiceChoice()).toEqual({ kind: "device", id: "Microsoft Aria" });
    writeVoiceChoice(null);
    expect(readVoiceChoice()).toBeNull();

    expect(readRate()).toBe(1);
    writeRate(1.25);
    expect(readRate()).toBe(1.25);
    writeRate(1);
    expect(readRate()).toBe(1);
  });

  it("ignores a corrupt fast state", () => {
    window.localStorage.setItem("omnigent:ae-speak-fast:c1", "{nope");
    expect(readFastAnswersState("c1")).toBeNull();
  });
});

describe("without the speech api", () => {
  it("throws nothing and reports unsupported", () => {
    removeFakeSpeech();
    expect(isSpeechSupported()).toBe(false);
    expect(listVoices()).toEqual([]);
    const off = onVoicesChanged(() => {});
    off();
    const speaker = createSpeaker();
    speaker.speak("Hello.", OPTS);
    speaker.stop();
    expect(speaker.speaking()).toBe(false);
  });
});

describe("priming playback", () => {
  afterEach(() => registerCloudPrimer(null));

  it("primes the cloud speaker and speaks a silent utterance on the device", () => {
    const cloud = vi.fn();
    registerCloudPrimer(cloud);
    primeVoicePlayback();
    expect(cloud).toHaveBeenCalledTimes(1);
    expect(synth.spokenTexts).toEqual([" "]);
    expect((synth.spoken[0] as unknown as { volume: number }).volume).toBe(0);
  });

  it("leaves a speaking device alone", () => {
    synth.speaking = true;
    primeVoicePlayback();
    expect(synth.spokenTexts).toEqual([]);
  });

  it("never throws, with no speech api or a throwing primer", () => {
    registerCloudPrimer(() => {
      throw new Error("x");
    });
    removeFakeSpeech();
    expect(() => primeVoicePlayback()).not.toThrow();
  });
});

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

function setUserAgent(ua: string): void {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
}

describe("priming and the mic on WebKit", () => {
  afterEach(() => {
    delete (navigator as { userAgent?: unknown }).userAgent;
    registerCloudPrimer(null);
    resetPrimeSpeaking();
  });

  /** Speak the silent prime on a WebKit device voice, as a tap does. */
  function primeDeviceVoice(): void {
    writeVoiceChoice({ kind: "device", id: "x" });
    primeVoicePlayback();
  }

  it("WebKit with the cloud voice speaks no silent utterance", () => {
    setUserAgent(IPHONE_UA);
    writeVoiceChoice({ kind: "cloud", id: "v1" });
    const cloud = vi.fn();
    registerCloudPrimer(cloud);
    primeVoicePlayback();
    expect(cloud).toHaveBeenCalledTimes(1);
    expect(synth.spokenTexts).toEqual([]);
  });

  it("WebKit with the device voice still primes", () => {
    setUserAgent(IPHONE_UA);
    writeVoiceChoice({ kind: "device", id: "x" });
    primeVoicePlayback();
    expect(synth.spokenTexts).toEqual([" "]);
  });

  it("Chrome with the cloud voice is unchanged", () => {
    setUserAgent(CHROME_UA);
    writeVoiceChoice({ kind: "cloud", id: "v1" });
    primeVoicePlayback();
    expect(synth.spokenTexts).toEqual([" "]);
  });

  it("WebKit mic start waits until the synthesizer stops speaking", () => {
    setUserAgent(IPHONE_UA);
    primeDeviceVoice();
    synth.speaking = true;
    const go = vi.fn();
    whenSynthIdle(go);
    vi.advanceTimersByTime(300);
    expect(go).not.toHaveBeenCalled();
    synth.speaking = false;
    vi.advanceTimersByTime(100);
    expect(go).toHaveBeenCalledTimes(1);
    expect(synth.cancelCount).toBe(0);
  });

  it("WebKit mic start gives up at the cap and cancels the synthesizer", () => {
    setUserAgent(IPHONE_UA);
    primeDeviceVoice();
    synth.speaking = true;
    const go = vi.fn();
    whenSynthIdle(go);
    vi.advanceTimersByTime(MIC_SYNTH_WAIT_CAP_MS - 100);
    expect(go).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(go).toHaveBeenCalledTimes(1);
    expect(synth.cancelCount).toBe(1);
  });

  it("a cancelled wait never starts", () => {
    setUserAgent(IPHONE_UA);
    primeDeviceVoice();
    synth.speaking = true;
    const go = vi.fn();
    whenSynthIdle(go)();
    vi.advanceTimersByTime(MIC_SYNTH_WAIT_CAP_MS + 500);
    expect(go).not.toHaveBeenCalled();
  });

  it("a real reply speaking (no prime) starts at once and is never cancelled", () => {
    setUserAgent(IPHONE_UA);
    synth.speaking = true;
    const go = vi.fn();
    whenSynthIdle(go);
    expect(go).toHaveBeenCalledTimes(1);
    expect(synth.cancelCount).toBe(0);
  });

  it("after the prime ends, a later real reply is not waited for", () => {
    setUserAgent(IPHONE_UA);
    primeDeviceVoice();
    synth.finishNext();
    synth.speaking = true;
    const go = vi.fn();
    whenSynthIdle(go);
    expect(go).toHaveBeenCalledTimes(1);
    expect(synth.cancelCount).toBe(0);
  });

  it("a real reply that starts during the wait is not cancelled at the cap", () => {
    setUserAgent(IPHONE_UA);
    primeDeviceVoice();
    synth.speaking = true;
    const go = vi.fn();
    whenSynthIdle(go);
    synth.finishNext();
    vi.advanceTimersByTime(MIC_SYNTH_WAIT_CAP_MS + 100);
    expect(go).toHaveBeenCalledTimes(1);
    expect(synth.cancelCount).toBe(0);
  });

  it("Chrome and an idle WebKit synthesizer start at once", () => {
    setUserAgent(CHROME_UA);
    synth.speaking = true;
    const a = vi.fn();
    whenSynthIdle(a);
    expect(a).toHaveBeenCalledTimes(1);
    setUserAgent(IPHONE_UA);
    synth.speaking = false;
    const b = vi.fn();
    whenSynthIdle(b);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("the speaker's captions and refused playback", () => {
  afterEach(() => {
    setCaptionHandler(null);
    clearPlaybackBlocked();
  });

  it("captions each sentence as it starts and clears when the queue empties", () => {
    const captions: string[] = [];
    setCaptionHandler((t) => captions.push(t));
    const speaker = createSpeaker();
    speaker.speak("One. " + "z".repeat(230) + ".", OPTS);
    vi.runAllTimers();
    synth.spoken[0].onstart?.();
    expect(captions).toEqual(["One. "].map(() => synth.spokenTexts[0]));
    synth.spoken.forEach((u) => u.onend?.());
    expect(captions[captions.length - 1]).toBe("");
  });

  it("a not-allowed error marks playback blocked and keeps speaking() true", () => {
    const speaker = createSpeaker();
    speaker.speak("Hello there.", OPTS);
    vi.runAllTimers();
    synth.spoken[0].onerror?.({ error: "not-allowed" });
    expect(isPlaybackBlocked()).toBe(true);
    expect(speaker.speaking()).toBe(true);
  });

  it("resume speaks the same item again and clears blocked once it starts", () => {
    const speaker = createSpeaker();
    speaker.speak("Hello there.", OPTS);
    vi.runAllTimers();
    synth.spoken[0].onerror?.({ error: "not-allowed" });
    resumePlayback();
    expect(synth.spokenTexts).toEqual(["Hello there.", "Hello there."]);
    expect(isPlaybackBlocked()).toBe(true);
    synth.spoken[1].onstart?.();
    expect(isPlaybackBlocked()).toBe(false);
    synth.spoken[1].onend?.();
    expect(speaker.speaking()).toBe(false);
  });

  it("every refused chunk is spoken again, in order", () => {
    const speaker = createSpeaker();
    speaker.speak("One. " + "z".repeat(230) + ".", OPTS);
    vi.runAllTimers();
    const first = synth.spokenTexts.length;
    synth.spoken.forEach((u) => u.onerror?.({ error: "not-allowed" }));
    resumePlayback();
    expect(synth.spokenTexts.slice(first)).toEqual(synth.spokenTexts.slice(0, first));
  });

  it("stop clears blocked", () => {
    const speaker = createSpeaker();
    speaker.speak("Hello there.", OPTS);
    vi.runAllTimers();
    synth.spoken[0].onerror?.({ error: "not-allowed" });
    speaker.stop();
    expect(isPlaybackBlocked()).toBe(false);
    expect(speaker.speaking()).toBe(false);
  });

  it("any other error ends the item as before", () => {
    const speaker = createSpeaker();
    speaker.speak("Hello there.", OPTS);
    vi.runAllTimers();
    synth.spoken[0].onerror?.({ error: "synthesis-failed" });
    expect(isPlaybackBlocked()).toBe(false);
    expect(speaker.speaking()).toBe(false);
  });
});
