import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKING_CUE_DELAY_MS, WORKING_CUE_TEXT } from "@/lib/aeSpeakReplies";
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

function mount(enabled = true, chatId: string | null = "c1") {
  return renderHook(
    (p: { enabled: boolean; chatId: string | null }) =>
      useAeSpeakReplies({ ...p, voiceURI: null, rate: 1 }),
    { initialProps: { enabled, chatId } },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  synth = installFakeSpeech();
  useChatStore.setState({ conversationId: "c1", blocks: [], status: "idle" } as never);
});

afterEach(() => {
  vi.useRealTimers();
  removeFakeSpeech();
  useChatStore.setState({ conversationId: null, blocks: [], status: "idle" } as never);
});

describe("useAeSpeakReplies", () => {
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
        live("r1", "Half sentence. Still going. More."),
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
    setStore({ status: "streaming" });
    expect(synth.cancelCount).toBeGreaterThan(cancels);
  });

  it("says the working cue once after six seconds of silence", () => {
    mount();
    setStore({ status: "streaming" });
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
    setStore({ status: "streaming" });
    setStore({ blocks: [live("r1", "Quick start.")] });
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
});
