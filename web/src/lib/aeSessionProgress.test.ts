import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@/lib/events";
import { parseEvent } from "@/lib/sse";
import {
  AE_NO_OUTPUT_HINT_AFTER_MS,
  aeIsContentEvent,
  aeNextProgress,
  aeParseSessionProgress,
  aeProgressText,
  aeShowsNoOutputHint,
} from "./aeSessionProgress";

const CRUNCHING = { label: "Crunching", elapsed: "4m 42s", tokens: "24.5k tokens" };

describe("aeParseSessionProgress", () => {
  it("parses a line, a line without tokens, and a clear", () => {
    expect(aeParseSessionProgress({ conversation_id: "c", ...CRUNCHING })).toEqual({
      type: "session_progress",
      conversationId: "c",
      progress: CRUNCHING,
    });
    expect(
      aeParseSessionProgress({ conversation_id: "c", label: "Thinking", elapsed: "12s" }),
    ).toEqual({
      type: "session_progress",
      conversationId: "c",
      progress: { label: "Thinking", elapsed: "12s", tokens: null },
    });
    expect(aeParseSessionProgress({ conversation_id: "c", label: null })).toEqual({
      type: "session_progress",
      conversationId: "c",
      progress: null,
    });
  });

  it("rejects a payload without a conversation or elapsed time", () => {
    expect(aeParseSessionProgress({ label: "Crunching", elapsed: "1s" })).toBeNull();
    expect(aeParseSessionProgress({ conversation_id: "c", label: "Crunching" })).toBeNull();
    expect(aeParseSessionProgress({ conversation_id: "c", label: 3, elapsed: "1s" })).toBeNull();
  });

  it("is what the SSE parser returns for session.progress", () => {
    expect(parseEvent("session.progress", { conversation_id: "c", ...CRUNCHING })).toEqual({
      type: "session_progress",
      conversationId: "c",
      progress: CRUNCHING,
    });
  });
});

describe("aeProgressText", () => {
  it("joins the parts the line has", () => {
    expect(aeProgressText(CRUNCHING)).toBe("Crunching · 4m 42s · 24.5k tokens");
    expect(aeProgressText({ label: "Thinking", elapsed: "12s", tokens: null })).toBe(
      "Thinking · 12s",
    );
  });
});

describe("aeIsContentEvent", () => {
  it("counts output and items, not bookkeeping", () => {
    const content: StreamEvent[] = [
      { type: "text_delta", delta: "hi" } as StreamEvent,
      { type: "tool_call", name: "Write" } as StreamEvent,
      { type: "tool_output_delta" } as StreamEvent,
      { type: "message_done", content: [] } as unknown as StreamEvent,
    ];
    const bookkeeping: StreamEvent[] = [
      { type: "session_status", conversationId: "c", status: "running" },
      { type: "session_usage" } as unknown as StreamEvent,
      { type: "session_model", conversationId: "c", model: "m" },
      { type: "session_terminal_activity" } as unknown as StreamEvent,
      { type: "session_progress", conversationId: "c", progress: CRUNCHING },
    ];
    expect(content.map(aeIsContentEvent)).toEqual([true, true, true, true]);
    expect(bookkeeping.map(aeIsContentEvent)).toEqual([false, false, false, false, false]);
  });
});

describe("aeNextProgress", () => {
  it("sets, clears on items and non-running status, and leaves the rest alone", () => {
    const progress: StreamEvent = {
      type: "session_progress",
      conversationId: "c",
      progress: CRUNCHING,
    };
    expect(aeNextProgress(progress, "c")).toEqual(CRUNCHING);
    expect(aeNextProgress(progress, "other")).toBeUndefined();
    expect(aeNextProgress({ type: "tool_result" } as StreamEvent, "c")).toBeNull();
    expect(
      aeNextProgress({ type: "session_status", conversationId: "c", status: "idle" }, "c"),
    ).toBeNull();
    expect(
      aeNextProgress({ type: "session_status", conversationId: "c", status: "running" }, "c"),
    ).toBeUndefined();
    expect(aeNextProgress({ type: "text_delta", delta: "x" } as StreamEvent, "c")).toBeUndefined();
  });
});

describe("aeShowsNoOutputHint", () => {
  const base = { progress: null, stepRunning: false, now: 1_000_000 };
  it("hints after a silent minute only", () => {
    const quiet = 1_000_000 - AE_NO_OUTPUT_HINT_AFTER_MS;
    expect(aeShowsNoOutputHint({ ...base, lastContentAt: quiet })).toBe(true);
    expect(aeShowsNoOutputHint({ ...base, lastContentAt: quiet + 1 })).toBe(false);
    expect(aeShowsNoOutputHint({ ...base, lastContentAt: null })).toBe(false);
    expect(aeShowsNoOutputHint({ ...base, progress: CRUNCHING, lastContentAt: quiet })).toBe(false);
    expect(aeShowsNoOutputHint({ ...base, stepRunning: true, lastContentAt: quiet })).toBe(false);
  });
});
