import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@/lib/events";
import { parseEvent } from "@/lib/sse";
import {
  AE_NO_OUTPUT_HINT_AFTER_MS,
  AE_PROGRESS_STALE_MS,
  aeIsContentEvent,
  aeLiveProgress,
  aeNextProgress,
  aeParseSessionProgress,
  aeProgressText,
  aeShowsNoOutputHint,
  aeTuiElapsed,
} from "./aeSessionProgress";

const LINE = { label: "Crunching", elapsed: "4m 42s", elapsedS: 282, tokens: "24.5k tokens" };
const WIRE = { label: "Crunching", elapsed: "4m 42s", elapsed_s: 282, tokens: "24.5k tokens" };

describe("aeParseSessionProgress", () => {
  it("parses a line, a line without seconds or tokens, and a clear", () => {
    expect(aeParseSessionProgress({ conversation_id: "c", ...WIRE })).toEqual({
      type: "session_progress",
      conversationId: "c",
      progress: LINE,
    });
    expect(
      aeParseSessionProgress({ conversation_id: "c", label: "Thinking", elapsed: "12s" }),
    ).toEqual({
      type: "session_progress",
      conversationId: "c",
      progress: { label: "Thinking", elapsed: "12s", elapsedS: null, tokens: null },
    });
    expect(aeParseSessionProgress({ conversation_id: "c", label: null })).toEqual({
      type: "session_progress",
      conversationId: "c",
      progress: null,
    });
  });

  it("rejects a payload without a conversation or elapsed time, and ignores bad seconds", () => {
    expect(aeParseSessionProgress({ label: "Crunching", elapsed: "1s" })).toBeNull();
    expect(aeParseSessionProgress({ conversation_id: "c", label: "Crunching" })).toBeNull();
    expect(aeParseSessionProgress({ conversation_id: "c", label: 3, elapsed: "1s" })).toBeNull();
    expect(
      aeParseSessionProgress({ conversation_id: "c", label: "A", elapsed: "1s", elapsed_s: -4 })
        ?.progress?.elapsedS,
    ).toBeNull();
  });

  it("is what the SSE parser returns for session.progress", () => {
    expect(parseEvent("session.progress", { conversation_id: "c", ...WIRE })).toEqual({
      type: "session_progress",
      conversationId: "c",
      progress: LINE,
    });
  });
});

describe("aeProgressText", () => {
  it("ticks the elapsed time from when the line arrived, in the terminal's format", () => {
    const progress = { ...LINE, receivedAt: 1_000_000 };
    expect(aeProgressText(progress, 1_000_000)).toBe("Crunching · 4m 42s · 24.5k tokens");
    expect(aeProgressText(progress, 1_007_900)).toBe("Crunching · 4m 49s · 24.5k tokens");
    expect(aeProgressText(progress, 999_000)).toBe("Crunching · 4m 42s · 24.5k tokens");
  });

  it("falls back to the drawn text without seconds", () => {
    const progress = { ...LINE, elapsedS: null, tokens: null, receivedAt: 0 };
    expect(aeProgressText(progress, 90_000)).toBe("Crunching · 4m 42s");
  });

  it("formats like the TUI", () => {
    expect([aeTuiElapsed(12), aeTuiElapsed(282), aeTuiElapsed(3780)]).toEqual([
      "12s",
      "4m 42s",
      "1h 3m",
    ]);
  });
});

describe("aeLiveProgress", () => {
  it("drops a line no update refreshed for 30 seconds", () => {
    const progress = { ...LINE, receivedAt: 1_000_000 };
    expect(aeLiveProgress(progress, 1_000_000 + AE_PROGRESS_STALE_MS)).toBe(progress);
    expect(aeLiveProgress(progress, 1_000_001 + AE_PROGRESS_STALE_MS)).toBeNull();
    expect(aeLiveProgress(null, 0)).toBeNull();
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
      { type: "session_progress", conversationId: "c", progress: LINE },
    ];
    expect(content.map(aeIsContentEvent)).toEqual([true, true, true, true]);
    expect(bookkeeping.map(aeIsContentEvent)).toEqual([false, false, false, false, false]);
  });
});

describe("aeNextProgress", () => {
  it("sets, clears on items, supersession and non-running status, and leaves the rest", () => {
    const progress: StreamEvent = { type: "session_progress", conversationId: "c", progress: LINE };
    expect(aeNextProgress(progress, "c")).toEqual(LINE);
    expect(aeNextProgress(progress, "other")).toBeUndefined();
    expect(aeNextProgress({ type: "tool_result" } as StreamEvent, "c")).toBeNull();
    expect(
      aeNextProgress(
        {
          type: "session_superseded",
          conversationId: "c",
          targetConversationId: "d",
          reason: "clear",
        },
        "c",
      ),
    ).toBeNull();
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
  it("hints after a silent minute only", () => {
    const now = 1_000_000;
    const quiet = now - AE_NO_OUTPUT_HINT_AFTER_MS;
    expect(aeShowsNoOutputHint(quiet, now)).toBe(true);
    expect(aeShowsNoOutputHint(quiet + 1, now)).toBe(false);
    expect(aeShowsNoOutputHint(null, now)).toBe(false);
  });
});
