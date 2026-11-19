import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertVoiceAudioSession,
  audioSessionType,
  enterVoiceAudioSession,
  leaveVoiceAudioSession,
  markSessionMayBeInactive,
  PENDING_HOLD_MS,
  onLateReactivationStream,
  reactivateAudioSessionForMic,
  reactivationPending,
  REACTIVATE_HARD_CAP_MS,
  REACTIVATE_TIMEOUT_MS,
  resetAudioSessionState,
} from "./aeAudioSession";
import { formatVoiceLog, resetVoiceLog } from "./aeVoiceLog";
import {
  armVoiceForNextChat,
  disarmVoiceForNextChat,
  getVoiceSnapshot,
  resetVoiceStore,
  takeVoiceArm,
  setVoiceOn,
} from "./aeVoiceMode";

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

let originalUa: PropertyDescriptor | undefined;

function setUa(ua: string) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
}
function setSession(type: string | null) {
  if (type === null) delete (navigator as { audioSession?: unknown }).audioSession;
  else
    Object.defineProperty(navigator, "audioSession", {
      configurable: true,
      writable: true,
      value: { type },
    });
}
const session = () => (navigator as unknown as { audioSession: { type: string } }).audioSession;

beforeEach(() => {
  originalUa = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  window.localStorage.clear();
  resetAudioSessionState();
  resetVoiceStore();
  resetVoiceLog();
});
afterEach(() => {
  setSession(null);
  if (originalUa) Object.defineProperty(navigator, "userAgent", originalUa);
  else delete (navigator as { userAgent?: unknown }).userAgent;
});

describe("audio session pinning", () => {
  it("on WebKit sets play-and-record on enter, re-asserts it, and restores on leave", () => {
    setUa(IOS_UA);
    setSession("auto");
    enterVoiceAudioSession();
    expect(session().type).toBe("play-and-record");
    expect(formatVoiceLog()).toContain("audio session play-and-record");
    session().type = "playback";
    assertVoiceAudioSession();
    expect(session().type).toBe("play-and-record");
    expect(audioSessionType()).toBe("play-and-record");
    leaveVoiceAudioSession();
    expect(session().type).toBe("auto");
  });

  it("restores whatever type was there before", () => {
    setUa(IOS_UA);
    setSession("ambient");
    enterVoiceAudioSession();
    leaveVoiceAudioSession();
    expect(session().type).toBe("ambient");
  });

  it("does not re-assert once Voice mode has ended", () => {
    setUa(IOS_UA);
    setSession("auto");
    enterVoiceAudioSession();
    leaveVoiceAudioSession();
    session().type = "playback";
    assertVoiceAudioSession();
    expect(session().type).toBe("playback");
  });

  it("leaves Chrome untouched", () => {
    setUa(CHROME_UA);
    setSession("auto");
    enterVoiceAudioSession();
    assertVoiceAudioSession();
    expect(session().type).toBe("auto");
    expect(audioSessionType()).toBe("none");
  });

  it("is a no-op when navigator.audioSession is missing", () => {
    setUa(IOS_UA);
    setSession(null);
    expect(() => {
      enterVoiceAudioSession();
      assertVoiceAudioSession();
      leaveVoiceAudioSession();
    }).not.toThrow();
    expect(audioSessionType()).toBe("none");
  });

  it("restores only when the last holder leaves (two Voice chats)", () => {
    setUa(IOS_UA);
    setSession("auto");
    enterVoiceAudioSession();
    enterVoiceAudioSession();
    leaveVoiceAudioSession();
    expect(session().type).toBe("play-and-record");
    session().type = "playback";
    assertVoiceAudioSession();
    expect(session().type).toBe("play-and-record");
    leaveVoiceAudioSession();
    expect(session().type).toBe("auto");
  });

  it("setVoiceOn and a plain snapshot read never touch the session", () => {
    setUa(IOS_UA);
    setSession("auto");
    window.localStorage.setItem("ae.voiceMode.c9", "1");
    getVoiceSnapshot("c9");
    getVoiceSnapshot("c1");
    setVoiceOn("c1", true);
    setVoiceOn("c1", false);
    expect(session().type).toBe("auto");
    expect(formatVoiceLog()).not.toContain("audio session");
  });

  it("the arm holds the session; disarm before a chat exists releases it", () => {
    setUa(IOS_UA);
    setSession("auto");
    armVoiceForNextChat();
    expect(session().type).toBe("play-and-record");
    disarmVoiceForNextChat();
    expect(session().type).toBe("auto");
  });

  it("a taken arm keeps its hold through the page's unmount disarm, and expires if unadopted", () => {
    vi.useFakeTimers();
    try {
      setUa(IOS_UA);
      setSession("auto");
      armVoiceForNextChat();
      takeVoiceArm();
      disarmVoiceForNextChat();
      expect(session().type).toBe("play-and-record");
      vi.advanceTimersByTime(PENDING_HOLD_MS + 1);
      expect(session().type).toBe("auto");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reactivating the audio session for the mic", () => {
  class Track {
    stop = vi.fn();
  }
  let tracks: Track[];
  let gum: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    tracks = [];
    gum = vi.fn(() => {
      const t = new Track();
      tracks.push(t);
      return Promise.resolve({ getTracks: () => [t] });
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: gum,
        enumerateDevices: vi.fn().mockResolvedValue([]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  });

  it("does nothing while the flag is clear", async () => {
    setUa(IOS_UA);
    expect(await reactivateAudioSessionForMic()).toBe(false);
    expect(gum).not.toHaveBeenCalled();
  });

  it("does nothing off WebKit even when the flag is set", async () => {
    setUa(CHROME_UA);
    markSessionMayBeInactive();
    expect(reactivationPending()).toBe(false);
    expect(await reactivateAudioSessionForMic()).toBe(false);
    expect(gum).not.toHaveBeenCalled();
  });

  it("opens a mic stream, stops every track, clears the flag and logs", async () => {
    setUa(IOS_UA);
    setSession("play-and-record");
    markSessionMayBeInactive();
    expect(reactivationPending()).toBe(true);
    expect(await reactivateAudioSessionForMic()).toBe(true);
    expect(gum).toHaveBeenCalledTimes(1);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(reactivationPending()).toBe(false);
    expect(formatVoiceLog()).toContain("reactivate ok");
    // Clear flag: a second call does not open another stream.
    await reactivateAudioSessionForMic();
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it("logs the audio session state changes once a reactivation has run", async () => {
    setUa(IOS_UA);
    const listeners: (() => void)[] = [];
    Object.defineProperty(navigator, "audioSession", {
      configurable: true,
      writable: true,
      value: {
        type: "play-and-record",
        state: "inactive",
        addEventListener: (_: string, cb: () => void) => listeners.push(cb),
      },
    });
    markSessionMayBeInactive();
    await reactivateAudioSessionForMic();
    expect(listeners).toHaveLength(1);
    markSessionMayBeInactive();
    await reactivateAudioSessionForMic();
    expect(listeners).toHaveLength(1);
    (navigator as unknown as { audioSession: { state: string } }).audioSession.state = "active";
    listeners[0]();
    expect(formatVoiceLog()).toContain("audio session state active");
  });

  it("keeps a mark set while the reactivation is in flight", async () => {
    setUa(IOS_UA);
    let release: (v: unknown) => void = () => {};
    gum.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    markSessionMayBeInactive();
    const done = reactivateAudioSessionForMic();
    markSessionMayBeInactive();
    release({ getTracks: () => [new Track()] });
    expect(await done).toBe(true);
    expect(reactivationPending()).toBe(true);
  });

  it("keeps waiting past the soft timeout for a stream that settles in time", async () => {
    vi.useFakeTimers();
    setUa(IOS_UA);
    gum.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ getTracks: () => [new Track()] }), 3000);
        }),
    );
    markSessionMayBeInactive();
    let resolved = false;
    const done = reactivateAudioSessionForMic().then((v) => {
      resolved = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(REACTIVATE_TIMEOUT_MS + 100);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await done).toBe(true);
    expect(reactivationPending()).toBe(false);
  });

  it("signals one restart when the stream arrives after the hard cap", async () => {
    vi.useFakeTimers();
    setUa(IOS_UA);
    let release: (v: unknown) => void = () => {};
    const late = new Track();
    gum.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const listener = vi.fn();
    const off = onLateReactivationStream(listener);
    markSessionMayBeInactive();
    const done = reactivateAudioSessionForMic();
    await vi.advanceTimersByTimeAsync(REACTIVATE_HARD_CAP_MS);
    expect(await done).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    release({ getTracks: () => [late] });
    await vi.advanceTimersByTimeAsync(0);
    expect(late.stop).toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(formatVoiceLog()).toContain("reactivate late stream, restarting mic");
    off();
  });

  it("gives up after the timeout, keeps the flag and stops a late stream", async () => {
    vi.useFakeTimers();
    setUa(IOS_UA);
    let release: (v: unknown) => void = () => {};
    const late = new Track();
    gum.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    markSessionMayBeInactive();
    const done = reactivateAudioSessionForMic();
    await vi.advanceTimersByTimeAsync(REACTIVATE_HARD_CAP_MS);
    expect(await done).toBe(false);
    expect(reactivationPending()).toBe(true);
    expect(formatVoiceLog()).toContain("reactivate failed timeout");
    release({ getTracks: () => [late] });
    await vi.advanceTimersByTimeAsync(0);
    expect(late.stop).toHaveBeenCalledTimes(1);
  });

  it("logs a refusal and carries on", async () => {
    setUa(IOS_UA);
    gum.mockRejectedValueOnce(new Error("denied"));
    markSessionMayBeInactive();
    expect(await reactivateAudioSessionForMic()).toBe(false);
    expect(formatVoiceLog()).toContain("reactivate failed denied");
    expect(reactivationPending()).toBe(true);
  });
});
