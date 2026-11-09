import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeaker } from "@/lib/aeSpeakReplies";
import {
  GRACE_MS,
  registerVoiceSpeaker,
  RESUME_MS,
  resetVoiceStore,
  setVoiceBarged,
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
// False leaves a start "connecting": isListening stays false until the test says otherwise.
let autoConnect = true;
const controller = {
  current: {
    start: vi.fn(() => {
      if (autoConnect) listening = true;
    }),
    stop: vi.fn(() => {
      listening = false;
    }),
    isListening: () => listening,
  },
};
const submit = vi.fn();
const submitApproval = vi.fn(() => Promise.resolve());

interface MountProps {
  chatId: string;
  value: string;
  status: string;
  canSend: boolean;
  labels?: Record<string, string> | null;
  submit: () => void;
}

function mount(initial: Partial<MountProps> = {}) {
  return renderHook((props: MountProps) => useAeVoiceMode({ controller, ...props }), {
    initialProps: {
      chatId: "c1",
      value: "",
      status: "idle",
      canSend: true,
      submit,
      ...initial,
    } as MountProps,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  resetVoiceStore();
  listening = false;
  autoConnect = true;
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
    rerender({ chatId: "c1", value: "", status: "streaming", canSend: true, submit });
    expect(controller.current.stop).toHaveBeenCalled();
    controller.current.start.mockClear();
    rerender({ chatId: "c1", value: "", status: "idle", canSend: true, submit });
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

  it("a chat switch inside the grace window sends nothing for either chat", () => {
    setVoiceOn("c2", true);
    const submitB = vi.fn();
    const { result, rerender } = mount({ value: "hello from A" });
    act(() => void result.current.onFinal("hello from A"));
    act(() => void vi.advanceTimersByTime(300));
    rerender({ chatId: "c2", value: "draft in B", status: "idle", canSend: true, submit: submitB });
    act(() => void vi.advanceTimersByTime(2000));
    expect(submit).not.toHaveBeenCalled();
    expect(submitB).not.toHaveBeenCalled();
  });

  it("withdraws a start that is still connecting when the mic is no longer wanted", () => {
    autoConnect = false;
    const { result } = mount();
    expect(controller.current.start).toHaveBeenCalledTimes(1);
    expect(listening).toBe(false);
    controller.current.stop.mockClear();
    act(() => setVoiceSpeaking("c1", true));
    expect(controller.current.stop).toHaveBeenCalled();
    act(() => void result.current.onListening(false));
    expect(getVoiceSnapshot("c1").phase).toBe("speaking");
  });

  it("retries a failed start once, then says the mic is unavailable, never Listening", () => {
    autoConnect = false;
    const { result } = mount();
    expect(getVoiceSnapshot("c1").phase).toBe("starting");
    act(() => void result.current.onListening(false));
    expect(getVoiceSnapshot("c1").phase).not.toBe("listening");
    act(() => void vi.advanceTimersByTime(999));
    expect(controller.current.start).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(1));
    expect(controller.current.start).toHaveBeenCalledTimes(2);
    act(() => void result.current.onListening(false));
    expect(getVoiceSnapshot("c1").phase).toBe("unavailable");
    expect(getVoiceSnapshot("c1").on).toBe(true);
    act(() => void result.current.onListening(true));
    expect(getVoiceSnapshot("c1").phase).toBe("listening");
  });

  it("shows Listening only once the mic reports it, and Mic stopped after a hand stop", () => {
    const { result } = mount();
    expect(getVoiceSnapshot("c1").phase).toBe("starting");
    act(() => void result.current.onListening(true));
    expect(getVoiceSnapshot("c1").phase).toBe("listening");
    act(() => {
      listening = false;
      result.current.onListening(false);
    });
    expect(getVoiceSnapshot("c1").phase).toBe("paused");
  });

  it("keeps finals and partials out of the draft while speaking, and sends nothing", () => {
    const { result } = mount({ value: "hello" });
    act(() => setVoiceSpeaking("c1", true));
    let final = false;
    let partial = false;
    act(() => {
      final = result.current.onFinal("and the spoken reply words");
      partial = result.current.onPartial("and the");
    });
    expect(final).toBe(true);
    expect(partial).toBe(true);
    act(() => void vi.advanceTimersByTime(3000));
    expect(submit).not.toHaveBeenCalled();
  });

  it("a final in the resume window is still kept out of the draft", () => {
    const { result, rerender } = mount({ status: "streaming" });
    rerender({ chatId: "c1", value: "", status: "idle", canSend: true, submit });
    act(() => void vi.advanceTimersByTime(RESUME_MS - 50));
    let used = false;
    act(() => {
      used = result.current.onFinal("late words");
    });
    expect(used).toBe(true);
  });

  it("stays muted through a slow start of the turn, then resumes after it ends", () => {
    const { result, rerender } = mount({ value: "hello" });
    act(() => void result.current.onFinal("hello"));
    act(() => void vi.advanceTimersByTime(GRACE_MS));
    expect(submit).toHaveBeenCalledTimes(1);
    // The message is queued; streaming begins only at 8 s.
    act(() => useChatStore.setState({ pendingUserMessages: [{ tempId: "t1" }] } as never));
    controller.current.start.mockClear();
    act(() => void vi.advanceTimersByTime(5300));
    expect(controller.current.start).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(2700));
    rerender({ chatId: "c1", value: "", status: "streaming", canSend: true, submit });
    act(() => useChatStore.setState({ pendingUserMessages: [] } as never));
    act(() => void vi.advanceTimersByTime(20_000));
    expect(controller.current.start).not.toHaveBeenCalled();
    rerender({ chatId: "c1", value: "", status: "idle", canSend: true, submit });
    act(() => void vi.advanceTimersByTime(RESUME_MS));
    expect(controller.current.start).toHaveBeenCalledTimes(1);
  });

  it("a send the composer would refuse does not mute the mic", () => {
    const { result } = mount({ value: "hello", canSend: false });
    controller.current.stop.mockClear();
    act(() => void result.current.onFinal("hello"));
    act(() => void vi.advanceTimersByTime(GRACE_MS + 10));
    expect(submit).not.toHaveBeenCalled();
    expect(controller.current.stop).not.toHaveBeenCalled();
    expect(getVoiceSnapshot("c1").phase).not.toBe("thinking");
  });

  it("lets go by itself if the send never showed a turn", () => {
    const { result } = mount({ value: "/clear" });
    act(() => void result.current.onFinal("clear"));
    act(() => void vi.advanceTimersByTime(GRACE_MS));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(getVoiceSnapshot("c1").phase).toBe("thinking");
    controller.current.start.mockClear();
    act(() => void vi.advanceTimersByTime(5000));
    act(() => void vi.advanceTimersByTime(RESUME_MS));
    expect(controller.current.start).toHaveBeenCalledTimes(1);
  });

  it("after a tap on the speaker the mic returns while the reply still streams", () => {
    mount({ status: "streaming" });
    expect(controller.current.stop).toHaveBeenCalled();
    controller.current.start.mockClear();
    act(() => setVoiceBarged("c1", true));
    act(() => void vi.advanceTimersByTime(RESUME_MS));
    expect(controller.current.start).toHaveBeenCalledTimes(1);
  });

  it("never sends a custom answer on a card that says isOther is false", () => {
    const closed = {
      ...CARD,
      askUserQuestion: {
        questions: [{ ...CARD.askUserQuestion.questions[0], isOther: false }],
      },
    };
    useChatStore.setState({ blocks: [closed] } as never);
    const { result } = mount();
    act(() => void result.current.onFinal("ask me tomorrow"));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(submitApproval).not.toHaveBeenCalled();
    act(() => void result.current.onFinal("hold it"));
    expect(submitApproval).toHaveBeenCalledWith("e1", "accept", {
      "How should it deploy?": "Hold it",
    });
  });

  it("a card answered by a click leaves the pending custom answer inert", () => {
    useChatStore.setState({ blocks: [CARD] } as never);
    const { result } = mount();
    act(() => void result.current.onFinal("ask me tomorrow"));
    act(() => useChatStore.setState({ blocks: [] } as never));
    act(() => void vi.advanceTimersByTime(5000));
    expect(submitApproval).not.toHaveBeenCalled();
  });

  it.each(["ok done", "all done", "I'm done"])(
    "submits exactly the picks when a multi-select card ends with %s",
    (ending) => {
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
      act(() => void result.current.onFinal(ending));
      expect(submitApproval).toHaveBeenCalledWith("e1", "accept", {
        "How should it deploy?": ["Force it", "Hold it"],
      });
    },
  );

  it("reads and answers a two-question card in sequence", () => {
    const speaker = createSpeaker();
    registerVoiceSpeaker("c1", (t) => speaker.speak(t, { voiceURI: null, rate: 1 }));
    const second = {
      question: "Which branch?",
      multiSelect: false,
      options: [{ label: "Main" }, { label: "Dev" }],
    };
    const two = {
      ...CARD,
      askUserQuestion: { questions: [CARD.askUserQuestion.questions[0], second] },
    };
    useChatStore.setState({ blocks: [two] } as never);
    const { result } = mount();
    act(() => void vi.advanceTimersByTime(50));
    act(() => void result.current.onFinal("one"));
    expect(submitApproval).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(50));
    expect(synth.texts().at(-1)).toBe("Question. Which branch? One, Main. Two, Dev.");
    act(() => void result.current.onFinal("dev"));
    expect(submitApproval).toHaveBeenCalledWith("e1", "accept", {
      "How should it deploy?": "Force it",
      "Which branch?": "Dev",
    });
  });

  it("posts the switch when the session's label disagrees with it", () => {
    setVoiceOn("c1", false);
    vi.mocked(fetch).mockClear();
    mount({ labels: { "ae.voice": "on" } });
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String((calls[0][1] as RequestInit).body))).toEqual({ on: false });
  });

  it("leaves the label alone when it agrees", () => {
    vi.mocked(fetch).mockClear();
    mount({ labels: { "ae.voice": "on" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
