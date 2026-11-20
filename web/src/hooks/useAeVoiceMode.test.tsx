import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeaker } from "@/lib/aeSpeakReplies";
import { activeEchoWords, notePlayback, recordSpoken, resetEcho } from "@/lib/aeVoiceEcho";
import { MIC_WHILE_SPEAKING_KEY } from "@/lib/aeVoiceMic";
import {
  GRACE_MS,
  SERVER_STT_GRACE_MS,
  registerVoiceSpeaker,
  registerVoiceStop,
  RESUME_MS,
  resetVoiceStore,
  setVoiceBarged,
  setVoiceOn,
  setVoicePlaying,
  setVoiceSpeaking,
  getVoiceSnapshot,
} from "@/lib/aeVoiceMode";
import { useChatStore } from "@/store/chatStore";
import { installFakeSpeech, removeFakeSpeech, type FakeSynth } from "@/test/fakeSpeech";
import { formatVoiceLog, resetVoiceLog } from "@/lib/aeVoiceLog";
import {
  MIC_DEAF_DETAIL,
  MIC_START_NET_MS,
  SEND_NOW_CAP_MS,
  useAeVoiceMode,
} from "./useAeVoiceMode";

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

// The session-limit card: a plain accept or decline, no question payload.
const APPROVAL = {
  type: "elicitation",
  ctx: { depth: 0 },
  elicitationId: "a1",
  status: "pending",
  targetSessionId: null,
  message: "Four sessions are running.",
  phase: "request",
  policyName: "ae_slot_cap",
  contentPreview: "",
  requestedSchema: {},
};

let synth: FakeSynth;
let listening = false;
// False leaves a start "connecting": isListening stays false until the test says otherwise.
let autoConnect = true;
let micPath: "browser" | "server" = "browser";
const controller = {
  current: {
    start: vi.fn(() => {
      if (autoConnect) listening = true;
    }),
    stop: vi.fn(() => {
      listening = false;
    }),
    restart: vi.fn(),
    isListening: () => listening,
    startPath: () => micPath,
    takePath: () => micPath,
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
  resetVoiceLog();
  micPath = "browser";
  resetEcho();
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

  it("sends the draft one grace (2 s) after a final", () => {
    const { result } = mount({ value: "hello there" });
    act(() => void result.current.onFinal("hello there"));
    act(() => void vi.advanceTimersByTime(GRACE_MS - 1));
    expect(submit).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(controller.current.stop).toHaveBeenCalled();
  });

  it("sends after 1 s on the server dictation path and 2 s on the browser path", () => {
    expect(SERVER_STT_GRACE_MS).toBe(1000);
    expect(GRACE_MS).toBe(2000);
    micPath = "server";
    const { result } = mount({ value: "hello there" });
    act(() => void result.current.onFinal("hello there"));
    act(() => void vi.advanceTimersByTime(SERVER_STT_GRACE_MS - 1));
    expect(submit).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("a browser take waits the full grace even when the server setting is on", () => {
    // startPath says server (the setting), takePath says the live take is the browser one.
    const take = controller.current.takePath;
    controller.current.takePath = () => "browser";
    micPath = "server";
    const { result } = mount({ value: "hello there" });
    act(() => void result.current.onFinal("hello there"));
    act(() => void vi.advanceTimersByTime(SERVER_STT_GRACE_MS + 100));
    expect(submit).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(GRACE_MS - SERVER_STT_GRACE_MS));
    expect(submit).toHaveBeenCalledTimes(1);
    controller.current.takePath = take;
  });

  it("a new partial inside the grace cancels the send", () => {
    const { result } = mount({ value: "hello" });
    act(() => void result.current.onFinal("hello"));
    act(() => void vi.advanceTimersByTime(400));
    act(() => void result.current.onPartial("and also"));
    act(() => void vi.advanceTimersByTime(2000));
    expect(submit).not.toHaveBeenCalled();
  });

  it("restarts the grace after the next final when a partial cancelled the send", () => {
    const { result } = mount({ value: "hello" });
    act(() => void result.current.onFinal("hello"));
    act(() => void vi.advanceTimersByTime(GRACE_MS - 100));
    act(() => void result.current.onPartial("and also"));
    act(() => void vi.advanceTimersByTime(GRACE_MS + 100));
    expect(submit).not.toHaveBeenCalled();
    act(() => void result.current.onFinal("and also"));
    act(() => void vi.advanceTimersByTime(GRACE_MS - 1));
    expect(submit).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  const REPLY = "The build passed and the review is next.";

  /** A reply is queued, then audio really plays. */
  function startPlayback(): void {
    recordSpoken(REPLY);
    setVoiceSpeaking("c1", true);
    setVoicePlaying("c1", true);
  }

  describe("mic while speaking: always", () => {
    beforeEach(() => {
      window.localStorage.setItem(MIC_WHILE_SPEAKING_KEY, "always");
    });

    it("keeps the mic muted while queued, and opens it once audio really plays", () => {
      const stop = vi.fn();
      const { result } = mount();
      act(() => void registerVoiceStop("c1", stop));
      act(() => setVoiceSpeaking("c1", true));
      expect(controller.current.stop).toHaveBeenCalled();
      expect(listening).toBe(false);
      let kept = "";
      act(() => {
        kept = result.current.filterHeard("wait stop now", "final");
      });
      expect(kept).toBe("wait stop now");
      expect(getVoiceSnapshot("c1").barged).toBe(false);
      expect(stop).not.toHaveBeenCalled();
      act(() => setVoicePlaying("c1", true));
      act(() => void vi.advanceTimersByTime(RESUME_MS));
      expect(listening).toBe(true);
    });

    it("keeps the mic off while thinking, before anything is spoken", () => {
      const { rerender } = mount({ value: "hi", status: "idle" });
      rerender({ chatId: "c1", value: "", status: "streaming", canSend: true, submit });
      expect(controller.current.stop).toHaveBeenCalled();
    });

    it("a pure echo is dropped and does not barge", () => {
      const { result } = mount();
      act(() => startPlayback());
      let kept = "x";
      act(() => {
        kept = result.current.filterHeard("the build passed and the review is next", "final");
      });
      expect(kept).toBe("");
      expect(getVoiceSnapshot("c1").barged).toBe(false);
    });

    it("two new words in a final barge in, stop the reply and keep only the new words", () => {
      const stop = vi.fn();
      const { result } = mount();
      act(() => {
        registerVoiceStop("c1", stop);
        startPlayback();
      });
      let kept = "";
      act(() => {
        kept = result.current.filterHeard("the build passed wait stop", "final");
      });
      expect(kept).toBe("wait stop");
      expect(getVoiceSnapshot("c1").barged).toBe(true);
      expect(stop).toHaveBeenCalled();
    });

    it("one interim with two new words then a pure echo interim never barges", () => {
      const stop = vi.fn();
      const { result } = mount();
      act(() => {
        registerVoiceStop("c1", stop);
        startPlayback();
      });
      let a = "x";
      let b = "x";
      act(() => {
        a = result.current.filterHeard("the build passed wait stop", "interim");
        b = result.current.filterHeard("the build passed and the review", "interim");
      });
      expect(a).toBe("");
      expect(b).toBe("");
      expect(getVoiceSnapshot("c1").barged).toBe(false);
      expect(stop).not.toHaveBeenCalled();
    });

    it("two interims in a row with new words barge in", () => {
      const stop = vi.fn();
      const { result } = mount();
      act(() => {
        registerVoiceStop("c1", stop);
        startPlayback();
      });
      let b = "";
      act(() => {
        result.current.filterHeard("wait stop", "interim");
        b = result.current.filterHeard("wait stop now", "interim");
      });
      expect(b).toBe("wait stop now");
      expect(getVoiceSnapshot("c1").barged).toBe(true);
      expect(stop).toHaveBeenCalled();
    });

    it("an utterance that began inside the window stays filtered when its final lands late", () => {
      const { result } = mount();
      act(() => startPlayback());
      act(() => void result.current.filterHeard("the build passed", "interim"));
      act(() => setVoiceSpeaking("c1", false));
      act(() => void vi.advanceTimersByTime(3000));
      let kept = "x";
      act(() => {
        kept = result.current.filterHeard("the build passed", "final");
      });
      expect(kept).toBe("");
      // The next utterance, with no interim in the window, is not filtered.
      act(() => {
        kept = result.current.filterHeard("the build passed", "final");
      });
      expect(kept).toBe("the build passed");
    });

    it("an interim with no final leaves no stale pin once the mic stops", () => {
      const { result } = mount();
      act(() => startPlayback());
      act(() => void result.current.filterHeard("the build passed", "interim"));
      act(() => setVoiceSpeaking("c1", false));
      act(() => void result.current.onListening(false));
      act(() => void vi.advanceTimersByTime(3000));
      let kept = "";
      act(() => {
        kept = result.current.filterHeard("the build passed", "final");
      });
      expect(kept).toBe("the build passed");
    });

    it("a one-word continuation (not in the reply) in the tail reaches the draft and cancels a pending grace", () => {
      const { result } = mount({ value: "hello" });
      act(() => void result.current.onFinal("hello"));
      act(() => {
        startPlayback();
        setVoiceSpeaking("c1", false);
      });
      act(() => void vi.advanceTimersByTime(500));
      let kept = "";
      act(() => {
        kept = result.current.filterHeard("tomorrow", "interim");
        result.current.onPartial(kept);
      });
      expect(kept).toBe("tomorrow");
      act(() => void vi.advanceTimersByTime(GRACE_MS + 100));
      expect(submit).not.toHaveBeenCalled();
    });

    it("bargeIn clears a pending grace", () => {
      const { result } = mount({ value: "hello" });
      act(() => startPlayback());
      act(() => void vi.advanceTimersByTime(RESUME_MS));
      act(() => void result.current.onFinal("hello"));
      act(() => void result.current.bargeIn());
      act(() => void vi.advanceTimersByTime(GRACE_MS + 100));
      expect(submit).not.toHaveBeenCalled();
    });
  });

  describe("mic while speaking: wait", () => {
    it("never barges: a final with new words while a reply plays is dropped", () => {
      const stop = vi.fn();
      const { result } = mount({ value: "hello" });
      act(() => {
        registerVoiceStop("c1", stop);
        startPlayback();
      });
      let kept = "";
      let used = false;
      act(() => {
        kept = result.current.filterHeard("wait stop now please", "final");
        used = result.current.onFinal(kept);
      });
      expect(used).toBe(true);
      expect(getVoiceSnapshot("c1").barged).toBe(false);
      expect(stop).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(GRACE_MS + 100));
      expect(submit).not.toHaveBeenCalled();
    });
  });

  it("a chat change closes the echo window", () => {
    const { rerender } = mount();
    act(() => startPlayback());
    expect(activeEchoWords()).not.toBeNull();
    rerender({ chatId: "c2", value: "", status: "idle", canSend: true, submit });
    expect(activeEchoWords()).toBeNull();
  });

  it("bargeIn stops speech and leaves Voice mode on, only while speaking", () => {
    const stop = vi.fn();
    const { result } = mount();
    act(() => void registerVoiceStop("c1", stop));
    let handled = true;
    act(() => {
      handled = result.current.bargeIn();
    });
    expect(handled).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    act(() => setVoiceSpeaking("c1", true));
    act(() => {
      handled = result.current.bargeIn();
    });
    expect(handled).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getVoiceSnapshot("c1").barged).toBe(true);
    expect(getVoiceSnapshot("c1").on).toBe(true);
  });

  it("filterHeard passes text through when the echo window is closed or Voice mode is off", () => {
    const { result } = mount();
    expect(result.current.filterHeard("just talking here", "final")).toBe("just talking here");
    act(() => {
      notePlayback(false);
      setVoiceOn("c1", false);
    });
    expect(result.current.filterHeard("anything at all", "final")).toBe("anything at all");
  });

  describe("sendNow", () => {
    it("stops the take, lets its last words land, then sends once and clears the grace", () => {
      const { result, rerender } = mount({ value: "hello" });
      act(() => result.current.onListening(true));
      act(() => void result.current.onFinal("hello"));
      let handled = false;
      act(() => {
        handled = result.current.sendNow();
      });
      expect(handled).toBe(true);
      expect(controller.current.stop).toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      // The stopped take's tail arrives as a final and goes into the draft.
      let used = true;
      act(() => {
        used = result.current.onFinal("there");
      });
      expect(used).toBe(false);
      rerender({
        chatId: "c1",
        value: "hello there",
        status: "idle",
        canSend: true,
        submit,
      });
      act(() => void vi.advanceTimersByTime(200));
      expect(submit).toHaveBeenCalledTimes(1);
      act(() => void vi.advanceTimersByTime(GRACE_MS * 3));
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("sends what is there after the cap when no final arrives", () => {
      const { result } = mount({ value: "hello" });
      act(() => result.current.onListening(true));
      act(() => void result.current.sendNow());
      act(() => void vi.advanceTimersByTime(SEND_NOW_CAP_MS - 1));
      expect(submit).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(1));
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("sends at once when the mic is not listening", () => {
      const { result } = mount({ value: "hello" });
      act(() => result.current.onListening(true));
      listening = false;
      act(() => void result.current.sendNow());
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("a second press while the first is sending sends nothing more", () => {
      const { result } = mount({ value: "hello" });
      act(() => result.current.onListening(true));
      let first = false;
      let second = false;
      act(() => {
        first = result.current.sendNow();
        second = result.current.sendNow();
      });
      expect(first).toBe(true);
      expect(second).toBe(true);
      act(() => void vi.advanceTimersByTime(SEND_NOW_CAP_MS));
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("two sends in one render send once", () => {
      const { result } = mount({ value: "hello" });
      act(() => result.current.onListening(true));
      listening = false;
      act(() => {
        result.current.sendNow();
        result.current.sendNow();
      });
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("a final that arrives after the send never starts a second message", () => {
      const { result } = mount({ value: "hello" });
      act(() => result.current.onListening(true));
      act(() => void result.current.sendNow());
      act(() => void vi.advanceTimersByTime(SEND_NOW_CAP_MS));
      expect(submit).toHaveBeenCalledTimes(1);
      act(() => void result.current.onFinal("late words"));
      act(() => void vi.advanceTimersByTime(GRACE_MS * 3));
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("does not say Mic stopped while the take is stopping", () => {
      const { result } = mount({ value: "hello" });
      act(() => result.current.onListening(true));
      act(() => void result.current.sendNow());
      act(() => result.current.onListening(false));
      expect(getVoiceSnapshot("c1").phase).toBe("listening");
    });

    it("a chat switch mid-settle sends nothing into the new chat", () => {
      const { result, rerender } = mount({ value: "hello" });
      act(() => result.current.onListening(true));
      act(() => void result.current.sendNow());
      setVoiceOn("c2", true);
      rerender({ chatId: "c2", value: "other draft", status: "idle", canSend: true, submit });
      act(() => void vi.advanceTimersByTime(SEND_NOW_CAP_MS * 2 + GRACE_MS));
      expect(submit).not.toHaveBeenCalled();
    });

    it("an unmount mid-settle sends nothing", () => {
      const { result, unmount } = mount({ value: "hello" });
      act(() => result.current.onListening(true));
      act(() => void result.current.sendNow());
      unmount();
      act(() => void vi.advanceTimersByTime(SEND_NOW_CAP_MS * 2));
      expect(submit).not.toHaveBeenCalled();
    });

    it("Enter works again right after a chat switch", () => {
      const { result, rerender } = mount({ value: "hello" });
      act(() => result.current.onListening(true));
      act(() => void result.current.sendNow());
      setVoiceOn("c2", true);
      rerender({ chatId: "c2", value: "next", status: "idle", canSend: true, submit });
      act(() => result.current.onListening(true));
      let handled = false;
      act(() => {
        handled = result.current.sendNow();
      });
      expect(handled).toBe(true);
      act(() => void vi.advanceTimersByTime(SEND_NOW_CAP_MS));
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it("returns false and leaves the take alone with no draft", () => {
      const { result } = mount({ value: "  " });
      act(() => result.current.onListening(true));
      let handled = true;
      act(() => {
        handled = result.current.sendNow();
      });
      expect(handled).toBe(false);
      expect(controller.current.stop).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    });

    it("returns false when the composer refuses (a card is pending), grace untouched", () => {
      const { result } = mount({ value: "hello", canSend: false });
      act(() => result.current.onListening(true));
      let handled = true;
      act(() => {
        handled = result.current.sendNow();
      });
      expect(handled).toBe(false);
      expect(controller.current.stop).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    });

    it("returns false while the reply plays", () => {
      const { result } = mount({ value: "hello" });
      act(() => setVoiceSpeaking("c1", true));
      let handled = true;
      act(() => {
        handled = result.current.sendNow();
      });
      expect(handled).toBe(false);
      expect(submit).not.toHaveBeenCalled();
    });
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
    expect(submitApproval).toHaveBeenCalledWith(
      "e1",
      "accept",
      {
        "How should it deploy?": "Let the timer do it",
      },
      { source: "voice" },
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("sends an unmatched answer as the card's own words after the grace", () => {
    useChatStore.setState({ blocks: [CARD] } as never);
    const { result } = mount();
    act(() => void result.current.onFinal("ask me tomorrow"));
    expect(submitApproval).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(GRACE_MS));
    expect(submitApproval).toHaveBeenCalledWith(
      "e1",
      "accept",
      {
        "How should it deploy?": "ask me tomorrow",
      },
      { source: "voice" },
    );
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
    expect(submitApproval).toHaveBeenCalledWith(
      "e1",
      "accept",
      {
        "How should it deploy?": ["Force it", "Hold it"],
      },
      { source: "voice" },
    );
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
    expect(submitApproval).toHaveBeenCalledWith(
      "e1",
      "accept",
      {
        "How should it deploy?": "Hold it",
      },
      { source: "voice" },
    );
  });

  it("a custom card answer waits 1 s on the server path and 2 s on the browser path", () => {
    useChatStore.setState({ blocks: [CARD] } as never);
    micPath = "server";
    const { result } = mount();
    act(() => void result.current.onFinal("ask me tomorrow"));
    act(() => void vi.advanceTimersByTime(SERVER_STT_GRACE_MS - 1));
    expect(submitApproval).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(submitApproval).toHaveBeenCalledTimes(1);
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
      expect(submitApproval).toHaveBeenCalledWith(
        "e1",
        "accept",
        {
          "How should it deploy?": ["Force it", "Hold it"],
        },
        { source: "voice" },
      );
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
    expect(submitApproval).toHaveBeenCalledWith(
      "e1",
      "accept",
      {
        "How should it deploy?": "Force it",
        "Which branch?": "Dev",
      },
      { source: "voice" },
    );
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

  it("treats a start that stays silent past the net as failed, retries once, then gives up", () => {
    autoConnect = false;
    mount();
    expect(controller.current.start).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(MIC_START_NET_MS));
    expect(getVoiceSnapshot("c1").phase).not.toBe("listening");
    act(() => void vi.advanceTimersByTime(1000));
    expect(controller.current.start).toHaveBeenCalledTimes(2);
    act(() => void vi.advanceTimersByTime(MIC_START_NET_MS));
    expect(getVoiceSnapshot("c1").phase).toBe("unavailable");
  });

  it("a slow but healthy first start is not a failure and keeps saying Starting the mic", () => {
    autoConnect = false;
    const { result } = mount();
    act(() => void vi.advanceTimersByTime(40_000));
    expect(getVoiceSnapshot("c1").phase).toBe("starting");
    expect(controller.current.start).toHaveBeenCalledTimes(1);
    expect(controller.current.stop).not.toHaveBeenCalled();
    act(() => void result.current.onListening(true));
    expect(getVoiceSnapshot("c1").phase).toBe("listening");
    act(() => void vi.advanceTimersByTime(MIC_START_NET_MS));
    expect(getVoiceSnapshot("c1").phase).toBe("listening");
  });

  it("keeps both picks of a multi-pick sentence that ends in a done phrase", () => {
    const three = {
      ...CARD,
      askUserQuestion: {
        questions: [{ ...CARD.askUserQuestion.questions[0], multiSelect: true }],
      },
    };
    useChatStore.setState({ blocks: [three] } as never);
    const { result } = mount();
    act(() => void result.current.onFinal("one and three, I'm done"));
    expect(submitApproval).toHaveBeenCalledWith(
      "e1",
      "accept",
      {
        "How should it deploy?": ["Force it", "Hold it"],
      },
      { source: "voice" },
    );
  });

  it("makes the start again when the mic is wanted before its own stop has finished", () => {
    const { result, rerender } = mount();
    act(() => void result.current.onListening(true));
    // The stop takes a moment: the mic stays "listening" until it reports back.
    controller.current.stop.mockImplementation(() => {});
    rerender({ chatId: "c1", value: "", status: "streaming", canSend: true, submit });
    rerender({ chatId: "c1", value: "", status: "idle", canSend: true, submit });
    act(() => void vi.advanceTimersByTime(RESUME_MS));
    expect(controller.current.start).toHaveBeenCalledTimes(1);
    controller.current.start.mockClear();
    act(() => {
      listening = false;
      result.current.onListening(false);
    });
    expect(controller.current.start).toHaveBeenCalledTimes(1);
    expect(getVoiceSnapshot("c1").phase).not.toBe("paused");
  });

  it("picks an option whose label ends in a filler word on a multi-select card", () => {
    const labelled = {
      ...CARD,
      askUserQuestion: {
        questions: [
          {
            question: "What now?",
            multiSelect: true,
            options: [{ label: "Merge it" }, { label: "Hold" }],
          },
        ],
      },
    };
    useChatStore.setState({ blocks: [labelled] } as never);
    const { result } = mount();
    act(() => void result.current.onFinal("merge it done"));
    expect(submitApproval).toHaveBeenCalledWith(
      "e1",
      "accept",
      {
        "What now?": ["Merge it"],
      },
      { source: "voice" },
    );
  });

  describe("an approval card without a question", () => {
    function mountApproval(over: Partial<MountProps> = {}) {
      const speak = vi.fn();
      registerVoiceSpeaker("c1", speak);
      useChatStore.setState({ blocks: [APPROVAL], sessionStatus: "running" } as never);
      const hook = mount({ status: "streaming", ...over });
      // Past the window in which the approval line may still be playing, plus its echo tail.
      act(() => void vi.advanceTimersByTime(8100));
      return { speak, ...hook };
    }

    it("shows the approval phase, speaks one line and keeps the mic open", () => {
      const { speak, result } = mountApproval();
      expect(getVoiceSnapshot("c1").phase).toBe("approval");
      expect(result.current.approvalActive).toBe(true);
      expect(result.current.cardActive).toBe(false);
      expect(speak).toHaveBeenCalledTimes(1);
      expect(speak).toHaveBeenCalledWith("Slots full. Say run it, or decline.");
      expect(controller.current.start).toHaveBeenCalled();
      expect(controller.current.stop).not.toHaveBeenCalled();
      expect(formatVoiceLog()).toContain("approval pending");
    });

    it.each(["run it", "yes", "ok"])("accepts when %s is said", (said) => {
      const { result } = mountApproval();
      let used = false;
      act(() => {
        used = result.current.onFinal(said);
      });
      expect(used).toBe(true);
      expect(submitApproval).toHaveBeenCalledWith("a1", "accept", undefined, { source: "voice" });
      expect(submit).not.toHaveBeenCalled();
    });

    it("accepts a punctuated server-recognizer final and sends no message after it", () => {
      const { result } = mountApproval();
      act(() => void result.current.onFinal("Run it."));
      expect(submitApproval).toHaveBeenCalledTimes(1);
      expect(submitApproval).toHaveBeenCalledWith("a1", "accept", undefined, { source: "voice" });
      act(() => void vi.advanceTimersByTime(5000));
      expect(submit).not.toHaveBeenCalled();
    });

    it.each(["decline", "no", "cancel"])("declines when %s is said", (said) => {
      const { result } = mountApproval();
      act(() => void result.current.onFinal(said));
      expect(submitApproval).toHaveBeenCalledWith("a1", "decline", undefined, { source: "voice" });
    });

    it("ignores talk that is not an answer and never sends it as a message", () => {
      const { result } = mountApproval({ value: "tell me about the weather today" });
      let used = false;
      act(() => {
        used = result.current.onFinal("tell me about the weather today");
      });
      act(() => void vi.advanceTimersByTime(GRACE_MS + 10));
      expect(used).toBe(true);
      expect(submitApproval).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    });

    it.each([
      "don't say yes",
      "do not approve",
      "never run it",
      "run it or decline",
      "please run it for me",
      "yesterday",
    ])("ignores %s", (said) => {
      const { result } = mountApproval();
      act(() => void result.current.onFinal(said));
      expect(submitApproval).not.toHaveBeenCalled();
    });

    it("never answers a tool-permission card by voice", () => {
      useChatStore.setState({
        blocks: [{ ...APPROVAL, policyName: "bash_permission", elicitationId: "bash1" }],
        sessionStatus: "running",
      } as never);
      const speak = vi.fn();
      registerVoiceSpeaker("c1", speak);
      const { result } = mount({ status: "streaming" });
      act(() => void vi.advanceTimersByTime(9000));
      expect(result.current.approvalActive).toBe(false);
      expect(speak).not.toHaveBeenCalled();
      act(() => void result.current.onFinal("yes"));
      act(() => void result.current.onFinal("run it"));
      expect(submitApproval).not.toHaveBeenCalled();
    });

    it("answers the newest pending card when several wait", () => {
      useChatStore.setState({
        blocks: [APPROVAL, { ...APPROVAL, elicitationId: "a2" }],
        sessionStatus: "running",
      } as never);
      const { result } = mount({ status: "streaming" });
      act(() => void vi.advanceTimersByTime(8100));
      act(() => void result.current.onFinal("run it"));
      expect(submitApproval).toHaveBeenCalledTimes(1);
      expect(submitApproval).toHaveBeenCalledWith("a2", "accept", undefined, { source: "voice" });
    });

    it("submits once when the same answer arrives twice", () => {
      const { result } = mountApproval();
      act(() => void result.current.onFinal("run it"));
      act(() => void result.current.onFinal("yes"));
      expect(submitApproval).toHaveBeenCalledTimes(1);
    });

    it("ignores a final while the approval line plays and for 2.5 s after it ends", () => {
      const { result } = mountApproval();
      act(() => {
        setVoiceSpeaking("c1", true);
        setVoicePlaying("c1", true);
      });
      act(() => void result.current.onFinal("run it"));
      expect(submitApproval).not.toHaveBeenCalled();
      act(() => {
        setVoicePlaying("c1", false);
        setVoiceSpeaking("c1", false);
      });
      act(() => void vi.advanceTimersByTime(2400));
      act(() => void result.current.onFinal("run it"));
      expect(submitApproval).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(200));
      act(() => void result.current.onFinal("run it"));
      expect(submitApproval).toHaveBeenCalledTimes(1);
    });

    it("ignores a final whose recognition began inside the echo tail", () => {
      const { result } = mountApproval();
      act(() => {
        setVoiceSpeaking("c1", true);
        setVoicePlaying("c1", true);
      });
      act(() => {
        setVoicePlaying("c1", false);
        setVoiceSpeaking("c1", false);
      });
      act(() => void vi.advanceTimersByTime(1000));
      act(() => void result.current.onPartial("run"));
      act(() => void vi.advanceTimersByTime(2000));
      act(() => void result.current.onFinal("run it"));
      expect(submitApproval).not.toHaveBeenCalled();
    });

    it("shows the unavailable phase with a restart when the mic went quiet during an approval", () => {
      const { result } = mountApproval();
      act(() => void result.current.onListening(true));
      for (let i = 0; i < 2; i += 1) {
        act(() => {
          listening = false;
          result.current.onListening(false, "deaf");
        });
        act(() => void vi.advanceTimersByTime(1000));
        if (i === 0) act(() => void result.current.onListening(true));
      }
      expect(result.current.approvalActive).toBe(true);
      expect(getVoiceSnapshot("c1").phase).toBe("unavailable");
      expect(result.current.micDetail).toBe(MIC_DEAF_DETAIL);
    });

    it("answerApproval resolves the pending card once, with the panel as its source, while the line speaks", () => {
      const { result } = mountApproval();
      act(() => setVoiceSpeaking("c1", true));
      act(() => result.current.answerApproval("accept"));
      expect(submitApproval).toHaveBeenCalledTimes(1);
      expect(submitApproval).toHaveBeenCalledWith("a1", "accept", undefined, {
        source: "voice_panel",
      });
      act(() => result.current.answerApproval("decline"));
      act(() => void result.current.onFinal("run it"));
      expect(submitApproval).toHaveBeenCalledTimes(1);
    });

    it("a failed POST frees the card: the panel can answer again", async () => {
      const { result } = mountApproval();
      // The store rolls a failed POST back to a pending card and resolves; the mock leaves it pending.
      act(() => result.current.answerApproval("accept"));
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(formatVoiceLog()).toContain("approval answer failed");
      act(() => result.current.answerApproval("accept"));
      expect(submitApproval).toHaveBeenCalledTimes(2);
    });

    it("a failed POST frees the card: a spoken answer retries", async () => {
      const { result } = mountApproval();
      act(() => void result.current.onFinal("run it"));
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      act(() => void result.current.onFinal("run it"));
      expect(submitApproval).toHaveBeenCalledTimes(2);
    });

    it("a rejected POST frees the card too", async () => {
      const { result } = mountApproval();
      submitApproval.mockImplementationOnce(() => Promise.reject(new Error("offline")));
      act(() => result.current.answerApproval("decline"));
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(formatVoiceLog()).toContain("approval answer failed");
      act(() => result.current.answerApproval("decline"));
      expect(submitApproval).toHaveBeenCalledTimes(2);
    });

    it("a POST that went through keeps the card answered", async () => {
      const { result } = mountApproval();
      submitApproval.mockImplementationOnce(() => {
        useChatStore.setState({ blocks: [{ ...APPROVAL, status: "responded" }] } as never);
        return Promise.resolve();
      });
      act(() => result.current.answerApproval("accept"));
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(formatVoiceLog()).not.toContain("approval answer failed");
      act(() => void result.current.onFinal("run it"));
      expect(submitApproval).toHaveBeenCalledTimes(1);
    });

    it("answerApproval declines with the panel as its source and does nothing with no card", () => {
      const { result } = mountApproval();
      act(() => result.current.answerApproval("decline"));
      expect(submitApproval).toHaveBeenCalledWith("a1", "decline", undefined, {
        source: "voice_panel",
      });
      act(() => useChatStore.setState({ blocks: [] } as never));
      submitApproval.mockClear();
      act(() => result.current.answerApproval("accept"));
      expect(submitApproval).not.toHaveBeenCalled();
    });

    it("leaves the approval phase when the card is answered", () => {
      mountApproval();
      act(() => {
        useChatStore.setState({
          blocks: [{ ...APPROVAL, status: "responded" }],
          sessionStatus: "idle",
        } as never);
      });
      expect(getVoiceSnapshot("c1").phase).not.toBe("approval");
    });

    it("is not offered for a form, a link or a plan card", () => {
      const forms = [
        { ...APPROVAL, requestedSchema: { properties: { reason: { type: "string" } } } },
        { ...APPROVAL, url: "https://example.com/oauth" },
        { ...APPROVAL, exitPlanMode: { plan: "Do it" } },
      ];
      for (const form of forms) {
        useChatStore.setState({ blocks: [form] } as never);
        const { result, unmount } = mount({ status: "streaming" });
        expect(result.current.approvalActive).toBe(false);
        unmount();
      }
    });
  });

  it("logs why a send was refused instead of returning silently", () => {
    const { result } = mount({ value: "hello", canSend: false });
    act(() => void result.current.onFinal("hello"));
    act(() => void vi.advanceTimersByTime(GRACE_MS + 10));
    expect(submit).not.toHaveBeenCalled();
    expect(formatVoiceLog()).toContain("send refused composer");
  });

  it("retries once when a take comes back deaf, then shows a mic to restart by tap", () => {
    const { result } = mount();
    act(() => void result.current.onListening(true));
    act(() => {
      // The real mic has already dropped the take when it reports it.
      listening = false;
      result.current.onListening(false, "deaf");
    });
    expect(getVoiceSnapshot("c1").phase).not.toBe("unavailable");
    controller.current.start.mockClear();
    act(() => void vi.advanceTimersByTime(1000));
    expect(controller.current.start).toHaveBeenCalledTimes(1);
    act(() => void result.current.onListening(true));
    act(() => {
      // The real mic has already dropped the take when it reports it.
      listening = false;
      result.current.onListening(false, "deaf");
    });
    expect(getVoiceSnapshot("c1").phase).toBe("unavailable");
    expect(result.current.micDetail).toBe(MIC_DEAF_DETAIL);
    act(() => void result.current.onListening(true));
    expect(getVoiceSnapshot("c1").phase).toBe("listening");
    expect(result.current.micDetail).toBeNull();
  });

  it("a tap-restart after Mic went quiet gives a fresh retry", () => {
    const { result } = mount();
    const goDeaf = () =>
      act(() => {
        listening = false;
        result.current.onListening(false, "deaf");
      });
    act(() => void result.current.onListening(true));
    goDeaf();
    act(() => void vi.advanceTimersByTime(1000));
    act(() => void result.current.onListening(true));
    goDeaf();
    expect(getVoiceSnapshot("c1").phase).toBe("unavailable");
    act(() => result.current.restartMic());
    expect(controller.current.restart).toHaveBeenCalledTimes(1);
    expect(result.current.micDetail).toBeNull();
    act(() => void result.current.onListening(true));
    goDeaf();
    // The count started over: this deaf take is retried, not shown as failed.
    expect(getVoiceSnapshot("c1").phase).not.toBe("unavailable");
    controller.current.start.mockClear();
    act(() => void vi.advanceTimersByTime(1000));
    expect(controller.current.start).toHaveBeenCalledTimes(1);
  });

  it("heard words give a deaf mic its retry back", () => {
    const { result } = mount({ value: "" });
    act(() => void result.current.onListening(true));
    act(() => {
      // The real mic has already dropped the take when it reports it.
      listening = false;
      result.current.onListening(false, "deaf");
    });
    act(() => void vi.advanceTimersByTime(1000));
    act(() => void result.current.onListening(true));
    act(() => void result.current.onFinal("hello"));
    act(() => {
      // The real mic has already dropped the take when it reports it.
      listening = false;
      result.current.onListening(false, "deaf");
    });
    expect(getVoiceSnapshot("c1").phase).not.toBe("unavailable");
  });
});

describe("voice log upload", () => {
  /** The reasons posted to the voice log route so far, in order. */
  function reasons(): string[] {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).includes("/v1/ae/voice-log"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)).reason);
  }

  it("sends the log with the chat id when the mic fails to start twice", () => {
    autoConnect = false;
    const { result } = mount();
    act(() => void result.current.onListening(false));
    act(() => void vi.advanceTimersByTime(1000));
    expect(reasons()).toEqual([]);
    act(() => void result.current.onListening(false));
    expect(reasons()).toEqual(["mic_failed"]);
    const [, init] = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).includes("/v1/ae/voice-log")) as [
      unknown,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body)).chat_id).toBe("c1");
  });

  it("sends the log when the mic goes deaf twice", () => {
    const { result } = mount();
    act(() => void result.current.onListening(true));
    for (let i = 0; i < 2; i += 1) {
      act(() => {
        listening = false;
        result.current.onListening(false, "deaf");
      });
      act(() => void vi.advanceTimersByTime(1000));
      act(() => void result.current.onListening(true));
    }
    expect(reasons()).toEqual(["mic_deaf"]);
  });

  it("sends the log when a start never answers", () => {
    autoConnect = false;
    mount();
    act(() => void vi.advanceTimersByTime(MIC_START_NET_MS));
    expect(reasons()).toContain("mic_stalled");
  });

  it("does not upload when the mic is stopped from outside (the user's own stop looks the same)", () => {
    const { result } = mount();
    act(() => void result.current.onListening(true));
    act(() => {
      listening = false;
      result.current.onListening(false);
    });
    expect(reasons()).toEqual([]);
  });

  it("sends the log when Voice mode ends, and not before", () => {
    mount();
    expect(reasons()).toEqual([]);
    act(() => setVoiceOn("c1", false));
    expect(reasons()).toEqual(["voice_end"]);
  });

  it("a chat switch is not Voice ending: no voice_end upload", () => {
    setVoiceOn("c2", false);
    const { rerender } = mount();
    rerender({ chatId: "c2", value: "", status: "idle", canSend: true, submit });
    expect(reasons()).toEqual([]);
  });

  it("a switch to a Voice-off chat still stops the mic, with no upload", () => {
    setVoiceOn("c2", false);
    const { rerender } = mount();
    controller.current.stop.mockClear();
    rerender({ chatId: "c2", value: "", status: "idle", canSend: true, submit });
    expect(controller.current.stop).toHaveBeenCalled();
    expect(reasons()).toEqual([]);
  });

  it("attributes the Voice end upload to the chat it came on in", () => {
    const { rerender } = mount();
    // Same on state but the visible chat id moves to c2 while c1's voice ends.
    rerender({ chatId: "c2", value: "", status: "idle", canSend: true, submit });
    setVoiceOn("c2", true);
    rerender({ chatId: "c2", value: "", status: "idle", canSend: true, submit });
    act(() => setVoiceOn("c2", false));
    const [, init] = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).includes("/v1/ae/voice-log")) as [
      unknown,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toMatchObject({ reason: "voice_end", chat_id: "c2" });
  });

  it("sends nothing when Voice mode was never on", () => {
    setVoiceOn("c1", false);
    mount();
    expect(reasons()).toEqual([]);
  });
});
