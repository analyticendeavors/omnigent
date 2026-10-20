import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@/lib/events";
import {
  aeComposerSuggestion,
  aeIsSuggestionAcceptKey,
  aeNextSuggestion,
  aeParseSessionSuggestion,
  aeShownSuggestion,
} from "./aeSuggestion";

const KEY = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };

function suggestion(text: string | null, conversationId = "conv_a"): StreamEvent {
  return { type: "session_suggestion", conversationId, suggestion: text };
}

describe("aeParseSessionSuggestion", () => {
  it("reads a suggestion, a clear, and collapses whitespace", () => {
    expect(
      aeParseSessionSuggestion({ conversation_id: "c", suggestion: " Run\nthe  tests " }),
    ).toEqual({ type: "session_suggestion", conversationId: "c", suggestion: "Run the tests" });
    expect(aeParseSessionSuggestion({ conversation_id: "c", suggestion: null })).toEqual({
      type: "session_suggestion",
      conversationId: "c",
      suggestion: null,
    });
  });

  it("rejects a payload without a conversation or with a non-string suggestion", () => {
    expect(aeParseSessionSuggestion({ suggestion: "x" })).toBeNull();
    expect(aeParseSessionSuggestion({ conversation_id: "c", suggestion: 7 })).toBeNull();
  });
});

describe("aeNextSuggestion", () => {
  it("keeps this conversation's suggestion while idle and ignores another's", () => {
    expect(aeNextSuggestion(suggestion("Open a PR"), "conv_a", "idle")).toBe("Open a PR");
    expect(aeNextSuggestion(suggestion("Open a PR", "conv_b"), "conv_a", "idle")).toBeUndefined();
  });

  it("drops a suggestion that arrives while a turn runs", () => {
    expect(aeNextSuggestion(suggestion("late"), "conv_a", "running")).toBeUndefined();
  });

  it("clears when the next turn starts or the session rotates", () => {
    const running: StreamEvent = {
      type: "session_status",
      conversationId: "conv_a",
      status: "running",
    } as StreamEvent;
    expect(aeNextSuggestion(running, "conv_a", "idle")).toBeNull();
    const idle = { ...running, status: "idle" } as StreamEvent;
    expect(aeNextSuggestion(idle, "conv_a", "running")).toBeUndefined();
    expect(
      aeNextSuggestion(
        { type: "session_superseded", conversationId: "conv_a" } as StreamEvent,
        "conv_a",
        "idle",
      ),
    ).toBeNull();
  });
});

describe("composer visibility", () => {
  it("shows only when idle and the box accepts input", () => {
    expect(aeComposerSuggestion("Go", { busy: false, blocked: false })).toBe("Go");
    expect(aeComposerSuggestion("Go", { busy: true, blocked: false })).toBeNull();
    expect(aeComposerSuggestion("Go", { busy: false, blocked: true })).toBeNull();
  });

  it("draws the ghost only over an empty box", () => {
    expect(aeShownSuggestion("Go", "")).toBe("Go");
    expect(aeShownSuggestion("Go", "h")).toBeNull();
    expect(aeShownSuggestion(null, "")).toBeNull();
  });

  it("takes plain Tab only", () => {
    expect(aeIsSuggestionAcceptKey({ key: "Tab", ...KEY })).toBe(true);
    expect(aeIsSuggestionAcceptKey({ key: "Tab", ...KEY, shiftKey: true })).toBe(false);
    expect(aeIsSuggestionAcceptKey({ key: "Enter", ...KEY })).toBe(false);
  });
});
