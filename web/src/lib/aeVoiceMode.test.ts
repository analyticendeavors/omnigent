import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getVoiceSnapshot,
  isDoneWord,
  matchSpokenOption,
  matchSpokenOptions,
  questionSpeech,
  readVoiceMode,
  resetVoiceStore,
  setVoiceOn,
  splitDone,
} from "./aeVoiceMode";

const LABELS = ["Force it when the image lands", "Let the timer do it", "Hold it"];

describe("matchSpokenOption", () => {
  it.each([
    ["one", 0],
    ["1", 0],
    ["the first one", 0],
    ["option two", 1],
    ["the second one", 1],
    ["Number 3.", 2],
  ])("picks by number: %s", (said, index) => {
    expect(matchSpokenOption(said, LABELS)).toBe(index);
  });

  it("matches a label said whole, in any case", () => {
    expect(matchSpokenOption("let the timer do it", LABELS)).toBe(1);
    expect(matchSpokenOption("HOLD IT please", LABELS)).toBe(2);
  });

  it("matches when every word of a label was said", () => {
    expect(matchSpokenOption("timer, let it do the thing", LABELS)).toBe(1);
  });

  it("matches a short answer made of one label's words", () => {
    expect(matchSpokenOption("force it", LABELS)).toBe(0);
  });

  it("returns null for no match, an unclear one or a number out of range", () => {
    expect(matchSpokenOption("what about next week", LABELS)).toBeNull();
    expect(matchSpokenOption("do it", LABELS)).toBeNull();
    expect(matchSpokenOption("five", LABELS)).toBeNull();
    expect(matchSpokenOption("", LABELS)).toBeNull();
    expect(matchSpokenOption("one", [])).toBeNull();
  });
});

describe("matchSpokenOptions and done", () => {
  it("collects several picks", () => {
    expect(matchSpokenOptions("one and three", LABELS)).toEqual([0, 2]);
    expect(matchSpokenOptions("hold it, the timer", LABELS)).toEqual([1, 2]);
  });

  it("hears done", () => {
    expect(isDoneWord("done")).toBe(true);
    expect(isDoneWord("Okay, that's all")).toBe(true);
    expect(isDoneWord("one")).toBe(false);
    expect(splitDone("one and three done")).toEqual({ done: true, rest: "one and three" });
    expect(splitDone("two")).toEqual({ done: false, rest: "two" });
  });
});

describe("questionSpeech", () => {
  it("reads the question and the labels, not the descriptions", () => {
    expect(questionSpeech("How should it deploy", ["Force it", "Hold it."])).toBe(
      "Question. How should it deploy. One, Force it. Two, Hold it.",
    );
  });
});

describe("the per-chat switch", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetVoiceStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("{}", { status: 200 }))),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is off by default, remembered per chat, and tells the server", () => {
    expect(getVoiceSnapshot("c1").on).toBe(false);
    setVoiceOn("c1", true);
    expect(getVoiceSnapshot("c1")).toMatchObject({ on: true, phase: "listening" });
    expect(readVoiceMode("c1")).toBe(true);
    expect(readVoiceMode("c2")).toBe(false);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(String(call[0])).toContain("/v1/ae/sessions/c1/voice");
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ on: true });
    setVoiceOn("c1", false);
    expect(readVoiceMode("c1")).toBe(false);
    expect(getVoiceSnapshot("c1").phase).toBe("off");
  });
});
