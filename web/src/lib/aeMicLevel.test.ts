import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMicLevel, publishMicLevel, resetMicLevel, useMicLevel } from "./aeMicLevel";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetMicLevel();
});
afterEach(() => {
  resetMicLevel();
  vi.useRealTimers();
});

describe("the mic level", () => {
  it("clamps to 0..1", () => {
    publishMicLevel(3);
    expect(getMicLevel()).toBe(1);
    vi.advanceTimersByTime(60);
    publishMicLevel(-2);
    expect(getMicLevel()).toBe(0);
  });

  it("ignores a change within 50 ms of the last one", () => {
    publishMicLevel(0.4);
    vi.advanceTimersByTime(20);
    publishMicLevel(0.9);
    expect(getMicLevel()).toBe(0.4);
    vi.advanceTimersByTime(40);
    publishMicLevel(0.9);
    expect(getMicLevel()).toBe(0.9);
  });

  it("re-renders a subscriber and resets to 0 at once", () => {
    const { result } = renderHook(() => useMicLevel());
    act(() => publishMicLevel(0.5));
    expect(result.current).toBe(0.5);
    act(() => resetMicLevel());
    expect(result.current).toBe(0);
  });
});
