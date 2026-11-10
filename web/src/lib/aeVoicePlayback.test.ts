import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPlaybackBlocked,
  isPlaybackBlocked,
  markPlaybackBlocked,
  resumePlayback,
  usePlaybackBlocked,
} from "./aeVoicePlayback";

afterEach(() => clearPlaybackBlocked());

describe("refused playback", () => {
  it("marks, resumes inside the caller and stays blocked until cleared", () => {
    const resume = vi.fn();
    markPlaybackBlocked(resume);
    expect(isPlaybackBlocked()).toBe(true);
    resumePlayback();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(isPlaybackBlocked()).toBe(true);
    clearPlaybackBlocked();
    expect(isPlaybackBlocked()).toBe(false);
    resumePlayback();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("a throwing resume does not escape", () => {
    markPlaybackBlocked(() => {
      throw new Error("x");
    });
    expect(() => resumePlayback()).not.toThrow();
  });

  it("re-renders a subscriber", () => {
    const { result } = renderHook(() => usePlaybackBlocked());
    expect(result.current).toBe(false);
    act(() => markPlaybackBlocked(() => {}));
    expect(result.current).toBe(true);
    act(() => clearPlaybackBlocked());
    expect(result.current).toBe(false);
  });
});
