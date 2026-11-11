import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeEchoWords, resetEcho } from "@/lib/aeVoiceEcho";
import {
  emitCaption,
  emitPlaying,
  WORKING_CUE_DELAY_MS,
  WORKING_CUE_TEXT,
} from "@/lib/aeSpeakReplies";
import { getVoiceSnapshot, resetVoiceStore, setVoiceBarged } from "@/lib/aeVoiceMode";
import { clearPlaybackBlocked, markPlaybackBlocked } from "@/lib/aeVoicePlayback";
import { type AnyBlock, LIVE_ITEM_PREFIX } from "@/lib/blocks";
import { useChatStore } from "@/store/chatStore";
import { type FakeSynth, installFakeSpeech, removeFakeSpeech } from "@/test/fakeSpeech";
import { useAeSpeakReplies } from "./useAeSpeakReplies";

let synth: FakeSynth;

function ctx(responseId: string, itemId: string | null, extra: Record<string, unknown> = {}) {
  return { agent: null, depth: 0, turn: 1, timestamp: 1, responseId, itemId, ...extra };
}
function live(responseId: string, fullText: string): AnyBlock {
  return {
    type: "text_done",
    ctx: ctx(responseId, `${LIVE_ITEM_PREFIX}${responseId}`),
    fullText,
    hasCodeBlocks: false,
  } as AnyBlock;
}
function final(responseId: string, itemId: string, fullText: string, extra = {}): AnyBlock {
  return {
    type: "text_done",
    ctx: ctx(responseId, itemId, extra),
    fullText,
    hasCodeBlocks: false,
  } as AnyBlock;
}
function chunk(responseId: string, text: string, depth = 0): AnyBlock {
  return { type: "text_chunk", ctx: { ...ctx(responseId, null), depth }, text } as AnyBlock;
}
function send(n = 1) {
  return { pendingUserMessages: Array.from({ length: n }, (_, i) => ({ tempId: `p${i}` })) };
}
function setStore(patch: Record<string, unknown>) {
  act(() => {
    useChatStore.setState(patch as never);
  });
}
function flush() {
  act(() => {
    vi.advanceTimersByTime(1);
  });
}

function mount(
  enabled = true,
  chatId: string | null = "c1",
  voice: { kind: "cloud" | "device"; id: string } | null = null,
) {
  return renderHook(
    (p: { enabled: boolean; chatId: string | null }) => useAeSpeakReplies({ ...p, voice, rate: 1 }),
    { initialProps: { enabled, chatId } },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  synth = installFakeSpeech();
  useChatStore.setState({
    conversationId: "c1",
    blocks: [],
    status: "idle",
    pendingUserMessages: [],
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
  removeFakeSpeech();
  useChatStore.setState({ conversationId: null, blocks: [], status: "idle" } as never);
});

type Choice = { kind: "cloud" | "device"; id: string } | null;
const CLOUD_CHOICE: Choice = { kind: "cloud", id: "en-US-AvaMultilingualNeural" };

// A request that stays open until stop() aborts it, as the real fetch does.
const hangingFetch = () =>
  vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
      }),
  );

describe("useAeSpeakReplies engine choice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a device choice to the device speaker, not the server", () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    mount(true, "c1", { kind: "device", id: "v1" });
    setStore({ blocks: [final("r1", "item-1", "Whole reply.")] });
    flush();
    expect(synth.texts()).toEqual(["Whole reply."]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["the cloud list arriving", null, CLOUD_CHOICE],
    ["a menu pick", { kind: "device", id: "v1" } as Choice, CLOUD_CHOICE],
  ])("keeps the first engine for a response when %s changes the voice", (_n, first, next) => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const hook = renderHook(
      (p: { voice: Choice }) => useAeSpeakReplies({ chatId: "c1", enabled: true, rate: 1, ...p }),
      { initialProps: { voice: first } },
    );
    setStore({ blocks: [live("r1", "One. Two")] });
    flush();
    expect(synth.texts()).toEqual(["One."]);
    hook.rerender({ voice: next });
    setStore({ blocks: [final("r1", "item-1", "One. Two. Three.")] });
    flush();
    expect(synth.texts()).toEqual(["One.", "Two. Three."]);
    expect(fetchMock).not.toHaveBeenCalled();
    setStore({
      blocks: [final("r1", "item-1", "One. Two. Three."), final("r2", "item-2", "Next.")],
    });
    flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(synth.texts()).toEqual(["One.", "Two. Three."]);
  });
});

describe("useAeSpeakReplies echo window", () => {
  beforeEach(() => resetEcho());

  it("opens the echo window only when audio really plays", () => {
    mount();
    act(() => emitCaption("Hello there friend."));
    expect(getVoiceSnapshot("c1").playing).toBe(false);
    expect(activeEchoWords()).toBeNull();
    act(() => emitPlaying(true));
    expect(getVoiceSnapshot("c1").playing).toBe(true);
    expect(activeEchoWords()).toContain("hello");
  });

  it("an unmount mid-reply closes the window and clears playing", () => {
    const view = mount();
    act(() => {
      emitCaption("Hello there friend.");
      emitPlaying(true);
    });
    expect(activeEchoWords()).not.toBeNull();
    view.unmount();
    expect(getVoiceSnapshot("c1").playing).toBe(false);
    expect(activeEchoWords()).toBeNull();
  });

  it("a chat change closes the window", () => {
    const view = mount();
    act(() => {
      emitCaption("Hello there friend.");
      emitPlaying(true);
    });
    view.rerender({ enabled: true, chatId: "c2" });
    expect(getVoiceSnapshot("c1").playing).toBe(false);
    expect(activeEchoWords()).toBeNull();
  });
});

describe("useAeSpeakReplies", () => {
  it("sends a cloud voice's sentences to the server, not the device", () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    mount(true, "c1", { kind: "cloud", id: "en-US-AvaMultilingualNeural" });
    setStore({ blocks: [final("r1", "item-1", "Whole reply.")] });
    flush();
    expect(synth.texts()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/ae/tts");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Whole reply.",
      voice: "en-US-AvaMultilingualNeural",
      rate: 1,
    });
    vi.unstubAllGlobals();
  });

  it("readLast sends the chosen cloud voice and rate to the server", () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = mount(false, "c1", { kind: "cloud", id: "rocky-xtts" });
    setStore({ blocks: [final("r1", "a", "Last reply.", { createdAtS: 1 })] });
    act(() => result.current.readLast());
    expect(synth.texts()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Last reply.",
      voice: "rocky-xtts",
      rate: 1,
    });
    vi.unstubAllGlobals();
  });

  it("speaks a growing live preview, then only the remainder on the final", () => {
    mount();
    setStore({ blocks: [live("r1", "One. Two")] });
    flush();
    expect(synth.texts()).toEqual(["One."]);
    setStore({ blocks: [live("r1", "One. Two. Thr")] });
    flush();
    expect(synth.texts()).toEqual(["One.", "Two."]);
    setStore({ blocks: [final("r1", "item-1", "One. Two. Three.\n\n**TLDR**\nDone.")] });
    flush();
    expect(synth.texts()).toEqual(["One.", "Two.", "Three."]);
  });

  it("speaks an SDK chunk stream the same way", () => {
    mount();
    setStore({ blocks: [chunk("r1", "Alpha. Be"), chunk("r1", "ta. Gam")] });
    flush();
    expect(synth.texts()).toEqual(["Alpha. Beta."]);
    setStore({ blocks: [final("r1", "item-1", "Alpha. Beta. Gamma.")] });
    flush();
    expect(synth.texts()).toEqual(["Alpha. Beta.", "Gamma."]);
  });

  it("speaks a final that was never streamed whole", () => {
    mount();
    setStore({ blocks: [final("r1", "item-1", "Whole reply.")] });
    flush();
    expect(synth.texts()).toEqual(["Whole reply."]);
  });

  it("does not read back what was on screen when it was enabled", () => {
    setStore({
      blocks: [final("r0", "item-0", "Old reply."), live("r1", "Half sentence. Still going")],
    });
    mount();
    flush();
    expect(synth.texts()).toEqual([]);
    setStore({
      blocks: [
        final("r0", "item-0", "Old reply."),
        live("r1", "Half sentence. Still going. More. Next"),
      ],
    });
    flush();
    expect(synth.texts()).toEqual(["More."]);
  });

  it("ignores history, sub-agent and interrupted text", () => {
    mount();
    setStore({
      blocks: [
        final("r1", "h", "From history.", { createdAtS: 100 }),
        chunk("r2", "Sub agent talking. ", 1),
        { ...final("r3", "i", "Cancelled partial."), interrupted: true } as AnyBlock,
      ],
    });
    flush();
    expect(synth.texts()).toEqual([]);
  });

  it("stops speech when a message is sent", () => {
    mount();
    setStore({ blocks: [final("r1", "item-1", "Talking now.")] });
    flush();
    const cancels = synth.cancelCount;
    setStore({ status: "streaming", ...send() });
    expect(synth.cancelCount).toBeGreaterThan(cancels);
  });

  it("says the working cue once after six seconds of silence", () => {
    mount();
    setStore({ status: "streaming", ...send() });
    act(() => {
      vi.advanceTimersByTime(WORKING_CUE_DELAY_MS - 1);
    });
    expect(synth.texts()).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(synth.texts()).toEqual([WORKING_CUE_TEXT]);
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(synth.texts()).toEqual([WORKING_CUE_TEXT]);
  });

  it("skips the working cue when text arrives first", () => {
    mount();
    setStore({ status: "streaming", ...send() });
    setStore({ blocks: [live("r1", "Quick start. ")] });
    act(() => {
      vi.advanceTimersByTime(WORKING_CUE_DELAY_MS + 10);
    });
    expect(synth.texts()).toEqual(["Quick start."]);
  });

  it("stops and goes quiet when disabled", () => {
    const { rerender } = mount();
    setStore({ blocks: [final("r1", "item-1", "Talking now.")] });
    flush();
    const cancels = synth.cancelCount;
    rerender({ enabled: false, chatId: "c1" });
    expect(synth.cancelCount).toBeGreaterThan(cancels);
    setStore({ blocks: [final("r2", "item-2", "Not spoken.")] });
    flush();
    expect(synth.texts()).toEqual(["Talking now."]);
  });

  it("does nothing without a chat id", () => {
    mount(true, null);
    setStore({ blocks: [final("r1", "item-1", "Silent.")] });
    flush();
    expect(synth.texts()).toEqual([]);
  });

  it("readLast speaks the last lead reply with the TLDR cut", () => {
    const { result } = mount(false);
    setStore({
      blocks: [
        final("r1", "a", "First.", { createdAtS: 1 }),
        final("r2", "b", "**Second** reply.\n\nTLDR\nDone.", { createdAtS: 2 }),
      ],
    });
    act(() => result.current.readLast());
    flush();
    expect(synth.texts()).toEqual(["Second reply."]);
  });

  it("speaks both messages of one response once each", () => {
    mount();
    setStore({ blocks: [live("r1", "First message. ")] });
    flush();
    setStore({ blocks: [final("r1", "m1", "First message.")] });
    flush();
    setStore({ blocks: [final("r1", "m1", "First message."), live("r1", "Second message. ")] });
    flush();
    setStore({
      blocks: [final("r1", "m1", "First message."), final("r1", "m2", "Second message.")],
    });
    flush();
    expect(synth.texts()).toEqual(["First message.", "Second message."]);
  });

  it("speaks an SDK run with two null-itemId finals once each", () => {
    mount();
    const f1 = final("r1", null as never, "Alpha. Beta.");
    const f2 = final("r1", null as never, "Gamma. Delta.");
    setStore({ blocks: [chunk("r1", "Alpha. Beta. ")] });
    flush();
    setStore({ blocks: [chunk("r1", "Alpha. Beta. "), f1] });
    flush();
    setStore({ blocks: [chunk("r1", "Alpha. Beta. "), f1, chunk("r1", "Gamma. Delta. ")] });
    flush();
    setStore({ blocks: [chunk("r1", "Alpha. Beta. "), f1, chunk("r1", "Gamma. Delta. "), f2] });
    flush();
    expect(synth.texts()).toEqual(["Alpha. Beta.", "Gamma. Delta."]);
  });

  it("does not repeat a final that differs from the preview in whitespace", () => {
    mount();
    setStore({ blocks: [live("r1", "One two.  Three four. ")] });
    flush();
    setStore({ blocks: [final("r1", "i1", "One two.   Three four.\n")] });
    flush();
    expect(synth.texts()).toEqual(["One two. Three four."]);
  });

  it("speaks only the sentence a final adds", () => {
    mount();
    setStore({ blocks: [live("r1", "One. Two. Thr")] });
    flush();
    setStore({ blocks: [final("r1", "i1", "One. Two. Three. Four.")] });
    flush();
    expect(synth.texts()).toEqual(["One. Two.", "Three. Four."]);
  });

  it("accepts a refetched final only for a response streamed live", () => {
    mount();
    setStore({ blocks: [live("r1", "Live part. ")] });
    flush();
    setStore({
      blocks: [
        final("r1", "i1", "Live part. And the rest.", { createdAtS: 50 }),
        final("r9", "i9", "Unseen history.", { createdAtS: 51 }),
      ],
    });
    flush();
    expect(synth.texts()).toEqual(["Live part.", "And the rest."]);
  });

  it("leaves speech alone on a status flip with no new user message", () => {
    mount();
    setStore({ blocks: [live("r1", "One. Two")] });
    flush();
    const cancels = synth.cancelCount;
    setStore({ status: "streaming" });
    setStore({ status: "idle" });
    setStore({ status: "streaming" });
    expect(synth.cancelCount).toBe(cancels);
    setStore({ blocks: [live("r1", "One. Two. Three. ")] });
    flush();
    expect(synth.texts()).toEqual(["One.", "Two. Three."]);
  });

  it("stops speech on a queued send while streaming", () => {
    mount();
    setStore({ status: "streaming", blocks: [live("r1", "One. Two")] });
    flush();
    const cancels = synth.cancelCount;
    setStore(send(1));
    expect(synth.cancelCount).toBeGreaterThan(cancels);
    setStore(send(2));
    expect(synth.cancelCount).toBeGreaterThan(cancels + 1);
  });

  it("does not treat a promoted pending message as a send", () => {
    mount();
    setStore({ status: "streaming", ...send(1) });
    flush();
    const cancels = synth.cancelCount;
    const userBlock = {
      type: "user_message",
      ctx: ctx("u1", "u1"),
      content: [],
    } as unknown as AnyBlock;
    setStore({ ...send(0), blocks: [userBlock] });
    expect(synth.cancelCount).toBe(cancels);
  });

  it("speaks a code block phrase once when a streamed message is finalized", () => {
    mount();
    const text = "Run this:\n\n```ps\nInvoke\n```\n";
    setStore({ blocks: [live("r1", text)] });
    flush();
    setStore({ blocks: [final("r1", "m1", "Run this:\n\n```ps\nInvoke\n```")] });
    flush();
    expect(
      synth
        .texts()
        .join(" ")
        .match(/Code block skipped/g),
    ).toHaveLength(1);
  });

  it("speaks a second code block after a different sentence", () => {
    mount();
    setStore({
      blocks: [final("r1", "m1", "One.\n\n```a\nx\n```\n\nTwo.\n\n```b\ny\n```")],
    });
    flush();
    expect(
      synth
        .texts()
        .join(" ")
        .match(/Code block skipped/g),
    ).toHaveLength(2);
  });

  it("speaks a code block in a second message of the same turn", () => {
    mount();
    const m1 = final("r1", "m1", "Alpha.\n\n```a\nx\n```");
    const m2 = final("r1", "m2", "Beta.\n\n```b\ny\n```");
    setStore({ blocks: [m1] });
    flush();
    setStore({ blocks: [m1, m2] });
    flush();
    expect(
      synth
        .texts()
        .join(" ")
        .match(/Code block skipped/g),
    ).toHaveLength(2);
  });

  it("speaks two turns whose replies are both Done.", () => {
    mount();
    setStore({ status: "streaming", ...send(1) });
    setStore({ blocks: [final("r1", "m1", "Done.")] });
    flush();
    setStore({ ...send(2) });
    setStore({ blocks: [final("r1", "m1", "Done."), final("r2", "m2", "Done.")] });
    flush();
    expect(synth.texts()).toEqual(["Done.", "Done."]);
  });

  it("speaks a reply that repeats a sentence from history", () => {
    setStore({ blocks: [final("h", "h1", "Done.", { createdAtS: 5 })] });
    mount();
    setStore({
      blocks: [final("h", "h1", "Done.", { createdAtS: 5 }), final("r1", "m1", "Done.")],
    });
    flush();
    expect(synth.texts()).toEqual(["Done."]);
  });

  it("does not count a rebuilt pending queue as a send, but a later send is", () => {
    mount();
    setStore({ status: "streaming", blocks: [live("r1", "One. Two")] });
    flush();
    const cancels = synth.cancelCount;
    setStore(send(3));
    expect(synth.cancelCount).toBe(cancels);
    setStore({ conversationId: "c2" });
    setStore({ conversationId: "c1", ...send(5) });
    expect(synth.cancelCount).toBe(cancels);
    setStore(send(6));
    expect(synth.cancelCount).toBeGreaterThan(cancels);
  });
});

describe("useAeSpeakReplies after a tap on the speaker", () => {
  beforeEach(() => resetVoiceStore());

  it("speaks nothing more of the reply, and speaks again after the next send", () => {
    mount();
    setStore({ blocks: [live("r1", "One. Two")] });
    flush();
    expect(synth.texts()).toEqual(["One."]);
    act(() => setVoiceBarged("c1", true));
    setStore({ blocks: [live("r1", "One. Two. Three. Fo")] });
    flush();
    setStore({ blocks: [final("r1", "item-1", "One. Two. Three. Four.")] });
    flush();
    expect(synth.texts()).toEqual(["One."]);
    setStore(send(1));
    flush();
    expect(getVoiceSnapshot("c1").barged).toBe(false);
    setStore({ blocks: [live("r2", "Next one. More")] });
    flush();
    expect(synth.texts()).toEqual(["One.", "Next one."]);
  });

  it("a tap during sentence one of a three-sentence streaming reply silences sentences two and three", () => {
    mount();
    setStore({ blocks: [live("r1", "First sentence. Sec")] });
    flush();
    expect(synth.texts()).toEqual(["First sentence."]);
    act(() => setVoiceBarged("c1", true));
    setStore({ blocks: [live("r1", "First sentence. Second sentence. Third sentence. Fo")] });
    flush();
    setStore({
      blocks: [final("r1", "item-1", "First sentence. Second sentence. Third sentence.")],
    });
    flush();
    expect(synth.texts()).toEqual(["First sentence."]);
    setStore(send(1));
    flush();
    expect(getVoiceSnapshot("c1").barged).toBe(false);
    setStore({ blocks: [live("r2", "Fresh reply. More")] });
    flush();
    expect(synth.texts()).toEqual(["First sentence.", "Fresh reply."]);
  });
});

describe("the voice snapshot mirrors", () => {
  beforeEach(() => resetVoiceStore());
  afterEach(() => clearPlaybackBlocked());

  it("the spoken sentence while mounted, cleared on unmount", () => {
    const { unmount } = mount(false);
    act(() => emitCaption("Hello there."));
    expect(getVoiceSnapshot("c1").caption).toBe("Hello there.");
    unmount();
    expect(getVoiceSnapshot("c1").caption).toBe("");
    act(() => emitCaption("Ignored."));
    expect(getVoiceSnapshot("c1").caption).toBe("");
  });

  it("refused playback", () => {
    mount(false);
    act(() => markPlaybackBlocked(() => {}));
    expect(getVoiceSnapshot("c1").blocked).toBe(true);
    act(() => clearPlaybackBlocked());
    expect(getVoiceSnapshot("c1").blocked).toBe(false);
  });

  it("a chat switch leaves the new chat's snapshot unblocked", () => {
    const { rerender } = mount(true);
    act(() => markPlaybackBlocked(() => {}));
    expect(getVoiceSnapshot("c1").blocked).toBe(true);
    act(() => rerender({ enabled: true, chatId: "c2" }));
    expect(getVoiceSnapshot("c2").blocked).toBe(false);
  });
});
