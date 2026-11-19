import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertVoiceAudioSession,
  audioSessionType,
  enterVoiceAudioSession,
  leaveVoiceAudioSession,
  PENDING_HOLD_MS,
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
