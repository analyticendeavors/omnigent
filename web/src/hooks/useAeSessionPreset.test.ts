import { afterEach, describe, expect, it } from "vitest";
import { aeDropStartOn, aeTakeStartOn } from "@/lib/aeStartOnApply";
import { useChatStore } from "@/store/chatStore";
import { aeNoteStartOn } from "./useAeSessionPreset";

const LINE = 'inspect it\nSTART ON: preset "YOLO"';

function chat(patch: Partial<ReturnType<typeof useChatStore.getState>>) {
  useChatStore.setState({
    conversationId: "c1",
    loadingConversation: false,
    abortController: new AbortController(),
    conversationLoadError: null,
    hasMoreHistory: false,
    pendingUserMessages: [],
    queuedMessages: [],
    blocks: [],
    ...patch,
  });
}

afterEach(() => {
  aeDropStartOn();
});

describe("aeNoteStartOn", () => {
  it("queues for a session whose history loaded and is empty", () => {
    chat({});
    aeNoteStartOn(LINE, "c1", []);
    expect(aeTakeStartOn("c1")).toMatchObject({ text: LINE });
  });

  it("does not count an existing session whose items have not loaded yet", () => {
    chat({ abortController: null });
    aeNoteStartOn(LINE, "c1", []);
    expect(aeTakeStartOn("c1")).toBeNull();
    chat({ loadingConversation: true });
    aeNoteStartOn(LINE, "c1", []);
    expect(aeTakeStartOn("c1")).toBeNull();
    chat({ conversationId: "other" });
    aeNoteStartOn(LINE, "c1", []);
    expect(aeTakeStartOn("c1")).toBeNull();
  });

  it("does not count a session with turns or older history", () => {
    chat({ hasMoreHistory: true });
    aeNoteStartOn(LINE, "c1", []);
    expect(aeTakeStartOn("c1")).toBeNull();
    chat({ pendingUserMessages: [{ tempId: "t", content: [], createdAtS: 0 }] });
    aeNoteStartOn(LINE, "c1", []);
    expect(aeTakeStartOn("c1")).toBeNull();
  });

  it("counts a new session (landing page or New Chat dialog) without store state", () => {
    chat({ conversationId: null });
    aeNoteStartOn(LINE, null, []);
    expect(aeTakeStartOn(null)).not.toBeNull();
    aeNoteStartOn(LINE, "conv_new", [], { isNewSession: true });
    expect(aeTakeStartOn("conv_other")).toBeNull();
    expect(aeTakeStartOn("conv_new")).not.toBeNull();
  });

  it("drops a queued plan when the next message has no START ON line", () => {
    chat({});
    aeNoteStartOn(LINE, "c1", []);
    aeNoteStartOn("a later message", "c1", []);
    expect(aeTakeStartOn("c1")).toBeNull();
  });
});
