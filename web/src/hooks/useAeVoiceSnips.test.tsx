import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { registerVoiceSpeaker, resetVoiceStore, type VoicePhase } from "@/lib/aeVoiceMode";
import { resetSnipsStore, SNIP_NOTE, SNIP_WAIT_MS, writeSendSnips } from "@/lib/aeVoiceSnips";
import { type UseAeVoiceSnipsArgs, useAeVoiceSnips } from "./useAeVoiceSnips";

const png = () => new File(["x"], "a.png", { type: "image/png" });
const pdf = () => new File(["x"], "a.pdf", { type: "application/pdf" });

let speak: Mock<(text: string) => void>;
let setValue: Mock<(value: string) => void>;
let submit: Mock<() => void>;
let addFiles: Mock<(files: File[]) => void>;

function base(over: Partial<UseAeVoiceSnipsArgs> = {}): UseAeVoiceSnipsArgs {
  return {
    chatId: "c1",
    voiceOn: true,
    phase: "listening" as VoicePhase,
    cardActive: false,
    files: [],
    addFiles,
    value: "",
    setValue,
    submit,
    canSend: true,
    ...over,
  };
}

function setup(over: Partial<UseAeVoiceSnipsArgs> = {}) {
  return renderHook((p: UseAeVoiceSnipsArgs) => useAeVoiceSnips(p), { initialProps: base(over) });
}

const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  resetSnipsStore();
  resetVoiceStore();
  speak = vi.fn<(text: string) => void>();
  setValue = vi.fn<(value: string) => void>();
  submit = vi.fn<() => void>();
  addFiles = vi.fn<(files: File[]) => void>();
  registerVoiceSpeaker("c1", speak);
  writeSendSnips(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function paste(target: EventTarget, files: File[]) {
  const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
    clipboardData: unknown;
  };
  ev.clipboardData = { items: [], files };
  act(() => void target.dispatchEvent(ev));
  return ev;
}

describe("useAeVoiceSnips", () => {
  it("does nothing when a switch is off", () => {
    const add = vi.spyOn(window, "addEventListener");
    writeSendSnips(false);
    const { rerender, result } = setup();
    rerender(base({ files: [png()] }));
    tick(SNIP_WAIT_MS);
    expect(result.current.active).toBe(false);
    expect(speak).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(add.mock.calls.some((c) => c[0] === "paste")).toBe(false);
    writeSendSnips(true);
    const second = setup({ voiceOn: false });
    second.rerender(base({ voiceOn: false, files: [png()] }));
    tick(SNIP_WAIT_MS);
    expect(speak).not.toHaveBeenCalled();
  });

  it("acknowledges once, then sends Note this. after 10 s", () => {
    const { rerender, result } = setup();
    const files = [png()];
    rerender(base({ files }));
    expect(speak).toHaveBeenCalledExactlyOnceWith("Got it.");
    expect(result.current.pending).toBe(true);
    tick(SNIP_WAIT_MS);
    expect(setValue).toHaveBeenCalledExactlyOnceWith(SNIP_NOTE);
    expect(submit).not.toHaveBeenCalled();
    rerender(base({ files, value: SNIP_NOTE }));
    tick(0);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("leaves a dictated sentence to Voice mode", () => {
    const { rerender } = setup();
    const files = [png()];
    rerender(base({ files }));
    rerender(base({ files, value: "look at this" }));
    tick(SNIP_WAIT_MS);
    expect(setValue).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("holds while speaking and sends once listening again", () => {
    const { rerender } = setup();
    const files = [png()];
    rerender(base({ files }));
    rerender(base({ files, phase: "speaking" }));
    tick(SNIP_WAIT_MS);
    expect(setValue).not.toHaveBeenCalled();
    rerender(base({ files, phase: "listening" }));
    expect(setValue).toHaveBeenCalledExactlyOnceWith(SNIP_NOTE);
  });

  it("cancels when the files are emptied", () => {
    const { rerender } = setup();
    rerender(base({ files: [png()] }));
    rerender(base({ files: [] }));
    tick(SNIP_WAIT_MS);
    expect(setValue).not.toHaveBeenCalled();
  });

  it("ignores a PDF", () => {
    const { rerender, result } = setup();
    rerender(base({ files: [pdf()] }));
    tick(SNIP_WAIT_MS);
    expect(speak).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
  });

  it("attaches a pasted image outside the composer fields only", () => {
    setup();
    const img = png();
    const ev = paste(document.body, [img]);
    expect(addFiles).toHaveBeenCalledWith([img]);
    expect(ev.defaultPrevented).toBe(true);
    addFiles.mockClear();
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    const ev2 = paste(ta, [img]);
    expect(addFiles).not.toHaveBeenCalled();
    expect(ev2.defaultPrevented).toBe(false);
    ta.remove();
  });

  it("cancels the clock when the chat changes", () => {
    const { rerender } = setup();
    rerender(base({ files: [png()] }));
    rerender(base({ chatId: "c2", files: [png()] }));
    tick(SNIP_WAIT_MS);
    expect(setValue).not.toHaveBeenCalled();
  });

  it("counts two pictures in one batch as one event", () => {
    const { rerender } = setup();
    rerender(base({ files: [png(), png()] }));
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("holds while canSend is false and sends when it turns true", () => {
    const { rerender } = setup();
    const files = [png()];
    rerender(base({ files, canSend: false }));
    tick(SNIP_WAIT_MS);
    expect(setValue).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    rerender(base({ files, canSend: true }));
    expect(setValue).toHaveBeenCalledExactlyOnceWith(SNIP_NOTE);
  });
});
