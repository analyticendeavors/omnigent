// @vitest-environment jsdom
// Voice mode on iPhone and iPad (omnigent-ae): the controller's start uses the server recognizer
// (DictationSession) because Apple's goes deaf after a spoken reply. Manual taps, other browsers
// and the setting turned off keep the browser path. A silent server take restarts once, then
// reports "deaf".
import type { AeMicController } from "@/lib/aeVoiceMode";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CapabilitiesContext } from "@/lib/CapabilitiesContext";
import type { ServerInfo } from "@/lib/capabilities";
import type { DictationSessionEvents, DictationStartOptions } from "@/lib/dictation";
import { resetVoiceLog, formatVoiceLog } from "@/lib/aeVoiceLog";
import { VOICE_SERVER_STT_KEY } from "@/lib/aeVoiceServerStt";
import { ComposerMicButton } from "./ComposerMicButton";

let sessionStartMock: Mock<
  (events: DictationSessionEvents, options?: DictationStartOptions) => Promise<unknown>
>;
let sessionEvents: DictationSessionEvents | null;
let cancelMock: Mock<() => void>;
const getMicStreamMock = vi.fn();

vi.mock("@/lib/dictation", () => ({
  DictationBusyError: class extends Error {},
  DictationSession: {
    start: (events: DictationSessionEvents, options?: DictationStartOptions) =>
      sessionStartMock(events, options),
  },
}));
vi.mock("@/lib/aeAudioDevices", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getMicStream: (...args: unknown[]) => getMicStreamMock(...args),
}));

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAC_SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const INFO = { dictation_available: true } as unknown as ServerInfo;

let startSpy: Mock<() => void>;
let originalUa: PropertyDescriptor | undefined;

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
}

beforeEach(() => {
  startSpy = vi.fn();
  sessionEvents = null;
  cancelMock = vi.fn();
  getMicStreamMock.mockReset();
  getMicStreamMock.mockRejectedValue(new Error("no mic"));
  sessionStartMock = vi.fn(async (events: DictationSessionEvents) => {
    sessionEvents = events;
    return { stop: vi.fn(async () => ""), cancel: cancelMock };
  });
  originalUa = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  class FakeRecognition {
    continuous = false;
    interimResults = false;
    lang = "en-US";
    start = startSpy;
    stop = vi.fn();
    abort = vi.fn();
    addEventListener() {}
    removeEventListener() {}
  }
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  window.localStorage.removeItem(VOICE_SERVER_STT_KEY);
  resetVoiceLog();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.removeItem(VOICE_SERVER_STT_KEY);
  if (originalUa) Object.defineProperty(navigator, "userAgent", originalUa);
  else delete (navigator as { userAgent?: unknown }).userAgent;
});

function setup(info: ServerInfo | "loading" = INFO) {
  const controller = { current: null as AeMicController | null };
  const onListeningChange = vi.fn();
  const view = render(
    <CapabilitiesContext.Provider value={info as ServerInfo}>
      <ComposerMicButton
        onTranscript={vi.fn()}
        controller={controller}
        onListeningChange={onListeningChange}
      />
    </CapabilitiesContext.Provider>,
  );
  return { controller, onListeningChange, view };
}

describe("ComposerMicButton (Voice mode on the server recognizer, iOS)", () => {
  it("sends a Voice controller start on an iPhone to the DictationSession", async () => {
    setUserAgent(IOS_UA);
    const { controller } = setup();
    expect(controller.current?.startPath()).toBe("server");
    await act(async () => controller.current?.start());
    expect(sessionStartMock).toHaveBeenCalledTimes(1);
    expect(sessionStartMock.mock.calls[0][1]).toEqual({ deafCheck: true });
    expect(startSpy).not.toHaveBeenCalled();
    expect(controller.current?.isListening()).toBe(true);
  });

  it("keeps the browser path when the setting is off", async () => {
    setUserAgent(IOS_UA);
    window.localStorage.setItem(VOICE_SERVER_STT_KEY, "off");
    const { controller } = setup();
    expect(controller.current?.startPath()).toBe("browser");
    await act(async () => controller.current?.start());
    expect(sessionStartMock).not.toHaveBeenCalled();
  });

  it("keeps the browser path for a manual mic tap on an iPhone", async () => {
    setUserAgent(IOS_UA);
    setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Voice dictation" }));
    });
    expect(sessionStartMock).not.toHaveBeenCalled();
  });

  it.each([CHROME_UA, MAC_SAFARI_UA])("leaves %s unchanged", async (ua) => {
    setUserAgent(ua);
    const { controller } = setup();
    expect(controller.current?.startPath()).toBe("browser");
    await act(async () => controller.current?.start());
    expect(sessionStartMock).not.toHaveBeenCalled();
  });

  it("never opens a second capture for the meter on a server take", async () => {
    setUserAgent(IOS_UA);
    window.localStorage.setItem("omnigent:ae-voice-meter", "on");
    const { controller } = setup();
    await act(async () => controller.current?.start());
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    expect(getMicStreamMock).not.toHaveBeenCalled();
    window.localStorage.removeItem("omnigent:ae-voice-meter");
  });

  it("restarts a deaf server take once, then reports deaf", async () => {
    setUserAgent(IOS_UA);
    const { controller, onListeningChange } = setup();
    await act(async () => controller.current?.start());
    expect(sessionStartMock).toHaveBeenCalledTimes(1);
    // First hit: a quiet restart (cancel, a fresh session), Voice mode is told nothing.
    await act(async () => sessionEvents?.onDeaf?.("silent"));
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(sessionStartMock).toHaveBeenCalledTimes(2);
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
    expect(formatVoiceLog()).toContain("server deaf restart");
    // Second hit: reported as deaf.
    await act(async () => sessionEvents?.onDeaf?.("silent"));
    expect(sessionStartMock).toHaveBeenCalledTimes(2);
    expect(onListeningChange).toHaveBeenCalledWith(false, "deaf");
    expect(onListeningChange).toHaveBeenCalledTimes(2); // listening(true), then deaf
    expect(formatVoiceLog()).toContain("server deaf");
    expect(controller.current?.isListening()).toBe(false);
  });

  it("routes a Voice start on iOS to the server while serverInfo is loading", async () => {
    setUserAgent(IOS_UA);
    const { controller } = setup("loading");
    expect(controller.current?.startPath()).toBe("server");
    await act(async () => controller.current?.start());
    expect(sessionStartMock).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("keeps the browser path while loading when the setting is off", async () => {
    setUserAgent(IOS_UA);
    window.localStorage.setItem(VOICE_SERVER_STT_KEY, "off");
    const { controller } = setup("loading");
    expect(controller.current?.startPath()).toBe("browser");
  });

  it("resets the deaf restart budget on the next controller start", async () => {
    setUserAgent(IOS_UA);
    const { controller } = setup();
    await act(async () => controller.current?.start());
    await act(async () => sessionEvents?.onDeaf?.("silent"));
    expect(sessionStartMock).toHaveBeenCalledTimes(2);
    await act(async () => sessionEvents?.onDeaf?.("silent"));
    expect(controller.current?.isListening()).toBe(false);
    await act(async () => controller.current?.start());
    expect(sessionStartMock).toHaveBeenCalledTimes(3);
    // The new take gets its quiet restart again.
    await act(async () => sessionEvents?.onDeaf?.("silent"));
    expect(sessionStartMock).toHaveBeenCalledTimes(4);
    expect(formatVoiceLog()).toContain("server deaf restart");
  });

  describe("a quiet deaf restart that is still connecting", () => {
    function slowRestart() {
      let release: () => void = () => {};
      let calls = 0;
      sessionStartMock = vi.fn(async (events: DictationSessionEvents) => {
        sessionEvents = events;
        calls += 1;
        if (calls === 2) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { stop: vi.fn(async () => ""), cancel: cancelMock };
      });
      return () => release();
    }

    it("a stop during the connect drops the stream and ends the take", async () => {
      setUserAgent(IOS_UA);
      const release = slowRestart();
      const { controller, onListeningChange } = setup();
      await act(async () => controller.current?.start());
      await act(async () => {
        void sessionEvents?.onDeaf?.("silent");
      });
      cancelMock.mockClear();
      act(() => controller.current?.stop());
      expect(controller.current?.isListening()).toBe(false);
      await act(async () => release());
      expect(cancelMock).toHaveBeenCalledTimes(1);
      expect(controller.current?.isListening()).toBe(false);
      expect(onListeningChange).toHaveBeenCalledWith(false);
    });

    it("a start right after that stop is not swallowed and keeps the connection", async () => {
      setUserAgent(IOS_UA);
      const release = slowRestart();
      const { controller } = setup();
      await act(async () => controller.current?.start());
      await act(async () => {
        void sessionEvents?.onDeaf?.("silent");
      });
      cancelMock.mockClear();
      act(() => controller.current?.stop());
      act(() => controller.current?.start());
      await act(async () => release());
      expect(cancelMock).not.toHaveBeenCalled();
      expect(controller.current?.isListening()).toBe(true);
    });

    it("a failed restart reports the take ended quietly", async () => {
      setUserAgent(IOS_UA);
      let calls = 0;
      sessionStartMock = vi.fn(async (events: DictationSessionEvents) => {
        sessionEvents = events;
        calls += 1;
        if (calls === 2) throw new Error("ws closed");
        return { stop: vi.fn(async () => ""), cancel: cancelMock };
      });
      const { controller, onListeningChange } = setup();
      await act(async () => controller.current?.start());
      await act(async () => sessionEvents?.onDeaf?.("silent"));
      expect(controller.current?.isListening()).toBe(false);
      expect(onListeningChange).toHaveBeenCalledTimes(2); // listening(true), then the failure
      expect(onListeningChange).toHaveBeenLastCalledWith(false);
    });
  });

  describe("unmounting while a take connects", () => {
    function slowStart(nth: number) {
      let release: () => void = () => {};
      let calls = 0;
      sessionStartMock = vi.fn(async (events: DictationSessionEvents) => {
        sessionEvents = events;
        calls += 1;
        if (calls === nth) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { stop: vi.fn(async () => ""), cancel: cancelMock };
      });
      return () => release();
    }

    it("cancels a first take whose handshake resolves after unmount", async () => {
      setUserAgent(IOS_UA);
      const release = slowStart(1);
      const { controller, view } = setup();
      await act(async () => controller.current?.start());
      view.unmount();
      expect(cancelMock).not.toHaveBeenCalled();
      await act(async () => release());
      expect(cancelMock).toHaveBeenCalledTimes(1);
      expect(formatVoiceLog()).toContain("dictation start after unmount, cancelled");
    });

    it("cancels a quiet deaf restart whose handshake resolves after unmount", async () => {
      setUserAgent(IOS_UA);
      const release = slowStart(2);
      const { controller, view } = setup();
      await act(async () => controller.current?.start());
      await act(async () => {
        void sessionEvents?.onDeaf?.("silent");
      });
      cancelMock.mockClear();
      view.unmount();
      await act(async () => release());
      expect(cancelMock).toHaveBeenCalledTimes(1);
      expect(formatVoiceLog()).toContain("dictation start after unmount, cancelled");
    });
  });
});
