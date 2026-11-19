import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertVoiceAudioSession,
  audioSessionType,
  enterVoiceAudioSession,
  leaveVoiceAudioSession,
  resetAudioSessionState,
} from "./aeAudioSession";
import { formatVoiceLog, resetVoiceLog } from "./aeVoiceLog";
import {
  armVoiceForNextChat,
  disarmVoiceForNextChat,
  resetVoiceStore,
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

  it("follows Voice mode on and off, and the new-chat arm", () => {
    setUa(IOS_UA);
    setSession("auto");
    setVoiceOn("c1", true);
    expect(session().type).toBe("play-and-record");
    setVoiceOn("c1", false);
    expect(session().type).toBe("auto");
    armVoiceForNextChat();
    expect(session().type).toBe("play-and-record");
    disarmVoiceForNextChat();
    expect(session().type).toBe("auto");
  });
});
