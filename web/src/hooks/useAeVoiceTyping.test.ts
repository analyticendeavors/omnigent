import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAeVoiceTyping } from "./useAeVoiceTyping";

describe("useAeVoiceTyping", () => {
  it("starts false and turns on with startTyping", () => {
    const { result } = renderHook(() => useAeVoiceTyping(true, false));
    expect(result.current.typing).toBe(false);
    act(() => result.current.startTyping());
    expect(result.current.typing).toBe(true);
  });

  it("resets when the chat becomes busy", () => {
    const { result, rerender } = renderHook(({ busy }) => useAeVoiceTyping(true, busy), {
      initialProps: { busy: false },
    });
    act(() => result.current.startTyping());
    rerender({ busy: true });
    expect(result.current.typing).toBe(false);
  });

  it("resets when Voice mode turns off", () => {
    const { result, rerender } = renderHook(({ on }) => useAeVoiceTyping(on, false), {
      initialProps: { on: true },
    });
    act(() => result.current.startTyping());
    rerender({ on: false });
    expect(result.current.typing).toBe(false);
  });
});
