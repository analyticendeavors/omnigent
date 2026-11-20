// Tests for the dictation socket protocol parsing. The DictationSession
// transport itself (mic + AudioWorklet + WebSocket) can't run in jsdom;
// its behavior against the component is pinned in ComposerMicButton.test.tsx
// with a mocked session, and the full loop runs in the Playwright e2e test
// against the server's fake engine.

import { afterEach, describe, expect, it, vi } from "vitest";
import { getMicStream } from "@/lib/aeAudioDevices";
import { DictationBusyError, DictationSession, parseDictationEvent } from "./dictation";

vi.mock("@/lib/aeAudioDevices", () => ({ getMicStream: vi.fn() }));

class FakeSocket {
  static last: FakeSocket | null = null;
  static OPEN = 1;
  binaryType = "";
  readyState = 0;
  closed = false;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(_url: string) {
    FakeSocket.last = this;
  }
  close() {
    this.closed = true;
  }
  addEventListener() {}
  removeEventListener() {}
}

const events = { onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn() };

function fakeStream() {
  const track = { stop: vi.fn() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

describe("DictationSession.start opens the mic and the socket together", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(getMicStream).mockReset();
    FakeSocket.last = null;
  });

  it("asks for the mic before the socket is ready", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.mocked(getMicStream).mockReturnValue(new Promise(() => {}));
    void DictationSession.start(events).catch(() => {});
    expect(getMicStream).toHaveBeenCalledTimes(1);
    expect(FakeSocket.last).not.toBeNull();
  });

  it("a denied mic rejects and closes the socket", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.mocked(getMicStream).mockRejectedValue(new Error("denied"));
    const started = DictationSession.start(events);
    FakeSocket.last?.onmessage?.({ data: '{"type":"ready"}' });
    await expect(started).rejects.toThrow("denied");
    expect(FakeSocket.last?.closed).toBe(true);
  });

  it("a denied mic closes the socket at once, while it is still connecting", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.mocked(getMicStream).mockRejectedValue(new Error("denied"));
    const started = DictationSession.start(events);
    await expect(started).rejects.toThrow("denied");
    expect(FakeSocket.last?.closed).toBe(true);
  });

  it("a socket failure rejects at once and stops a mic that opens later", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const { stream, track } = fakeStream();
    let openMic: (s: MediaStream) => void = () => {};
    vi.mocked(getMicStream).mockReturnValue(
      new Promise((r) => {
        openMic = r;
      }),
    );
    const started = DictationSession.start(events);
    FakeSocket.last?.onerror?.();
    await expect(started).rejects.toThrow("dictation connection failed");
    expect(track.stop).not.toHaveBeenCalled();
    openMic(stream);
    await Promise.resolve();
    await Promise.resolve();
    expect(track.stop).toHaveBeenCalled();
  });

  it("when both fail the mic error wins", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.mocked(getMicStream).mockRejectedValue(new Error("denied"));
    const started = DictationSession.start(events);
    FakeSocket.last?.onerror?.();
    await expect(started).rejects.toThrow("denied");
  });

  it("a busy close (1013) during the parallel wait rejects as busy", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const { stream, track } = fakeStream();
    vi.mocked(getMicStream).mockResolvedValue(stream);
    const started = DictationSession.start(events);
    FakeSocket.last?.onclose?.({ code: 1013 });
    await expect(started).rejects.toBeInstanceOf(DictationBusyError);
    expect(track.stop).toHaveBeenCalled();
  });

  it("a failed socket rejects and stops the mic that did open", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const { stream, track } = fakeStream();
    vi.mocked(getMicStream).mockResolvedValue(stream);
    const started = DictationSession.start(events);
    FakeSocket.last?.onerror?.();
    await expect(started).rejects.toThrow("dictation connection failed");
    expect(track.stop).toHaveBeenCalled();
    expect(FakeSocket.last?.closed).toBe(true);
  });
});

describe("parseDictationEvent", () => {
  it("parses the transcript event shapes", () => {
    expect(parseDictationEvent('{"type":"ready"}')).toEqual({ type: "ready" });
    expect(parseDictationEvent('{"type":"partial","text":"hel"}')).toEqual({
      type: "partial",
      text: "hel",
    });
    expect(parseDictationEvent('{"type":"final","text":"hello."}')).toEqual({
      type: "final",
      text: "hello.",
    });
    expect(parseDictationEvent('{"type":"stopped","text":""}')).toEqual({
      type: "stopped",
      text: "",
    });
    expect(parseDictationEvent('{"type":"error","message":"boom"}')).toEqual({
      type: "error",
      message: "boom",
    });
  });

  it("returns null for malformed or unknown frames", () => {
    expect(parseDictationEvent("not json")).toBeNull();
    expect(parseDictationEvent("42")).toBeNull();
    expect(parseDictationEvent("null")).toBeNull();
    expect(parseDictationEvent('{"type":"future-thing"}')).toBeNull();
    // Known types with a missing/mistyped payload are dropped, not crashed on.
    expect(parseDictationEvent('{"type":"partial"}')).toBeNull();
    expect(parseDictationEvent('{"type":"partial","text":7}')).toBeNull();
    expect(parseDictationEvent('{"type":"error"}')).toBeNull();
  });
});
