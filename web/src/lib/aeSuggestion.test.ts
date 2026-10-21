import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@/lib/events";
import {
  aeComposerSuggestion,
  aeIsSuggestionAcceptKey,
  aeNextSuggestion,
  aeParseSessionSuggestion,
  aeSameSuggestions,
  aeShownSuggestion,
} from "./aeSuggestion";

const KEY = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };

function suggestion(text: string | null, conversationId = "conv_a"): StreamEvent {
  return { type: "session_suggestion", conversationId, suggestions: text === null ? null : [text] };
}

describe("aeParseSessionSuggestion", () => {
  it("reads a ranked list, a clear, and collapses whitespace", () => {
    expect(
      aeParseSessionSuggestion({
        conversation_id: "c",
        suggestion: "Run the tests",
        suggestions: [" Run\nthe  tests ", "Open a PR"],
      }),
    ).toEqual({
      type: "session_suggestion",
      conversationId: "c",
      suggestions: ["Run the tests", "Open a PR"],
    });
    expect(
      aeParseSessionSuggestion({ conversation_id: "c", suggestion: null, suggestions: null }),
    ).toEqual({ type: "session_suggestion", conversationId: "c", suggestions: null });
  });

  it("reads a lone suggestion from a server that predates the list", () => {
    expect(aeParseSessionSuggestion({ conversation_id: "c", suggestion: "Ship it" })).toEqual({
      type: "session_suggestion",
      conversationId: "c",
      suggestions: ["Ship it"],
    });
  });

  it("keeps at most three and drops blank guesses", () => {
    expect(
      aeParseSessionSuggestion({ conversation_id: "c", suggestions: ["a", " ", "b", "c", "d"] })
        ?.suggestions,
    ).toEqual(["a", "b", "c"]);
    expect(
      aeParseSessionSuggestion({ conversation_id: "c", suggestions: ["  "] })?.suggestions,
    ).toBeNull();
  });

  it("rejects a payload without a conversation or with a non-string guess", () => {
    expect(aeParseSessionSuggestion({ suggestion: "x" })).toBeNull();
    expect(aeParseSessionSuggestion({ conversation_id: "c", suggestion: 7 })).toBeNull();
    expect(aeParseSessionSuggestion({ conversation_id: "c", suggestions: ["a", 7] })).toBeNull();
    expect(aeParseSessionSuggestion({ conversation_id: "c", suggestions: "a" })).toBeNull();
  });
});

describe("aeSameSuggestions", () => {
  it("compares by content", () => {
    expect(aeSameSuggestions(["a", "b"], ["a", "b"])).toBe(true);
    expect(aeSameSuggestions(["a", "b"], ["b", "a"])).toBe(false);
    expect(aeSameSuggestions(null, undefined)).toBe(true);
    expect(aeSameSuggestions(["a"], null)).toBe(false);
  });
});

describe("aeNextSuggestion", () => {
  it("keeps this conversation's suggestion while idle and ignores another's", () => {
    expect(aeNextSuggestion(suggestion("Open a PR"), "conv_a", "idle")).toEqual(["Open a PR"]);
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
    const go = ["Go", "Stop"];
    expect(aeComposerSuggestion(go, { busy: false, blocked: false })).toBe(go);
    expect(aeComposerSuggestion(go, { busy: true, blocked: false })).toBeNull();
    expect(aeComposerSuggestion(go, { busy: false, blocked: true })).toBeNull();
  });

  it("draws the ghost only over an empty box", () => {
    const go = ["Go"];
    expect(aeShownSuggestion(go, "")).toBe(go);
    expect(aeShownSuggestion(go, "h")).toBeNull();
    expect(aeShownSuggestion(null, "")).toBeNull();
    expect(aeShownSuggestion([], "")).toBeNull();
  });

  it("takes plain Tab only", () => {
    expect(aeIsSuggestionAcceptKey({ key: "Tab", ...KEY })).toBe(true);
    expect(aeIsSuggestionAcceptKey({ key: "Tab", ...KEY, shiftKey: true })).toBe(false);
    expect(aeIsSuggestionAcceptKey({ key: "Enter", ...KEY })).toBe(false);
  });
});
