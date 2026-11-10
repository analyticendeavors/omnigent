// Tests for the voice log: ring buffer, window, detail cap, format and the insert event.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatVoiceLog,
  logVoice,
  requestVoiceLogInsert,
  resetVoiceLog,
  useVoiceLogInsert,
} from "./aeVoiceLog";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
  resetVoiceLog();
});
afterEach(() => vi.useRealTimers());

describe("voice log", () => {
  it("formats a header and offset lines, oldest first", () => {
    logVoice("mic start", "browser");
    vi.advanceTimersByTime(1230);
    logVoice("final", "hello");
    const lines = formatVoiceLog().split("\n");
    expect(lines[0]).toBe(`Voice log 2026-11-10T12:00:00.000Z ${navigator.userAgent}`);
    expect(lines[1]).toBe("+0.00s mic start browser");
    expect(lines[2]).toBe("+1.23s final hello");
  });

  it("keeps only entries inside the window", () => {
    logVoice("old");
    vi.advanceTimersByTime(130_000);
    logVoice("new");
    const text = formatVoiceLog();
    expect(text).toContain("new");
    expect(text).not.toContain("old");
    expect(formatVoiceLog(200_000)).toContain("old");
  });

  it("caps details at 80 characters and the buffer at 300 entries", () => {
    logVoice("long", "x".repeat(200));
    expect(formatVoiceLog().split("\n")[1]).toBe(`+0.00s long ${"x".repeat(80)}`);
    resetVoiceLog();
    for (let i = 0; i < 350; i += 1) logVoice(`e${i}`);
    const lines = formatVoiceLog().split("\n");
    expect(lines).toHaveLength(301);
    expect(lines[1]).toContain("e50");
  });

  it("asks the page to insert the log into the draft", () => {
    logVoice("voice on");
    const setValue = vi.fn();
    const { rerender } = renderHook(({ v }) => useVoiceLogInsert(v, setValue), {
      initialProps: { v: "" },
    });
    act(() => requestVoiceLogInsert());
    expect(setValue).toHaveBeenLastCalledWith(expect.stringContaining("+0.00s voice on"));
    rerender({ v: "draft" });
    act(() => requestVoiceLogInsert());
    expect(setValue).toHaveBeenLastCalledWith(expect.stringMatching(/^draft\n\nVoice log /));
  });
});
