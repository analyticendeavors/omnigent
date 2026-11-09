import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeaker } from "@/lib/aeSpeakReplies";
import {
  GRACE_MS,
  registerVoiceSpeaker,
  RESUME_MS,
  resetVoiceStore,
  setVoiceOn,
  setVoiceSpeaking,
  getVoiceSnapshot,
} from "@/lib/aeVoiceMode";
import { useChatStore } from "@/store/chatStore";
import { installFakeSpeech, removeFakeSpeech, type FakeSynth } from "@/test/fakeSpeech";
import { useAeVoiceMode } from "./useAeVoiceMode";

const CARD = {
  type: "elicitation",
  ctx: { depth: 0 },
  elicitationId: "e1",
  status: "pending",
  targetSessionId: null,
  contentPreview: "",
  askUserQuestion: {
    questions: [
      {
        question: "How should it deploy?",
        multiSelect: false,
        options: [
          { label: "Force it", description: "Now." },
          { label: "Let the timer do it", description: "Later." },
          { label: "Hold it", description: "Wait." },
        ],
      },
    ],
  },
};

let synth: FakeSynth;
let listening = false;
const controller = {
  current: {
    start: vi.fn(() => {
      listening = true;
    }),
    stop: vi.fn(() => {
      listening = false;
    }),
    isListening: () => listening,
  },
};
const submit = vi.fn();
const submitApproval = vi.fn(() => Promise.resolve());

function mount(initial: { value?: string; status?: string } = {}) {
  return renderHook(
    (props: { value: string; status: string }) =>
      useAeVoiceMode({ chatId: "c1", controller, submit, ...props }),
    { initialProps: { value: initial.value ?? "", status: initial.status ?? "idle" } },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  resetVoiceStore();
  listening = false;
  controller.current.start.mockClear();
  controller.current.stop.mockClear();
  submit.mockClear();
  submitApproval.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}", { status: 200 }))),
  );
  synth = installFakeSpeech();
  useChatStore.setState({
    conversationId: "c1",
    blocks: [],
    status: "idle",
    submitApproval,
  } as never);
  setVoiceOn("c1", true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  removeFakeSpeech();
});

describe("useAeVoiceMode", () => {
  it("starts the mic when on and idle", () => {
    mount();
    expect(controller.current.start).toHaveBeenCalledTimes(1);
  });

  it("sends the draft 600 ms after a final", () => {
    const { result } = mount({ value: "hello there" });
    act(() => void result.current.onFinal("hello there"));
    act(() => void vi.advanceTimersByTime(GRACE_MS - 1));
    expect(submit).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(controller.current.stop).toHaveBeenCalled();
  });

  it("a new partial inside the grace cancels the send", () => {
    const { result } = mount({ value: "hello" });
    act(() => void result.current.onFinal("hello"));
    act(() => void vi.advanceTimersByTime(400));
    act(() => void result.current.onPartial("and also"));
    act(() => void vi.advanceTimersByTime(2000));
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not send an empty draft", () => {
    const { result } = mount({ value: "  " });
    act(() => void result.current.onFinal("x"));
    act(() => void vi.advanceTimersByTime(2000));
    expect(submit).not.toHaveBeenCalled();
  });

  it("sends nothing while speaking, and resumes listening 300 ms after it ends", () => {
    const speaker = createSpeaker();
    speaker.subscribe(() => setVoiceSpeaking("c1", speaker.speaking()));
    const { result } = mount({ value: "hello" });
    act(() => speaker.speak("A reply.", { voiceURI: null, rate: 1 }));
    expect(getVoiceSnapshot("c1").speaking).toBe(true);
    expect(controller.current.stop).toHaveBeenCalled();
    act(() => void result.current.onFinal("hello"));
    act(() => void vi.advanceTimersByTime(2000));
    expect(submit).not.toHaveBeenCalled();
    controller.current.start.mockClear();
    act(() => void synth.finishNext());
    act(() => void vi.advanceTimersByTime(RESUME_MS - 1));
    expect(controller.current.start).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(controller.current.start).toHaveBeenCalledTimes(1);
  });

  it("keeps the mic off while the reply streams", () => {
    const { rerender } = mount({ value: "hi", status: "idle" });
    rerender({ value: "", status: "streaming" });
    expect(controller.current.stop).toHaveBeenCalled();
    controller.current.start.mockClear();
    rerender({ value: "", status: "idle" });
    act(() => void vi.advanceTimersByTime(RESUME_MS));
    expect(controller.current.start).toHaveBeenCalledTimes(1);
  });

  it("reads a question card and picks the option that was said", () => {
    const speaker = createSpeaker();
    registerVoiceSpeaker("c1", (t) => speaker.speak(t, { voiceURI: null, rate: 1 }));
    useChatStore.setState({ blocks: [CARD] } as never);
    const { result } = mount({ status: "streaming" });
    act(() => void vi.advanceTimersByTime(50));
    expect(synth.texts()).toEqual([
      "Question. How should it deploy? One, Force it. Two, Let the timer do it. Three, Hold it.",
    ]);
    let used = false;
    act(() => {
      used = result.current.onFinal("option two");
    });
    expect(used).toBe(true);
    expect(submitApproval).toHaveBeenCalledWith("e1", "accept", {
      "How should it deploy?": "Let the timer do it",
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("sends an unmatched answer as the card's own words after the grace", () => {
    useChatStore.setState({ blocks: [CARD] } as never);
    const { result } = mount();
    act(() => void result.current.onFinal("ask me tomorrow"));
    expect(submitApproval).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(GRACE_MS));
    expect(submitApproval).toHaveBeenCalledWith("e1", "accept", {
      "How should it deploy?": "ask me tomorrow",
    });
  });

  it("never answers a card on silence", () => {
    useChatStore.setState({ blocks: [CARD] } as never);
    mount();
    act(() => void vi.advanceTimersByTime(120_000));
    expect(submitApproval).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("collects picks on a multi-select card until done", () => {
    const multi = {
      ...CARD,
      askUserQuestion: {
        questions: [{ ...CARD.askUserQuestion.questions[0], multiSelect: true }],
      },
    };
    useChatStore.setState({ blocks: [multi] } as never);
    const { result } = mount();
    act(() => void result.current.onFinal("one"));
    act(() => void result.current.onFinal("three"));
    expect(submitApproval).not.toHaveBeenCalled();
    act(() => void result.current.onFinal("done"));
    expect(submitApproval).toHaveBeenCalledWith("e1", "accept", {
      "How should it deploy?": ["Force it", "Hold it"],
    });
  });

  it("stays out of the way when off", () => {
    setVoiceOn("c1", false);
    const { result } = mount({ value: "hi" });
    expect(controller.current.start).not.toHaveBeenCalled();
    let used = true;
    act(() => {
      used = result.current.onFinal("hi");
    });
    expect(used).toBe(false);
    act(() => void vi.advanceTimersByTime(2000));
    expect(submit).not.toHaveBeenCalled();
  });
});
