import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvalOf,
  armVoiceForNextChat,
  customAllowed,
  disarmVoiceForNextChat,
  getVoiceSnapshot,
  isDoneWord,
  matchApprovalReply,
  matchSpokenOption,
  matchSpokenOptions,
  questionSpeech,
  readVoiceMode,
  POST_RETRY_MS,
  registerVoiceStop,
  resetVoiceStore,
  setVoiceBlocked,
  setVoiceCaption,
  setVoiceOn,
  stopVoice,
  syncVoiceLabel,
  splitDone,
  takeVoiceArm,
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

  it("takes a number only from a short answer made of number words", () => {
    expect(matchSpokenOption("no one has access yet", LABELS)).toBeNull();
    expect(matchSpokenOption("first check the logs", LABELS)).toBeNull();
    expect(matchSpokenOption("none", LABELS)).toBeNull();
    expect(matchSpokenOption("one", LABELS)).toBe(0);
    expect(matchSpokenOption("I'll take the second one please", LABELS)).toBe(1);
  });

  it("does not pick a label that was said after a negation", () => {
    expect(matchSpokenOption("don't merge yet", ["Merge", "Hold"])).toBeNull();
    expect(matchSpokenOption("not now", ["Now", "Later"])).toBeNull();
    expect(matchSpokenOption("never hold it", ["Hold it", "Go"])).toBeNull();
    expect(matchSpokenOption("no", ["Yes", "No"])).toBe(1);
    expect(matchSpokenOption("merge it", ["Merge", "Hold"])).toBe(0);
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
    expect(splitDone("one and three done")).toMatchObject({ done: true, rest: "one and three" });
    expect(splitDone("two")).toMatchObject({ done: false, rest: "two" });
  });

  it.each(["ok done", "all done", "I'm done", "okay, that's all", "right, that's it"])(
    "leaves no words behind %s",
    (said) => {
      expect(splitDone(said)).toMatchObject({ done: true, rest: "" });
    },
  );

  it("hands back the remainder untrimmed too, so a label ending in a filler word survives", () => {
    expect(splitDone("merge it done")).toMatchObject({ rest: "merge", raw: "merge it" });
    expect(matchSpokenOptions("merge it", ["Merge it", "Hold"])).toEqual([0]);
  });

  it("keeps the picks that come before the closing words", () => {
    expect(splitDone("one and three, ok I'm done")).toMatchObject({
      done: true,
      rest: "one and three",
    });
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
    expect(getVoiceSnapshot("c1")).toMatchObject({ on: true, phase: "starting" });
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

describe("custom answers", () => {
  it("are allowed unless the question says isOther is false", () => {
    expect(customAllowed({})).toBe(true);
    expect(customAllowed({ isOther: true })).toBe(true);
    expect(customAllowed({ isOther: false })).toBe(false);
  });
});

describe("keeping the server label in step", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    resetVoiceStore();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts the local switch when the label disagrees, and does nothing when it agrees", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    syncVoiceLabel("c1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toEqual({ on: false });
    fetchMock.mockClear();
    syncVoiceLabel("c1", false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a failed write once after two seconds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setVoiceOn("c1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POST_RETRY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the one retry", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("no", { status: 500 })));
    vi.stubGlobal("fetch", fetchMock);
    setVoiceOn("c1", true);
    await vi.advanceTimersByTimeAsync(POST_RETRY_MS + 10);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("caption, blocked and stop", () => {
  beforeEach(() => resetVoiceStore());

  it("start empty and unblocked, and change through their setters", () => {
    expect(getVoiceSnapshot("c1").caption).toBe("");
    expect(getVoiceSnapshot("c1").blocked).toBe(false);
    setVoiceCaption("c1", "Hello there.");
    setVoiceBlocked("c1", true);
    expect(getVoiceSnapshot("c1").caption).toBe("Hello there.");
    expect(getVoiceSnapshot("c1").blocked).toBe(true);
    expect(getVoiceSnapshot("c2").caption).toBe("");
  });

  it("stopVoice calls the registered stop for that chat only", () => {
    const stop = vi.fn();
    const other = vi.fn();
    const off = registerVoiceStop("c1", stop);
    registerVoiceStop("c2", other);
    stopVoice("c1");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    off();
    stopVoice("c1");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(() => stopVoice("nobody")).not.toThrow();
  });
});

describe("turning Voice off", () => {
  it("calls the registered stop; turning on does not", () => {
    const stop = vi.fn();
    const off = registerVoiceStop("c1", stop);
    setVoiceOn("c1", true);
    expect(stop).not.toHaveBeenCalled();
    setVoiceOn("c1", false);
    expect(stop).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("arming the next chat", () => {
  afterEach(() => disarmVoiceForNextChat());

  it("takeVoiceArm is false until armed, true once, then false again", () => {
    expect(takeVoiceArm()).toBe(false);
    armVoiceForNextChat();
    expect(takeVoiceArm()).toBe(true);
    expect(takeVoiceArm()).toBe(false);
  });

  it("disarm clears the flag", () => {
    armVoiceForNextChat();
    disarmVoiceForNextChat();
    expect(takeVoiceArm()).toBe(false);
  });
});

describe("matchApprovalReply", () => {
  it.each(["run it", "Run it.", "yes", "yeah", "okay", "OK", "approve", "go ahead"])(
    "accepts exactly %s",
    (said) => {
      expect(matchApprovalReply(said)).toBe("accept");
    },
  );
  it.each(["decline", "no", "cancel", "don't run it", "do not run it", "stop"])(
    "declines exactly %s",
    (said) => {
      expect(matchApprovalReply(said)).toBe("decline");
    },
  );
  it.each([
    "don't say yes",
    "do not approve",
    "never run it",
    "not okay",
    "no way, yes",
    "yes but don't",
    "I would not go ahead",
  ])("never accepts the negated sentence %s", (said) => {
    expect(matchApprovalReply(said)).not.toBe("accept");
  });
  it("matches nothing for two phrases together", () => {
    expect(matchApprovalReply("run it or decline")).toBeNull();
    expect(matchApprovalReply("Say run it, or decline.")).toBeNull();
  });
  it.each(["please run it for me", "yesterday", "okay then let's talk", "nobody", "stopwatch"])(
    "does nothing for the substring in %s",
    (said) => {
      expect(matchApprovalReply(said)).toBeNull();
    },
  );
});

describe("approvalOf", () => {
  const base = {
    type: "elicitation",
    elicitationId: "a1",
    status: "pending",
    contentPreview: "",
    requestedSchema: {},
  };
  it("takes only the session-limit card", () => {
    expect(approvalOf({ ...base, policyName: "ae_slot_cap" } as never)).toEqual({
      id: "a1",
      slotCap: true,
    });
  });
  it.each([undefined, "", "bash_permission", "write_policy", "web_fetch"])(
    "never takes a tool-permission card (policy %s)",
    (policyName) => {
      expect(approvalOf({ ...base, policyName } as never)).toBeNull();
    },
  );
});
