import { afterEach, describe, expect, it, vi } from "vitest";
import { dedupeIosVoices, isSilentIosVoice, listVoices } from "./aeSpeakReplies";

const v = (name: string, voiceURI: string) => ({ name, voiceURI, lang: "en-US" }) as SpeechSynthesisVoice;
const voices = [
  v("Samantha", "com.apple.voice.compact.en-US.Samantha"),
  v("Bad News", "com.apple.speech.synthesis.voice.BadNews"),
  v("Alex", "com.apple.speech.synthesis.voice.Alex"),
  v("Bubbles", "Bubbles"),
];

function stub(ua: string) {
  vi.stubGlobal("navigator", { userAgent: ua, maxTouchPoints: 5, language: "en-US" });
  vi.stubGlobal("speechSynthesis", { getVoices: () => voices });
  window.speechSynthesis = globalThis.speechSynthesis as SpeechSynthesis;
  vi.stubGlobal("SpeechSynthesisUtterance", function () {});
}

afterEach(() => vi.unstubAllGlobals());

describe("silent iOS voices", () => {
  it("flags novelty voices by URI or name", () => {
    expect(isSilentIosVoice(voices[0])).toBe(false);
    expect(isSilentIosVoice(voices[1])).toBe(true);
    expect(isSilentIosVoice(voices[2])).toBe(false);
    expect(isSilentIosVoice(voices[3])).toBe(true);
  });

  it("hides them on iPhone only", () => {
    stub("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)");
    expect(listVoices().map((x) => x.name)).toEqual(["Samantha", "Alex"]);
    stub("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(listVoices()).toHaveLength(4);
  });
});

describe("duplicate iOS voices", () => {
  it("keeps the best quality copy of a name", () => {
    const compact = v("Samantha", "com.apple.voice.compact.en-US.Samantha");
    const enhanced = v("Samantha", "com.apple.voice.enhanced.en-US.Samantha");
    const daniel = v("Daniel", "com.apple.voice.compact.en-GB.Daniel");
    expect(dedupeIosVoices([compact, daniel, enhanced])).toEqual([daniel, enhanced]);
  });
});
