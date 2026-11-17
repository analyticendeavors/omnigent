// The level meter setting: default by platform, saved choice wins, storage failures fall back.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readVoiceMeter,
  useVoiceMeter,
  VOICE_METER_KEY,
  voiceMeterDefault,
  writeVoiceMeter,
} from "./aeVoiceMeter";

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
let originalUa: PropertyDescriptor | undefined;

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
}

beforeEach(() => {
  originalUa = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  window.localStorage.removeItem(VOICE_METER_KEY);
});
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem(VOICE_METER_KEY);
  if (originalUa) Object.defineProperty(navigator, "userAgent", originalUa);
  else delete (navigator as { userAgent?: unknown }).userAgent;
});

describe("level meter setting", () => {
  it("defaults off on iPhone and WebKit, on elsewhere", () => {
    setUserAgent(IOS_UA);
    expect(voiceMeterDefault()).toBe(false);
    expect(readVoiceMeter()).toBe(false);
    setUserAgent(CHROME_UA);
    expect(voiceMeterDefault()).toBe(true);
    expect(readVoiceMeter()).toBe(true);
  });

  it("a saved choice beats the platform default and persists", () => {
    setUserAgent(IOS_UA);
    writeVoiceMeter(true);
    expect(window.localStorage.getItem(VOICE_METER_KEY)).toBe("on");
    expect(readVoiceMeter()).toBe(true);
    setUserAgent(CHROME_UA);
    writeVoiceMeter(false);
    expect(window.localStorage.getItem(VOICE_METER_KEY)).toBe("off");
    expect(readVoiceMeter()).toBe(false);
  });

  it("an unknown saved value falls back to the default", () => {
    setUserAgent(CHROME_UA);
    window.localStorage.setItem(VOICE_METER_KEY, "maybe");
    expect(readVoiceMeter()).toBe(true);
  });

  it("a storage that throws falls back to the default and never throws on write", () => {
    setUserAgent(IOS_UA);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readVoiceMeter()).toBe(false);
    expect(() => writeVoiceMeter(true)).not.toThrow();
  });

  it("the hook follows a write", () => {
    setUserAgent(CHROME_UA);
    const { result } = renderHook(() => useVoiceMeter());
    expect(result.current).toBe(true);
    act(() => writeVoiceMeter(false));
    expect(result.current).toBe(false);
  });
});
