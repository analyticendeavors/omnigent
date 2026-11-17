// Tests for the voice log: ring buffer, window, detail cap, format and the insert event.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showToast } from "@/components/ui/toast";
import {
  formatVoiceLog,
  logVoice,
  requestVoiceLogInsert,
  resetVoiceLog,
  UPLOAD_MIN_GAP_MS,
  UPLOAD_TIMEOUT_MS,
  uploadVoiceLog,
  useVoiceLogInsert,
  useVoiceLogOnHide,
} from "./aeVoiceLog";

vi.mock("@/components/ui/toast", () => ({ showToast: vi.fn() }));

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

  it("puts the log before a draft that is a slash command", () => {
    logVoice("voice on");
    const setValue = vi.fn();
    renderHook(() => useVoiceLogInsert("  /review the diff", setValue));
    act(() => requestVoiceLogInsert());
    expect(setValue).toHaveBeenLastCalledWith(expect.stringMatching(/^Voice log [\s\S]*\n\n {2}\/review the diff$/));
  });
});

describe("uploadVoiceLog", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function lastBody() {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, init, body: JSON.parse(String(init.body)) };
  }

  it("posts the buffer with the reason and chat id, without keepalive, as JSON", async () => {
    logVoice("mic start", "browser");
    logVoice("final", "hello");
    await expect(uploadVoiceLog("manual", "c1")).resolves.toBe("sent");
    const { url, init, body } = lastBody();
    expect(url).toContain("/v1/ae/voice-log");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBeUndefined();
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(body.reason).toBe("manual");
    expect(body.chat_id).toBe("c1");
    expect(body.lines[0].event).toBe("client");
    expect(body.lines.map((l: { event: string }) => l.event)).toEqual([
      "client",
      "mic start",
      "final",
    ]);
    expect(body.lines[2]).toEqual({ t: expect.any(Number), event: "final", detail: "hello" });
  });

  it("leaves chat_id out when there is none", async () => {
    await uploadVoiceLog("voice_end");
    expect("chat_id" in lastBody().body).toBe(false);
  });

  it("shares one budget across automatic reasons, one upload per 60 s", async () => {
    await expect(uploadVoiceLog("mic_failed")).resolves.toBe("sent");
    await expect(uploadVoiceLog("mic_failed")).resolves.toBe("throttled");
    await expect(uploadVoiceLog("mic_deaf")).resolves.toBe("throttled");
    await expect(uploadVoiceLog("voice_end")).resolves.toBe("throttled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(UPLOAD_MIN_GAP_MS - 1);
    await expect(uploadVoiceLog("mic_deaf")).resolves.toBe("throttled");
    vi.advanceTimersByTime(1);
    await expect(uploadVoiceLog("mic_deaf")).resolves.toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("manual sends skip the client budget and do not spend it", async () => {
    await expect(uploadVoiceLog("manual")).resolves.toBe("sent");
    await expect(uploadVoiceLog("manual")).resolves.toBe("sent");
    await expect(uploadVoiceLog("mic_failed")).resolves.toBe("sent");
    await expect(uploadVoiceLog("manual")).resolves.toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("spends the budget only after the server accepted, so a failure can be retried", async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("{}", { status: 503 })));
    await expect(uploadVoiceLog("mic_failed")).resolves.toBe("failed");
    await expect(uploadVoiceLog("mic_failed")).resolves.toBe("sent");
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    vi.advanceTimersByTime(UPLOAD_MIN_GAP_MS);
    await expect(uploadVoiceLog("voice_end")).resolves.toBe("failed");
    await expect(uploadVoiceLog("voice_end")).resolves.toBe("sent");
  });

  it("holds a second automatic upload while the first is still on its way", async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((res) => {
          release = res;
        }),
    );
    const first = uploadVoiceLog("mic_failed");
    await expect(uploadVoiceLog("mic_deaf")).resolves.toBe("throttled");
    release(new Response("{}", { status: 200 }));
    await expect(first).resolves.toBe("sent");
  });

  it("sends only the last two minutes", async () => {
    logVoice("ancient");
    vi.advanceTimersByTime(121_000);
    logVoice("recent");
    await uploadVoiceLog("manual");
    const events = lastBody().body.lines.map((l: { event: string }) => l.event);
    expect(events).toEqual(["client", "recent"]);
  });

  it("never throws: a rejected fetch and a refused answer both come back failed", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    await expect(uploadVoiceLog("mic_failed")).resolves.toBe("failed");
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("{}", { status: 429 })));
    await expect(uploadVoiceLog("mic_deaf")).resolves.toBe("failed");
    fetchMock.mockImplementationOnce(() => {
      throw new Error("sync throw");
    });
    await expect(uploadVoiceLog("mic_paused")).resolves.toBe("failed");
  });

  it("keeps the request under 60 KB by dropping the oldest events, and the line cap", async () => {
    for (let i = 0; i < 400; i += 1) logVoice("e".repeat(90), "d".repeat(200));
    await uploadVoiceLog("manual");
    const { init, body } = lastBody();
    expect(new TextEncoder().encode(String(init.body)).length).toBeLessThanOrEqual(60_000);
    expect(body.lines.length).toBeLessThanOrEqual(500);
    expect(body.lines[0].event).toBe("client");
    for (const line of body.lines) {
      expect(line.event.length).toBeLessThanOrEqual(64);
      expect((line.detail ?? "").length).toBeLessThanOrEqual(300);
    }
  });

  it("measures bytes, not characters, so emoji and non-ASCII entries stay under the cap", async () => {
    for (let i = 0; i < 300; i += 1) logVoice("\u{1F3A4}".repeat(16), "\u00e9\u{1F600}".repeat(40));
    await uploadVoiceLog("manual");
    const { init } = lastBody();
    const text = String(init.body);
    expect(text.length).toBeLessThan(new TextEncoder().encode(text).length);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(60_000);
  });
});

describe("uploadVoiceLog on a phone", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(showToast).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  const lastInit = () => fetchMock.mock.calls.at(-1)?.[1] as RequestInit;

  it("an in-page upload is a plain request: no keepalive, with an abort signal", async () => {
    for (const reason of ["voice_end", "mic_failed", "mic_deaf", "mic_stalled", "manual"] as const) {
      resetVoiceLog();
      // oxlint-disable-next-line no-await-in-loop -- one reason per upload
      await uploadVoiceLog(reason);
      expect(lastInit().keepalive).toBeUndefined();
      expect(lastInit().signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("keepalive is only used when the caller says the page is going away", async () => {
    await uploadVoiceLog("mic_paused", null, { keepalive: true });
    expect(lastInit().keepalive).toBe(true);
  });

  it("a rejected keepalive request is retried once without keepalive", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("dropped")));
    await expect(uploadVoiceLog("mic_paused", null, { keepalive: true })).resolves.toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
    expect(fetchMock.mock.calls[1][1].keepalive).toBeUndefined();
    expect(formatVoiceLog()).toContain("keepalive rejected, retry");
  });

  it("a timed-out keepalive request is not retried", async () => {
    fetchMock.mockImplementationOnce(() => {
      const e = new Error("aborted");
      e.name = "AbortError";
      return Promise.reject(e);
    });
    await expect(uploadVoiceLog("page_hidden", null, { keepalive: true })).resolves.toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a rejected keepalive request is not retried once the page is hidden", async () => {
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("dropped")));
      await expect(uploadVoiceLog("page_hidden", null, { keepalive: true })).resolves.toBe(
        "failed",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("page_hidden uploads keep their own budget, apart from the automatic one", async () => {
    await expect(uploadVoiceLog("mic_failed")).resolves.toBe("sent");
    await expect(uploadVoiceLog("page_hidden", null, { keepalive: true })).resolves.toBe("sent");
    await expect(uploadVoiceLog("page_hidden", null, { keepalive: true })).resolves.toBe(
      "throttled",
    );
    await expect(uploadVoiceLog("mic_deaf")).resolves.toBe("throttled");
    vi.advanceTimersByTime(UPLOAD_MIN_GAP_MS);
    await expect(uploadVoiceLog("page_hidden", null, { keepalive: true })).resolves.toBe("sent");
    expect(fetchMock.mock.calls.at(-1)?.[1].body).toContain('"reason":"page_hidden"');
  });

  it("a request that never answers is aborted after 10 s and the auto budget is released", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            rej(e);
          });
        }),
    );
    const first = uploadVoiceLog("mic_failed");
    await expect(uploadVoiceLog("mic_deaf")).resolves.toBe("throttled");
    await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS);
    await expect(first).resolves.toBe("failed");
    // The slot is free again: the next automatic upload goes.
    await expect(uploadVoiceLog("mic_deaf")).resolves.toBe("sent");
  });

  it("writes every result into the log buffer with the reason and the error name", async () => {
    await uploadVoiceLog("mic_failed");
    await uploadVoiceLog("mic_failed");
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("offline")));
    await uploadVoiceLog("manual");
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("{}", { status: 503 })));
    await uploadVoiceLog("manual");
    const text = formatVoiceLog();
    expect(text).toContain("log upload mic_failed sent ok");
    expect(text).toContain("log upload mic_failed throttled ok");
    expect(text).toContain("log upload manual failed TypeError");
    expect(text).toContain("log upload manual failed http503");
  });

  it("toasts the voice_end result, and nothing for the other reasons", async () => {
    await uploadVoiceLog("voice_end");
    expect(showToast).toHaveBeenLastCalledWith("Voice log sent");
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("offline")));
    vi.advanceTimersByTime(UPLOAD_MIN_GAP_MS);
    await uploadVoiceLog("voice_end");
    expect(showToast).toHaveBeenLastCalledWith("Voice log not sent: network error");
    await uploadVoiceLog("voice_end");
    expect(showToast).toHaveBeenLastCalledWith("Voice log sent");
    // Throttled: the failure upload just sent the log, so there is nothing to report.
    vi.mocked(showToast).mockClear();
    await expect(uploadVoiceLog("voice_end")).resolves.toBe("throttled");
    expect(showToast).not.toHaveBeenCalled();
    vi.mocked(showToast).mockClear();
    await uploadVoiceLog("mic_failed");
    await uploadVoiceLog("manual");
    expect(showToast).not.toHaveBeenCalled();
  });

  it("names a timeout and a server refusal in the voice_end toast", async () => {
    fetchMock.mockImplementationOnce(() => {
      const e = new Error("aborted");
      e.name = "AbortError";
      return Promise.reject(e);
    });
    await uploadVoiceLog("voice_end");
    expect(showToast).toHaveBeenLastCalledWith("Voice log not sent: timed out");
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("{}", { status: 429 })));
    await uploadVoiceLog("voice_end");
    expect(showToast).toHaveBeenLastCalledWith("Voice log not sent: server answered 429");
  });
});

describe("useVoiceLogOnHide", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function hide() {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  }

  it("sends a keepalive upload with the chat id when the page is hidden or closing", async () => {
    const { unmount } = renderHook(() => useVoiceLogOnHide(true, () => "c9"));
    act(() => hide());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(String(init.body)).chat_id).toBe("c9");
    expect(JSON.parse(String(init.body)).reason).toBe("page_hidden");
    unmount();
    act(() => hide());
    window.dispatchEvent(new Event("pagehide"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing while voice is not on, and nothing on a page that is shown again", async () => {
    renderHook(() => useVoiceLogOnHide(false, () => null));
    act(() => hide());
    window.dispatchEvent(new Event("pagehide"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

