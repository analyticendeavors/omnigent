// Tests for ComposerMicButton — Web Speech API voice dictation plus the
// server-dictation fallback.
//
// Web Speech mode: the button toggles a SpeechRecognition session; final
// transcripts are emitted via onTranscript. It renders nothing when the
// browser has no SpeechRecognition constructor AND the server offers no
// dictation. None of this is e2e-testable (CI has no real mic / Web Speech
// engine), so it's pinned here by stubbing the global SpeechRecognition
// constructor with a fake whose addEventListener captures the handlers the
// test then fires. getUserMedia (used only for the visualizer) is stubbed to
// reject so no AudioContext is constructed in jsdom.
//
// Server mode: when there is no SpeechRecognition constructor but the
// /v1/info capability probe reports dictation_available, the button drives a
// DictationSession instead (mocked here — the real transport needs a mic,
// an AudioWorklet, and a WebSocket; the full loop runs in the Playwright
// e2e test against the server's fake engine).

import type { AeMicController } from "@/lib/aeVoiceMode";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CapabilitiesContext } from "@/lib/CapabilitiesContext";
import type { ServerInfo } from "@/lib/capabilities";
import { DictationBusyError as BusyError, type DictationSessionEvents } from "@/lib/dictation";
import { getMicLevel, resetMicLevel } from "@/lib/aeMicLevel";
import { formatVoiceLog, resetVoiceLog } from "@/lib/aeVoiceLog";
import { getVoiceSnapshot, resetVoiceStore, setVoiceOn } from "@/lib/aeVoiceMode";
import { useAeVoiceMode } from "@/hooks/useAeVoiceMode";
import { ComposerMicButton } from "./ComposerMicButton";

// Controllable DictationSession stand-in for the server-mode tests. The
// factory reads the mutable spies at call time, so each test installs its
// own behavior in beforeEach.
interface SessionStub {
  stop: () => Promise<string>;
  cancel: () => void;
}
let sessionStartMock: Mock<(events: DictationSessionEvents) => Promise<SessionStub>>;
let sessionStopMock: Mock<() => Promise<string>>;
let sessionCancelMock: Mock<() => void>;
let sessionEvents: DictationSessionEvents | null;

vi.mock("@/lib/dictation", () => {
  class DictationBusyError extends Error {}
  return {
    DictationBusyError,
    DictationSession: {
      start: (events: DictationSessionEvents) => sessionStartMock(events),
    },
  };
});

// Spy on the toast so tests can assert a failure is actually surfaced to the
// user, not just tucked into the button tooltip.
const showToastMock = vi.fn();
vi.mock("@/components/ui/toast", () => ({ showToast: (msg: unknown) => showToastMock(msg) }));

function installDictationSession() {
  sessionEvents = null;
  sessionStopMock = vi.fn(async () => "");
  sessionCancelMock = vi.fn();
  sessionStartMock = vi.fn(async (events: DictationSessionEvents) => {
    sessionEvents = events;
    return { stop: sessionStopMock, cancel: sessionCancelMock };
  });
}

/** Captured event handlers keyed by event type, fed by the fake recognition. */
let handlers: Record<string, (event: unknown) => void>;
let startSpy: ReturnType<typeof vi.fn>;
let stopSpy: ReturnType<typeof vi.fn>;
let abortSpy: ReturnType<typeof vi.fn>;
let recognitionLang: string | undefined;
/** Every recognizer the component built, oldest first, each with its own handlers. */
let instances: { handlers: Record<string, (event: unknown) => void> }[];
/** Original navigator.mediaDevices descriptor, restored after each test. */
let originalMediaDevices: PropertyDescriptor | undefined;
/** Original navigator.language descriptor, restored after each test. */
let originalLanguage: PropertyDescriptor | undefined;

function installSpeechRecognition() {
  handlers = {};
  startSpy = vi.fn();
  stopSpy = vi.fn();
  abortSpy = vi.fn();
  recognitionLang = undefined;
  instances = [];
  // A class (not an arrow fn) so `new Ctor()` is constructable — the component
  // does `new Ctor()` in its mount effect.
  class FakeRecognition {
    private language = "en-US";
    get lang() {
      return this.language;
    }
    set lang(value: string) {
      this.language = value;
      recognitionLang = value;
    }
    continuous = false;
    interimResults = false;
    start = startSpy;
    stop = stopSpy;
    abort = abortSpy;
    own: Record<string, (event: unknown) => void> = {};
    constructor() {
      instances.push({ handlers: this.own });
    }
    addEventListener(type: string, handler: (event: unknown) => void) {
      handlers[type] = handler;
      this.own[type] = handler;
    }
    removeEventListener() {}
  }
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
}

/** Build a SpeechRecognition `result` event carrying one final transcript. */
function resultEvent(transcript: string) {
  return {
    resultIndex: 0,
    results: { length: 1, 0: { length: 1, isFinal: true, 0: { transcript } } },
  };
}

beforeEach(() => {
  installSpeechRecognition();
  installDictationSession();
  // The visualizer's getUserMedia is best-effort; reject so no AudioContext
  // (unavailable in jsdom) is ever constructed. Capture the original descriptor
  // first so afterEach can restore it — otherwise this navigator stub leaks.
  originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  originalLanguage = Object.getOwnPropertyDescriptor(navigator, "language");
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockRejectedValue(new Error("no mic")) },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete (navigator as { permissions?: unknown }).permissions;
  // Restore navigator.mediaDevices so the stub never leaks to other test files.
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  }
  if (originalLanguage) {
    Object.defineProperty(navigator, "language", originalLanguage);
  } else {
    delete (navigator as { language?: unknown }).language;
  }
});

describe("ComposerMicButton", () => {
  it("renders nothing when the browser has no SpeechRecognition support", () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    const { container } = render(<ComposerMicButton onTranscript={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders an idle, un-pressed dictation button when supported", () => {
    render(<ComposerMicButton onTranscript={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Voice dictation" });
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("allows a caller to override sizing without changing dictation state classes", () => {
    render(<ComposerMicButton className="size-8 md:size-7" onTranscript={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Voice dictation" });

    expect(button).toHaveClass("size-8", "md:size-7");
    expect(button).not.toHaveClass("size-9", "md:size-8");
    expect(button).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(button);
    act(() => handlers.start?.({}));

    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveClass("bg-muted/60", "focus-visible:text-destructive");
  });

  it("defaults Web Speech to the browser language", () => {
    Object.defineProperty(navigator, "language", { configurable: true, value: "ja-JP" });

    render(<ComposerMicButton onTranscript={vi.fn()} />);

    expect(recognitionLang).toBe("ja-JP");
  });

  it("prefers an explicit language over the browser language", () => {
    Object.defineProperty(navigator, "language", { configurable: true, value: "ja-JP" });

    render(<ComposerMicButton onTranscript={vi.fn()} lang="en-GB" />);

    expect(recognitionLang).toBe("en-GB");
  });

  it("falls back to en-US when the browser language is empty", () => {
    Object.defineProperty(navigator, "language", { configurable: true, value: "" });

    render(<ComposerMicButton onTranscript={vi.fn()} />);

    expect(recognitionLang).toBe("en-US");
  });

  it("starts recognition on click and reflects the recording state", () => {
    render(<ComposerMicButton onTranscript={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Voice dictation" });

    fireEvent.click(button);
    expect(startSpy).toHaveBeenCalledTimes(1);

    // The recognizer's "start" event flips the pressed state.
    act(() => handlers.start?.({}));
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("publishes the mic level while listening and resets it when the mic stops", async () => {
    resetMicLevel();
    const track = { stop: vi.fn() };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }),
        enumerateDevices: vi.fn().mockResolvedValue([]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    class FakeAnalyser {
      fftSize = 0;
      smoothingTimeConstant = 0;
      frequencyBinCount = 32;
      getByteFrequencyData(data: Uint8Array) {
        data.fill(128);
      }
    }
    class FakeAudioContext {
      state = "running";
      createMediaStreamSource() {
        return { connect: vi.fn() };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close = vi.fn();
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    let frame: (() => void) | null = null;
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      frame = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    render(<ComposerMicButton onTranscript={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Voice dictation" }));
    await act(async () => {
      handlers.start?.({});
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => frame?.());
    expect(getMicLevel()).toBeGreaterThan(0.5);
    act(() => handlers.end?.({}));
    expect(getMicLevel()).toBe(0);
  });

  it("exposes start, stop and the listening state to Voice mode", () => {
    const controller = { current: null as AeMicController | null };
    const onListeningChange = vi.fn();
    render(
      <ComposerMicButton
        onTranscript={vi.fn()}
        controller={controller}
        onListeningChange={onListeningChange}
      />,
    );
    expect(controller.current?.isListening()).toBe(false);
    act(() => controller.current?.start());
    expect(startSpy).toHaveBeenCalledTimes(1);
    act(() => handlers.start?.({}));
    expect(controller.current?.isListening()).toBe(true);
    expect(onListeningChange).toHaveBeenLastCalledWith(true);
    act(() => controller.current?.start());
    expect(startSpy).toHaveBeenCalledTimes(1);
    act(() => controller.current?.stop());
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("stops recognition on a second click once recording", () => {
    render(<ComposerMicButton onTranscript={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Voice dictation" });

    fireEvent.click(button);
    act(() => handlers.start?.({}));
    fireEvent.click(button);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("delivers the trimmed final transcript via onTranscript", () => {
    const onTranscript = vi.fn();
    render(<ComposerMicButton onTranscript={onTranscript} />);
    fireEvent.click(screen.getByRole("button", { name: "Voice dictation" }));
    act(() => handlers.start?.({}));

    act(() => handlers.result?.(resultEvent("  hello world  ")));
    expect(onTranscript).toHaveBeenCalledWith("hello world");
  });

  it("does not emit a transcript while the composer is disabled", () => {
    const onTranscript = vi.fn();
    render(<ComposerMicButton onTranscript={onTranscript} disabled />);
    // The button is disabled, but a late recognition result must still be
    // dropped by the disabled guard rather than reaching the callback.
    act(() => handlers.result?.(resultEvent("late words")));
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("surfaces a permission-denied error in the tooltip and a toast", () => {
    render(<ComposerMicButton onTranscript={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Voice dictation" });

    act(() => handlers.error?.({ error: "not-allowed" }));
    const message = "Microphone access denied. Allow access and try again.";
    expect(button).toHaveAttribute("title", message);
    expect(showToastMock).toHaveBeenCalledWith(message);
  });

  it("ignores routine no-speech/aborted errors (no tooltip change, no toast)", () => {
    render(<ComposerMicButton onTranscript={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Voice dictation" });

    act(() => handlers.error?.({ error: "no-speech" }));
    expect(button).toHaveAttribute("title", "Voice dictation");
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("snapshots via onVoiceStart when dictation begins", () => {
    const onVoiceStart = vi.fn();
    render(<ComposerMicButton onTranscript={vi.fn()} onVoiceStart={onVoiceStart} />);
    fireEvent.click(screen.getByRole("button", { name: "Voice dictation" }));

    act(() => handlers.start?.({}));
    expect(onVoiceStart).toHaveBeenCalledTimes(1);
  });

  it("Enter while listening stops dictation and keeps the text (no discard)", () => {
    const onVoiceDiscard = vi.fn();
    render(<ComposerMicButton onTranscript={vi.fn()} onVoiceDiscard={onVoiceDiscard} />);
    fireEvent.click(screen.getByRole("button", { name: "Voice dictation" }));
    act(() => handlers.start?.({}));

    const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(e);
    });

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(onVoiceDiscard).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("Esc while listening stops dictation and discards the text", () => {
    const onVoiceDiscard = vi.fn();
    render(<ComposerMicButton onTranscript={vi.fn()} onVoiceDiscard={onVoiceDiscard} />);
    fireEvent.click(screen.getByRole("button", { name: "Voice dictation" }));
    act(() => handlers.start?.({}));

    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(e);
    });

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(onVoiceDiscard).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("drops a late transcript that arrives after an Esc discard", () => {
    const onTranscript = vi.fn();
    render(<ComposerMicButton onTranscript={onTranscript} onVoiceDiscard={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Voice dictation" }));
    act(() => handlers.start?.({}));

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    // A trailing final result races in before the recognizer's end event.
    act(() => handlers.result?.(resultEvent("trailing words")));

    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("does not intercept Enter/Esc when not listening", () => {
    const onVoiceDiscard = vi.fn();
    render(<ComposerMicButton onTranscript={vi.fn()} onVoiceDiscard={onVoiceDiscard} />);
    // Never started listening.
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(enter);
      window.dispatchEvent(esc);
    });

    expect(stopSpy).not.toHaveBeenCalled();
    expect(onVoiceDiscard).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(false);
    expect(esc.defaultPrevented).toBe(false);
  });
});

/** ServerInfo with dictation on; the other capabilities are irrelevant here. */
const DICTATION_INFO: ServerInfo = {
  accounts_enabled: false,
  single_user: false,
  login_url: null,
  needs_setup: false,
  databricks_features: false,
  managed_sandboxes_enabled: false,
  sandbox_provider: null,
  enabled_connections: [],
  sharing_mode: "on",
  public_sharing_enabled: true,
  server_version: "test",
  smart_routing_enabled: false,
  smart_routing_sources: { external: false, oss: false },
  features: {},
  harness_install_enabled: false,
  installable_harnesses: [],
  dictation_available: true,
};

const NO_DICTATION_INFO: ServerInfo = {
  ...DICTATION_INFO,
  dictation_available: false,
};

function renderServerMode(
  props: Partial<React.ComponentProps<typeof ComposerMicButton>> = {},
  info: ServerInfo = DICTATION_INFO,
) {
  // No SpeechRecognition constructor → the component must pick server mode.
  vi.stubGlobal("SpeechRecognition", undefined);
  vi.stubGlobal("webkitSpeechRecognition", undefined);
  return render(
    <CapabilitiesContext.Provider value={info}>
      <ComposerMicButton onTranscript={vi.fn()} {...props} />
    </CapabilitiesContext.Provider>,
  );
}

async function clickMic() {
  // toggle() kicks off the async DictationSession.start; flush it inside act.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Voice dictation" }));
  });
}

describe("ComposerMicButton (server dictation)", () => {
  it("renders the button when the server advertises dictation", () => {
    renderServerMode();
    expect(screen.getByRole("button", { name: "Voice dictation" })).toBeInTheDocument();
  });

  it("renders nothing when neither Web Speech nor the server can help", () => {
    const { container } = renderServerMode({}, NO_DICTATION_INFO);
    expect(container).toBeEmptyDOMElement();
  });

  it("starts a session on click and reflects the recording state", async () => {
    renderServerMode();
    await clickMic();
    expect(sessionStartMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Voice dictation" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows a connecting state during the handshake, then flips to listening", async () => {
    // Hold the handshake open so the connecting window is observable (the real
    // first take cold-loads the model for up to ~40s).
    let resolveStart!: (s: SessionStub) => void;
    sessionStartMock = vi.fn((events: DictationSessionEvents) => {
      sessionEvents = events;
      return new Promise<SessionStub>((resolve) => {
        resolveStart = resolve;
      });
    });
    renderServerMode();
    const button = screen.getByRole("button", { name: "Voice dictation" });

    await act(async () => {
      fireEvent.click(button);
    });
    // Handshake in flight: busy, not yet pressed (no audio is flowing).
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("title", "Starting voice input…");

    await act(async () => {
      resolveStart({ stop: sessionStopMock, cancel: sessionCancelMock });
    });
    // Ready: the take is live and the spinner is gone.
    expect(button).toHaveAttribute("aria-busy", "false");
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("routes partials to onInterim and finals to onTranscript", async () => {
    const onTranscript = vi.fn();
    const onInterim = vi.fn();
    renderServerMode({ onTranscript, onInterim });
    await clickMic();

    act(() => sessionEvents?.onPartial("hello wor"));
    expect(onInterim).toHaveBeenCalledWith("hello wor");
    expect(onTranscript).not.toHaveBeenCalled();

    act(() => sessionEvents?.onFinal("Hello, world."));
    expect(onTranscript).toHaveBeenCalledWith("Hello, world.");
  });

  it("stop click flushes the tail into onTranscript", async () => {
    const onTranscript = vi.fn();
    sessionStopMock = vi.fn(async () => "tail words");
    renderServerMode({ onTranscript });
    await clickMic();
    await clickMic();

    expect(sessionStopMock).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("tail words");
    expect(screen.getByRole("button", { name: "Voice dictation" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("stop with an empty tail clears the interim region instead", async () => {
    const onTranscript = vi.fn();
    const onInterim = vi.fn();
    renderServerMode({ onTranscript, onInterim });
    await clickMic();
    await clickMic();

    expect(onTranscript).not.toHaveBeenCalled();
    expect(onInterim).toHaveBeenCalledWith("");
  });

  it("surfaces mic permission denial in the tooltip and a toast", async () => {
    sessionStartMock = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    renderServerMode();
    await clickMic();
    const message = "Microphone access denied. Allow access and try again.";
    expect(screen.getByRole("button", { name: "Voice dictation" })).toHaveAttribute(
      "title",
      message,
    );
    expect(showToastMock).toHaveBeenCalledWith(message);
  });

  it("a stop while the start is still connecting never leaves a listening stream", async () => {
    let resolveStart!: (s: SessionStub) => void;
    sessionStartMock = vi.fn((events: DictationSessionEvents) => {
      sessionEvents = events;
      return new Promise<SessionStub>((resolve) => {
        resolveStart = resolve;
      });
    });
    const controller = { current: null as AeMicController | null };
    const onListeningChange = vi.fn();
    renderServerMode({ controller, onListeningChange });
    await act(async () => controller.current?.start());
    await act(async () => controller.current?.start());
    expect(sessionStartMock).toHaveBeenCalledTimes(1);
    act(() => controller.current?.stop());
    await act(async () => {
      resolveStart({ stop: sessionStopMock, cancel: sessionCancelMock });
    });
    expect(sessionCancelMock).toHaveBeenCalledTimes(1);
    expect(controller.current?.isListening()).toBe(false);
    expect(screen.getByRole("button", { name: "Voice dictation" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(onListeningChange).not.toHaveBeenCalledWith(true);
    // A later start works as normal.
    sessionStartMock = vi.fn(async (events: DictationSessionEvents) => {
      sessionEvents = events;
      return { stop: sessionStopMock, cancel: sessionCancelMock };
    });
    await act(async () => controller.current?.start());
    expect(controller.current?.isListening()).toBe(true);
    expect(onListeningChange).toHaveBeenLastCalledWith(true);
  });

  it("tells Voice mode when a start fails, including the server's stream limit", async () => {
    sessionStartMock = vi.fn(async () => {
      throw new BusyError();
    });
    const controller = { current: null as AeMicController | null };
    const onListeningChange = vi.fn();
    renderServerMode({ controller, onListeningChange });
    await act(async () => controller.current?.start());
    expect(onListeningChange).toHaveBeenCalledWith(false);
    expect(controller.current?.isListening()).toBe(false);
    // The request flag is released: a second start is allowed.
    await act(async () => controller.current?.start());
    expect(sessionStartMock).toHaveBeenCalledTimes(2);
  });

  it("a start turned away by a take still finishing is reported, and the next start works", async () => {
    let resolveStart!: (s: SessionStub) => void;
    sessionStartMock = vi.fn((events: DictationSessionEvents) => {
      sessionEvents = events;
      return new Promise<SessionStub>((resolve) => {
        resolveStart = resolve;
      });
    });
    const controller = { current: null as AeMicController | null };
    const onListeningChange = vi.fn();
    renderServerMode({ controller, onListeningChange });
    await act(async () => controller.current?.start());
    act(() => controller.current?.stop());
    // The first take is still connecting, so this start is turned away and reported.
    act(() => controller.current?.start());
    expect(onListeningChange).toHaveBeenCalledWith(false);
    expect(sessionStartMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveStart({ stop: sessionStopMock, cancel: sessionCancelMock });
    });
    expect(sessionCancelMock).toHaveBeenCalledTimes(1);
    sessionStartMock = vi.fn(async (events: DictationSessionEvents) => {
      sessionEvents = events;
      return { stop: sessionStopMock, cancel: sessionCancelMock };
    });
    await act(async () => controller.current?.start());
    expect(controller.current?.isListening()).toBe(true);
  });

  it("a withdraw left by a start that then failed does not cancel the next manual click", async () => {
    let rejectStart!: (e: unknown) => void;
    sessionStartMock = vi.fn(
      () =>
        new Promise<SessionStub>((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    const controller = { current: null as AeMicController | null };
    renderServerMode({ controller });
    await act(async () => controller.current?.start());
    act(() => controller.current?.stop());
    await act(async () => rejectStart(new Error("down")));
    sessionStartMock = vi.fn(async (events: DictationSessionEvents) => {
      sessionEvents = events;
      return { stop: sessionStopMock, cancel: sessionCancelMock };
    });
    await clickMic();
    expect(sessionCancelMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Voice dictation" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("names the server path, and a restart tap never withdraws a server start", async () => {
    let resolveStart!: (s: SessionStub) => void;
    sessionStartMock = vi.fn((events: DictationSessionEvents) => {
      sessionEvents = events;
      return new Promise<SessionStub>((resolve) => {
        resolveStart = resolve;
      });
    });
    const controller = { current: null as AeMicController | null };
    renderServerMode({ controller });
    expect(controller.current?.startPath()).toBe("server");
    await act(async () => controller.current?.start());
    act(() => controller.current?.restart());
    await act(async () => {
      resolveStart({ stop: sessionStopMock, cancel: sessionCancelMock });
    });
    // The healthy cold start finished and is listening; nothing cancelled it.
    expect(sessionCancelMock).not.toHaveBeenCalled();
    expect(sessionStartMock).toHaveBeenCalledTimes(1);
    expect(controller.current?.isListening()).toBe(true);
  });

  it("tells Voice mode when the mic is stopped from the button", async () => {
    const controller = { current: null as AeMicController | null };
    const onListeningChange = vi.fn();
    renderServerMode({ controller, onListeningChange });
    await clickMic();
    expect(onListeningChange).toHaveBeenLastCalledWith(true);
    await clickMic();
    expect(onListeningChange).toHaveBeenLastCalledWith(false);
  });

  it("a mid-take transport error resets state and surfaces the failure", async () => {
    const onInterim = vi.fn();
    renderServerMode({ onInterim });
    await clickMic();

    act(() => sessionEvents?.onError("dictation failed"));
    const button = screen.getByRole("button", { name: "Voice dictation" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("title", "Voice input failed. Please try again.");
    expect(showToastMock).toHaveBeenCalledWith("Voice input failed. Please try again.");
    // No partial was in flight, so the interim region is just cleared.
    expect(onInterim).toHaveBeenCalledWith("");
  });

  it("preserves an in-flight partial when a take crashes", async () => {
    const onTranscript = vi.fn();
    const onInterim = vi.fn();
    renderServerMode({ onTranscript, onInterim });
    await clickMic();

    // The user has spoken; a partial is showing but hasn't finalized.
    act(() => sessionEvents?.onPartial("half a sentence"));
    onInterim.mockClear();

    act(() => sessionEvents?.onError("dictation failed"));
    // The partial is pinned as a final rather than blanked, so the words survive.
    expect(onTranscript).toHaveBeenCalledWith("half a sentence");
    expect(onInterim).not.toHaveBeenCalledWith("");
  });

  it("falls back to server dictation when Web Speech dies with a network error", async () => {
    // Electron / plain Chromium: the SpeechRecognition constructor exists
    // (so Web Speech is picked first) but its cloud backend rejects the
    // build at runtime with "network". The take must fall back to server
    // dictation so the user's click still lands.
    const onInterim = vi.fn();
    render(
      <CapabilitiesContext.Provider value={DICTATION_INFO}>
        <ComposerMicButton onTranscript={vi.fn()} onInterim={onInterim} />
      </CapabilitiesContext.Provider>,
    );
    const button = screen.getByRole("button", { name: "Voice dictation" });

    fireEvent.click(button);
    expect(startSpy).toHaveBeenCalledTimes(1);
    await act(async () => handlers.error?.({ error: "network" }));

    // The take restarted on the server path, with no error tooltip for
    // the silent switch, and partials flow.
    expect(sessionStartMock).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveAttribute("title", "Voice dictation");
    act(() => sessionEvents?.onPartial("via server"));
    expect(onInterim).toHaveBeenCalledWith("via server");

    // Stale events from the dead recognizer must not clobber the live
    // server take's state (Chrome fires "end" after a failed start).
    act(() => handlers.end?.({}));
    expect(button).toHaveAttribute("aria-pressed", "true");

    // The fallback is per take, not sticky: after stopping, the next
    // take tries Web Speech again (a transient Chrome blip must not
    // permanently downgrade the page to the server model).
    await clickMic(); // stop the server take
    await clickMic(); // next take
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(sessionStartMock).toHaveBeenCalledTimes(1);
  });

  it("reports a busy server distinctly from a broken one", async () => {
    const { DictationBusyError } = await import("@/lib/dictation");
    sessionStartMock = vi.fn(async () => {
      throw new DictationBusyError("at capacity");
    });
    renderServerMode();
    await clickMic();
    expect(screen.getByRole("button", { name: "Voice dictation" })).toHaveAttribute(
      "title",
      "Voice input is busy. Please try again shortly.",
    );
  });

  it("keeps the plain error path when the server offers no dictation", async () => {
    render(
      <CapabilitiesContext.Provider value={NO_DICTATION_INFO}>
        <ComposerMicButton onTranscript={vi.fn()} />
      </CapabilitiesContext.Provider>,
    );
    const button = screen.getByRole("button", { name: "Voice dictation" });
    fireEvent.click(button);
    await act(async () => handlers.error?.({ error: "network" }));
    expect(sessionStartMock).not.toHaveBeenCalled();
    expect(button).toHaveAttribute("title", "Voice input isn't available on this device.");
    expect(showToastMock).toHaveBeenCalledWith("Voice input isn't available on this device.");
  });

  it("cancels the session when the composer goes disabled mid-take", async () => {
    const { rerender } = renderServerMode();
    await clickMic();

    rerender(
      <CapabilitiesContext.Provider value={DICTATION_INFO}>
        <ComposerMicButton onTranscript={vi.fn()} disabled />
      </CapabilitiesContext.Provider>,
    );
    expect(sessionCancelMock).toHaveBeenCalledTimes(1);
  });

  it("fires onVoiceStart when a server take begins", async () => {
    const onVoiceStart = vi.fn();
    renderServerMode({ onVoiceStart });
    await clickMic();
    expect(onVoiceStart).toHaveBeenCalledTimes(1);
  });

  it("in Electron goes straight to the server, skipping the doomed Web Speech take", async () => {
    // Electron HAS a SpeechRecognition constructor but no backend: a Web Speech
    // take always fails with "network" and only then falls back, a visible ~1s
    // stall. With the server available the button must skip it entirely.
    (window as unknown as Record<string, unknown>).omnigentDesktop = { kind: "electron" };
    try {
      render(
        <CapabilitiesContext.Provider value={DICTATION_INFO}>
          <ComposerMicButton onTranscript={vi.fn()} />
        </CapabilitiesContext.Provider>,
      );
      await clickMic();

      // Server path taken directly; the Web Speech recognizer never started.
      expect(sessionStartMock).toHaveBeenCalledTimes(1);
      expect(startSpy).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Voice dictation" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    } finally {
      delete (window as unknown as Record<string, unknown>).omnigentDesktop;
    }
  });

  it("Enter while listening ends the server take via stop (keeps the tail)", async () => {
    const onVoiceDiscard = vi.fn();
    sessionStopMock = vi.fn(async () => "tail words");
    renderServerMode({ onVoiceDiscard });
    await clickMic();

    const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(e);
    });

    expect(sessionStopMock).toHaveBeenCalledTimes(1);
    expect(sessionCancelMock).not.toHaveBeenCalled();
    expect(onVoiceDiscard).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("Esc while listening cancels the server take and discards, dropping late results", async () => {
    const onTranscript = vi.fn();
    const onInterim = vi.fn();
    const onVoiceDiscard = vi.fn();
    renderServerMode({ onTranscript, onInterim, onVoiceDiscard });
    await clickMic();

    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(e);
    });

    expect(sessionCancelMock).toHaveBeenCalledTimes(1);
    expect(sessionStopMock).not.toHaveBeenCalled();
    expect(onVoiceDiscard).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);

    // A partial/final racing in after the cancel must not repopulate the
    // composer the parent just reverted.
    onInterim.mockClear();
    onTranscript.mockClear();
    act(() => {
      sessionEvents?.onPartial("late partial");
      sessionEvents?.onFinal("late final");
    });
    expect(onInterim).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });
});

describe("ComposerMicButton (Voice mode start recovery)", () => {
  function mountWithController() {
    const controller = { current: null as AeMicController | null };
    const onListeningChange = vi.fn();
    render(
      <ComposerMicButton
        onTranscript={vi.fn()}
        controller={controller}
        onListeningChange={onListeningChange}
      />,
    );
    return { controller, onListeningChange };
  }

  it("an end with no start reports a failed start at once and lets the next start run", () => {
    const { controller, onListeningChange } = mountWithController();
    act(() => controller.current?.start());
    expect(startSpy).toHaveBeenCalledTimes(1);
    act(() => handlers.end?.({}));
    expect(onListeningChange).toHaveBeenLastCalledWith(false);
    act(() => controller.current?.start());
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("a start that fires no event trips the 8 s first-take watchdog and frees the guards", async () => {
    vi.useFakeTimers();
    try {
      stubPermission("granted");
      const { controller, onListeningChange } = mountWithController();
      act(() => controller.current?.start());
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => {
        vi.advanceTimersByTime(7900);
      });
      expect(onListeningChange).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(onListeningChange).toHaveBeenLastCalledWith(false);
      // transitionRef and requestedRef are free: a retry reaches recognition.start() again.
      act(() => controller.current?.start());
      expect(startSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a start event cancels the watchdog", () => {
    vi.useFakeTimers();
    try {
      const { controller, onListeningChange } = mountWithController();
      act(() => controller.current?.start());
      act(() => handlers.start?.({}));
      // A live mic reports its audio at once; a take without it is the liveness watchdog's.
      act(() => handlers.audiostart?.({}));
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(abortSpy).not.toHaveBeenCalled();
      expect(onListeningChange).toHaveBeenLastCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restart discards the old recognizer and starts a new one in the same tick", () => {
    const { controller } = mountWithController();
    act(() => controller.current?.start());
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);
    act(() => controller.current?.restart());
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(2);
    expect(startSpy).toHaveBeenCalledTimes(2);
    // The new recognizer's start is answered normally.
    act(() => instances[1].handlers.start?.({}));
    expect(controller.current?.isListening()).toBe(true);
  });

  it("stale end and error events from a discarded recognizer change nothing", async () => {
    vi.useFakeTimers();
    try {
      stubPermission("granted");
      const { controller, onListeningChange } = mountWithController();
      act(() => controller.current?.start());
      act(() => controller.current?.restart());
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      onListeningChange.mockClear();
      // The aborted take's own end and error(aborted) arrive after the new start.
      act(() => {
        instances[0].handlers.end?.({});
        instances[0].handlers.error?.({ error: "aborted" });
      });
      expect(onListeningChange).not.toHaveBeenCalled();
      // The new take's watchdog is still armed and still fires.
      act(() => {
        vi.advanceTimersByTime(8100);
      });
      expect(onListeningChange.mock.calls).toEqual([[false]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stuck take reports not listening once, and the retry uses a fresh recognizer", async () => {
    vi.useFakeTimers();
    try {
      stubPermission("granted");
      const { controller, onListeningChange } = mountWithController();
      act(() => controller.current?.start());
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => {
        vi.advanceTimersByTime(8100);
      });
      expect(onListeningChange.mock.calls.filter(([v]) => v === false)).toHaveLength(1);
      // The aborted recognizer's late error does not report a second false.
      act(() => instances[0].handlers.error?.({ error: "aborted" }));
      expect(onListeningChange.mock.calls.filter(([v]) => v === false)).toHaveLength(1);
      expect(instances).toHaveLength(2);
      act(() => controller.current?.start());
      expect(startSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an error during a start that was waiting reports one false", () => {
    const { controller, onListeningChange } = mountWithController();
    act(() => controller.current?.start());
    act(() => instances[0].handlers.error?.({ error: "audio-capture" }));
    act(() => instances[0].handlers.end?.({}));
    expect(onListeningChange.mock.calls.filter(([v]) => v === false)).toHaveLength(1);
  });

  it("no watchdog while the mic permission is not granted", async () => {
    vi.useFakeTimers();
    try {
      stubPermission("prompt");
      const { controller, onListeningChange } = mountWithController();
      act(() => controller.current?.start());
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        vi.advanceTimersByTime(30_000);
      });
      expect(onListeningChange).not.toHaveBeenCalled();
      expect(abortSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unsupported permission query counts as not granted on the first take", () => {
    vi.useFakeTimers();
    try {
      const { controller, onListeningChange } = mountWithController();
      act(() => controller.current?.start());
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(onListeningChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the first take waits 8 s, a restart after a reply 4 s", async () => {
    vi.useFakeTimers();
    try {
      stubPermission("granted");
      const { controller, onListeningChange } = mountWithController();
      act(() => controller.current?.start());
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => {
        vi.advanceTimersByTime(7900);
      });
      expect(onListeningChange).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(onListeningChange).toHaveBeenLastCalledWith(false);
      // A take has now started on this page: later starts get the short window.
      act(() => controller.current?.start());
      act(() => instances[1].handlers.start?.({}));
      act(() => instances[1].handlers.end?.({}));
      onListeningChange.mockClear();
      act(() => controller.current?.start());
      act(() => {
        vi.advanceTimersByTime(3900);
      });
      expect(onListeningChange).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(onListeningChange).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the controller names the browser path, and the server path in server mode", () => {
    const { controller } = mountWithController();
    expect(controller.current?.startPath()).toBe("browser");
  });
});

function stubPermission(state: string) {
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: vi.fn().mockResolvedValue({ state, addEventListener: vi.fn() }) },
  });
}

describe("ComposerMicButton (level meter)", () => {
  type Listener = () => void;
  let ctxs: FakeCtx[];
  let streams: FakeStream[];
  class FakeTrack {
    listeners: Record<string, Listener> = {};
    muted = false;
    stop = vi.fn();
    addEventListener(type: string, cb: Listener) {
      this.listeners[type] = cb;
    }
  }
  class FakeStream {
    track = new FakeTrack();
    getTracks() {
      return [this.track];
    }
  }
  class FakeCtx {
    state = "suspended";
    listeners: Record<string, Listener> = {};
    resume = vi.fn(() => Promise.resolve());
    close = vi.fn();
    constructor() {
      ctxs.push(this);
    }
    addEventListener(type: string, cb: Listener) {
      this.listeners[type] = cb;
    }
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() };
    }
    createAnalyser() {
      return {
        fftSize: 0,
        smoothingTimeConstant: 0,
        frequencyBinCount: 32,
        getByteFrequencyData: vi.fn(),
      };
    }
  }

  async function listen() {
    ctxs = [];
    streams = [];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(() => {
          const stream = new FakeStream();
          streams.push(stream);
          return Promise.resolve(stream);
        }),
        enumerateDevices: vi.fn().mockResolvedValue([]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    vi.stubGlobal("AudioContext", FakeCtx);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    render(<ComposerMicButton onTranscript={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Voice dictation" }));
    await act(async () => {
      handlers.start?.({});
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }

  it("resumes a context that starts suspended", async () => {
    await listen();
    expect(ctxs[0].resume).toHaveBeenCalled();
  });

  it("resumes again when the context turns suspended or interrupted", async () => {
    await listen();
    const before = ctxs[0].resume.mock.calls.length;
    ctxs[0].state = "suspended";
    act(() => ctxs[0].listeners.statechange?.());
    expect(ctxs[0].resume.mock.calls.length).toBe(before + 1);
    ctxs[0].state = "interrupted";
    act(() => ctxs[0].listeners.statechange?.());
    expect(ctxs[0].resume.mock.calls.length).toBe(before + 2);
    ctxs[0].state = "running";
    act(() => ctxs[0].listeners.statechange?.());
    expect(ctxs[0].resume.mock.calls.length).toBe(before + 2);
  });

  it("takes a fresh stream when the track ends", async () => {
    await listen();
    expect(streams).toHaveLength(1);
    await act(async () => {
      streams[0].track.listeners.ended?.();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    expect(streams[0].track.stop).toHaveBeenCalled();
    expect(streams).toHaveLength(2);
  });

  async function endLatest() {
    await act(async () => {
      streams[streams.length - 1].track.listeners.ended?.();
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  async function endRepeatedly(times: number, thenLiveMs = 0): Promise<void> {
    if (times === 0) return;
    await endLatest();
    if (thenLiveMs) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(thenLiveMs);
      });
    }
    await endRepeatedly(times - 1, thenLiveMs);
  }

  it("stops reacquiring after three quick track ends", async () => {
    await listen();
    vi.useFakeTimers();
    try {
      await endRepeatedly(3);
      expect(streams).toHaveLength(4);
      // The budget is spent: a fourth end is not followed by a new stream.
      await endLatest();
      expect(streams).toHaveLength(4);
      const gum = navigator.mediaDevices.getUserMedia as Mock;
      expect(gum).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the count resets once a reacquired track has been live 30 s", async () => {
    await listen();
    vi.useFakeTimers();
    try {
      await endRepeatedly(3, 31_000);
      await endLatest();
      expect(streams).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed reacquire is retried once after a second", async () => {
    await listen();
    vi.useFakeTimers();
    try {
      const gum = navigator.mediaDevices.getUserMedia as Mock;
      gum.mockRejectedValueOnce(new DOMException("busy", "NotReadableError"));
      await endLatest();
      expect(streams).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(streams).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("Voice mode liveness", () => {
    let frames: (() => void)[];

    async function listenVoice() {
      ctxs = [];
      streams = [];
      frames = [];
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: vi.fn(() => {
            const stream = new FakeStream();
            streams.push(stream);
            return Promise.resolve(stream);
          }),
          enumerateDevices: vi.fn().mockResolvedValue([]),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      });
      vi.stubGlobal("AudioContext", FakeCtx);
      vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
        frames.push(cb);
        return frames.length;
      });
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      resetVoiceLog();
      const controller = { current: null as AeMicController | null };
      const onListeningChange = vi.fn();
      render(
        <ComposerMicButton
          onTranscript={vi.fn()}
          controller={controller}
          onListeningChange={onListeningChange}
        />,
      );
      act(() => controller.current?.start());
      await act(async () => {
        handlers.start?.({});
        handlers.audiostart?.({});
        await vi.advanceTimersByTimeAsync(0);
      });
      // A healthy context; the tests spoil one thing at a time.
      ctxs[0].state = "running";
      act(() => ctxs[0].listeners.statechange?.());
      return { controller, onListeningChange };
    }

    /** Runs the meter's frames once a second for `seconds`, as a visible tab would. */
    async function runFrames(seconds: number) {
      for (let i = 0; i < seconds; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
          const run = frames.splice(0);
          for (const cb of run) cb();
        });
      }
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      // Unmount while the animation-frame stubs are still installed.
      cleanup();
      vi.useRealTimers();
    });

    it("a meter track that stays muted makes the take deaf and is reported as such", async () => {
      const { controller, onListeningChange } = await listenVoice();
      streams[0].track.muted = true;
      act(() => streams[0].track.listeners.mute?.());
      await runFrames(1);
      expect(onListeningChange).not.toHaveBeenLastCalledWith(false, "deaf");
      await runFrames(2);
      expect(onListeningChange).toHaveBeenLastCalledWith(false, "deaf");
      expect(onListeningChange.mock.calls.filter((c) => c[0] === false)).toHaveLength(1);
      expect(instances).toHaveLength(2);
      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(controller.current?.isListening()).toBe(false);
      const log = formatVoiceLog();
      expect(log).toContain("meter track mute");
      expect(log).toContain("mic deaf track muted");
    });

    it("a mute that ends in time is forgiven", async () => {
      const { onListeningChange } = await listenVoice();
      act(() => streams[0].track.listeners.mute?.());
      await runFrames(1);
      act(() => streams[0].track.listeners.unmute?.());
      await runFrames(5);
      expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
      expect(formatVoiceLog()).toContain("meter track unmute");
    });

    it("a context that stays suspended for 6 s makes the take deaf", async () => {
      const { onListeningChange } = await listenVoice();
      ctxs[0].state = "suspended";
      act(() => ctxs[0].listeners.statechange?.());
      await runFrames(5);
      expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
      await runFrames(2);
      expect(onListeningChange).toHaveBeenLastCalledWith(false, "deaf");
      expect(formatVoiceLog()).toContain("mic deaf context not running");
    });

    it("an analyser that reads all zeros for 6 s makes the take deaf", async () => {
      const { onListeningChange } = await listenVoice();
      await runFrames(5);
      expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
      await runFrames(3);
      expect(onListeningChange).toHaveBeenLastCalledWith(false, "deaf");
      expect(formatVoiceLog()).toContain("mic deaf analyser silent");
    });

    it("sound the recognizer itself heard means the mic works, whatever the meter reads", async () => {
      const { onListeningChange } = await listenVoice();
      act(() => handlers.soundstart?.({}));
      await runFrames(10);
      expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
    });
  });
});

describe("ComposerMicButton (stop and liveness watchdogs)", () => {
  function mountVoice() {
    const controller = { current: null as AeMicController | null };
    const onListeningChange = vi.fn();
    render(
      <ComposerMicButton
        onTranscript={vi.fn()}
        controller={controller}
        onListeningChange={onListeningChange}
      />,
    );
    return { controller, onListeningChange };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    resetVoiceLog();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a stop that gets no end replaces the recognizer, frees the guard and reports not listening", () => {
    const { controller, onListeningChange } = mountVoice();
    act(() => controller.current?.start());
    act(() => handlers.start?.({}));
    act(() => handlers.audiostart?.({}));
    expect(controller.current?.isListening()).toBe(true);
    act(() => controller.current?.stop());
    expect(stopSpy).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(1499));
    expect(abortSpy).not.toHaveBeenCalled();
    expect(controller.current?.isListening()).toBe(true);
    act(() => void vi.advanceTimersByTime(1));
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(2);
    expect(controller.current?.isListening()).toBe(false);
    expect(onListeningChange).toHaveBeenLastCalledWith(false);
    expect(formatVoiceLog()).toContain("mic stop watchdog");
    // The guard is free: the next start reaches recognition.start() on the new recognizer.
    act(() => controller.current?.start());
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("a stop answered by end in time leaves the recognizer alone", () => {
    const { controller } = mountVoice();
    act(() => controller.current?.start());
    act(() => handlers.start?.({}));
    act(() => handlers.audiostart?.({}));
    act(() => controller.current?.stop());
    act(() => handlers.end?.({}));
    act(() => void vi.advanceTimersByTime(5000));
    expect(abortSpy).not.toHaveBeenCalled();
    expect(instances).toHaveLength(1);
    expect(formatVoiceLog()).toContain("mic stop");
  });

  it("logs a stop the transition guard turned away", () => {
    const { controller } = mountVoice();
    act(() => controller.current?.start());
    act(() => handlers.start?.({}));
    act(() => controller.current?.stop());
    act(() => controller.current?.stop());
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(formatVoiceLog()).toContain("mic stop refused");
  });

  it("a take with no audiostart for 3 s is deaf: replaced and reported once", () => {
    const { controller, onListeningChange } = mountVoice();
    act(() => controller.current?.start());
    act(() => handlers.start?.({}));
    act(() => void vi.advanceTimersByTime(2999));
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
    act(() => void vi.advanceTimersByTime(500));
    expect(onListeningChange.mock.calls.filter((c) => c[0] === false)).toEqual([[false, "deaf"]]);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(2);
    expect(controller.current?.isListening()).toBe(false);
    expect(formatVoiceLog()).toContain("mic deaf no audiostart");
    // The retry starts cleanly on the new recognizer.
    act(() => controller.current?.start());
    expect(startSpy).toHaveBeenCalledTimes(2);
    act(() => instances[1].handlers.start?.({}));
    expect(controller.current?.isListening()).toBe(true);
  });

  it("an audiostart inside the window keeps the take", () => {
    const { controller, onListeningChange } = mountVoice();
    act(() => controller.current?.start());
    act(() => handlers.start?.({}));
    act(() => void vi.advanceTimersByTime(1000));
    act(() => handlers.audiostart?.({}));
    act(() => void vi.advanceTimersByTime(20_000));
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it("a hand-started take (not Voice mode) is never replaced for being quiet", () => {
    render(<ComposerMicButton onTranscript={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Voice dictation" }));
    act(() => handlers.start?.({}));
    act(() => void vi.advanceTimersByTime(20_000));
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it("does not arm liveness while the mic permission is not granted", async () => {
    stubPermission("prompt");
    const { controller, onListeningChange } = mountVoice();
    act(() => controller.current?.start());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => handlers.start?.({}));
    act(() => void vi.advanceTimersByTime(20_000));
    expect(onListeningChange).not.toHaveBeenCalledWith(false, "deaf");
    expect(formatVoiceLog()).toContain("mic liveness skipped");
  });

  it("restart while listening forces a new recognizer instead of returning early", () => {
    const { controller, onListeningChange } = mountVoice();
    act(() => controller.current?.start());
    act(() => handlers.start?.({}));
    act(() => handlers.audiostart?.({}));
    expect(controller.current?.isListening()).toBe(true);
    onListeningChange.mockClear();
    act(() => controller.current?.restart());
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(2);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(controller.current?.isListening()).toBe(false);
    // Voice mode asked for this itself: it hears no stop in between.
    expect(onListeningChange).not.toHaveBeenCalledWith(false);
    act(() => instances[1].handlers.start?.({}));
    expect(controller.current?.isListening()).toBe(true);
    expect(onListeningChange).toHaveBeenLastCalledWith(true);
  });

  it("events from the replaced recognizer change nothing, audiostart included", () => {
    const { controller, onListeningChange } = mountVoice();
    act(() => controller.current?.start());
    act(() => handlers.start?.({}));
    act(() => controller.current?.restart());
    act(() => instances[1].handlers.start?.({}));
    onListeningChange.mockClear();
    act(() => {
      instances[0].handlers.audiostart?.({});
      instances[0].handlers.soundstart?.({});
      instances[0].handlers.end?.({});
      instances[0].handlers.error?.({ error: "aborted" });
    });
    expect(onListeningChange).not.toHaveBeenCalled();
    expect(controller.current?.isListening()).toBe(true);
    // The old take's audiostart did not count for the new one: it is deaf at 3 s.
    act(() => void vi.advanceTimersByTime(3500));
    expect(onListeningChange).toHaveBeenLastCalledWith(false, "deaf");
  });

  it("deaf twice in a row leaves Voice mode on the restartable unavailable phase", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("{}", { status: 200 }))),
    );
    resetVoiceStore();
    function Harness() {
      const controller = useRef<AeMicController | null>(null);
      const voice = useAeVoiceMode({
        chatId: "c1",
        controller,
        status: "idle",
        value: "",
        submit: vi.fn(),
        canSend: true,
      });
      return (
        <>
          <span data-testid="detail">{voice.micDetail ?? ""}</span>
          <ComposerMicButton
            onTranscript={vi.fn()}
            controller={controller}
            onListeningChange={voice.onListening}
          />
        </>
      );
    }
    act(() => setVoiceOn("c1", true));
    render(<Harness />);
    expect(startSpy).toHaveBeenCalledTimes(1);
    act(() => handlers.start?.({}));
    expect(getVoiceSnapshot("c1").phase).toBe("listening");
    // First deaf take: the phase leaves listening and the mic is started again after 1 s.
    act(() => void vi.advanceTimersByTime(3500));
    expect(getVoiceSnapshot("c1").phase).not.toBe("listening");
    expect(getVoiceSnapshot("c1").phase).not.toBe("unavailable");
    act(() => void vi.advanceTimersByTime(1000));
    expect(startSpy).toHaveBeenCalledTimes(2);
    act(() => instances[instances.length - 1].handlers.start?.({}));
    expect(getVoiceSnapshot("c1").phase).toBe("listening");
    // Second deaf take: no third try, the panel gets the restartable phase and a reason.
    act(() => void vi.advanceTimersByTime(3500));
    expect(getVoiceSnapshot("c1").phase).toBe("unavailable");
    expect(screen.getByTestId("detail").textContent).toBe("Mic went quiet, tap to restart");
    act(() => void vi.advanceTimersByTime(5000));
    expect(startSpy).toHaveBeenCalledTimes(2);
  });
});
