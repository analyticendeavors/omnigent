import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disarmVoiceForNextChat, GRACE_MS, takeVoiceArm } from "@/lib/aeVoiceMode";
import { installFakeSpeech, removeFakeSpeech } from "@/test/fakeSpeech";
import { useAeVoiceStart } from "./useAeVoiceStart";

function setup(over: { value?: string; canSubmit?: boolean } = {}) {
  const mic = { start: vi.fn(), stop: vi.fn(), restart: vi.fn(), isListening: () => false };
  const submit = vi.fn();
  const controller = { current: mic };
  const hook = renderHook(
    (props: { value: string; canSubmit: boolean }) =>
      useAeVoiceStart({ controller, submit, ...props }),
    { initialProps: { value: over.value ?? "hello", canSubmit: over.canSubmit ?? true } },
  );
  return { mic, submit, ...hook };
}

beforeEach(() => {
  vi.useFakeTimers();
  installFakeSpeech();
});
afterEach(() => {
  vi.useRealTimers();
  removeFakeSpeech();
  disarmVoiceForNextChat();
});

describe("useAeVoiceStart", () => {
  it("toggle arms the next chat and starts the mic; a second toggle disarms and stops it", () => {
    const { result, mic } = setup();
    act(() => result.current.toggle());
    expect(result.current.armed).toBe(true);
    expect(result.current.phase).toBe("starting");
    expect(mic.start).toHaveBeenCalledTimes(1);
    act(() => result.current.onListening(true));
    expect(result.current.phase).toBe("listening");
    act(() => result.current.toggle());
    expect(result.current.armed).toBe(false);
    expect(mic.stop).toHaveBeenCalledTimes(1);
    expect(takeVoiceArm()).toBe(false);
  });

  it("reports unavailable when the mic never listened", () => {
    const { result } = setup();
    act(() => result.current.toggle());
    act(() => result.current.onListening(false));
    expect(result.current.phase).toBe("unavailable");
  });

  it("submits GRACE_MS after the last final, then disarms and stops the mic", () => {
    const { result, submit, mic } = setup();
    act(() => result.current.toggle());
    act(() => result.current.onFinal("hello"));
    act(() => void vi.advanceTimersByTime(GRACE_MS - 1));
    expect(submit).not.toHaveBeenCalled();
    act(() => result.current.onFinal("again"));
    act(() => void vi.advanceTimersByTime(GRACE_MS - 1));
    expect(submit).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.current.armed).toBe(false);
    expect(mic.stop).toHaveBeenCalled();
    // The session is created asynchronously, so the flag stays for takeVoiceArm.
    expect(takeVoiceArm()).toBe(true);
  });

  it("does not submit when the page cannot submit or the draft is empty", () => {
    const blocked = setup({ canSubmit: false });
    act(() => blocked.result.current.toggle());
    act(() => blocked.result.current.onFinal("hello"));
    act(() => void vi.advanceTimersByTime(GRACE_MS + 10));
    expect(blocked.submit).not.toHaveBeenCalled();

    const empty = setup({ value: "  " });
    act(() => empty.result.current.toggle());
    act(() => empty.result.current.onFinal("hello"));
    act(() => void vi.advanceTimersByTime(GRACE_MS + 10));
    expect(empty.submit).not.toHaveBeenCalled();
  });

  it("ignores a final while not armed", () => {
    const { result, submit } = setup();
    act(() => result.current.onFinal("hello"));
    act(() => void vi.advanceTimersByTime(GRACE_MS + 10));
    expect(submit).not.toHaveBeenCalled();
  });

  it("unmounting clears the flag and the timer", () => {
    const { result, submit, unmount } = setup();
    act(() => result.current.toggle());
    act(() => result.current.onFinal("hello"));
    unmount();
    act(() => void vi.advanceTimersByTime(GRACE_MS + 10));
    expect(submit).not.toHaveBeenCalled();
    expect(takeVoiceArm()).toBe(false);
  });
});

describe("useAeVoiceStart with a mic that is already listening", () => {
  it("toggle reports listening at once, since start fires no event", () => {
    const { result, mic } = setup();
    mic.isListening = () => true;
    act(() => result.current.toggle());
    expect(result.current.phase).toBe("listening");
  });

  it("restart starts the mic again and reports listening when it already is", () => {
    const { result, mic } = setup();
    act(() => result.current.toggle());
    act(() => result.current.onListening(false));
    expect(result.current.phase).toBe("unavailable");
    act(() => result.current.restart());
    expect(mic.start).toHaveBeenCalledTimes(2);
    mic.isListening = () => true;
    act(() => result.current.restart());
    expect(result.current.phase).toBe("listening");
  });
});
