import { afterEach, describe, expect, it } from "vitest";
import {
  fastestCloudVoice,
  readVoiceChatVoicePick,
  resolveVoiceChatVoice,
  VOICE_CHAT_VOICE_KEY,
  VOICE_CHAT_VOICE_SAME,
  voiceChatVoiceKey,
  writeVoiceChatVoicePick,
} from "./aeVoiceChatVoice";

const ROCKY = { id: "rocky-xtts", name: "Rocky", provider: "rocky" };
const AVA = { id: "ava", name: "Ava", provider: "azure" };
const ANDREW = { id: "andrew", name: "Andrew", provider: "azure" };
const SPEAK = { kind: "cloud", id: "rocky-xtts" } as const;
const DEVICE = { kind: "device", id: "aria" } as const;

afterEach(() => window.localStorage.clear());

describe("voice chat voice", () => {
  it("defaults to the first non-Rocky cloud voice, whatever the order", () => {
    expect(fastestCloudVoice([ROCKY, AVA, ANDREW])).toBe(AVA);
    expect(resolveVoiceChatVoice(null, [ROCKY, ANDREW, AVA], SPEAK, DEVICE)).toEqual({
      kind: "cloud",
      id: "andrew",
    });
  });

  it("falls back to the device voice when only Rocky or nothing is listed", () => {
    expect(resolveVoiceChatVoice(null, [ROCKY], SPEAK, DEVICE)).toEqual(DEVICE);
    expect(resolveVoiceChatVoice(null, [], SPEAK, DEVICE)).toEqual(DEVICE);
    expect(resolveVoiceChatVoice(null, [], SPEAK, null)).toBeNull();
  });

  it("gives the Speak replies voice for Same as Speak replies", () => {
    expect(resolveVoiceChatVoice(VOICE_CHAT_VOICE_SAME, [ROCKY, AVA], SPEAK, DEVICE)).toBe(SPEAK);
  });

  it("keeps a saved pick, and drops a cloud pick the server no longer lists", () => {
    expect(resolveVoiceChatVoice("cloud:rocky-xtts", [ROCKY, AVA], null, DEVICE)).toEqual(SPEAK);
    expect(resolveVoiceChatVoice("device:x:y", [AVA], null, null)).toEqual({
      kind: "device",
      id: "x:y",
    });
    expect(resolveVoiceChatVoice("cloud:gone", [ROCKY, AVA], SPEAK, DEVICE)).toEqual({
      kind: "cloud",
      id: "ava",
    });
    // A list not loaded yet keeps the saved cloud voice.
    expect(resolveVoiceChatVoice("cloud:ava", [], SPEAK, DEVICE)).toEqual({
      kind: "cloud",
      id: "ava",
    });
  });

  it("persists per device and ignores a junk value", () => {
    expect(readVoiceChatVoicePick()).toBeNull();
    writeVoiceChatVoicePick("cloud:ava");
    expect(readVoiceChatVoicePick()).toBe("cloud:ava");
    writeVoiceChatVoicePick(VOICE_CHAT_VOICE_SAME);
    expect(readVoiceChatVoicePick()).toBe(VOICE_CHAT_VOICE_SAME);
    window.localStorage.setItem(VOICE_CHAT_VOICE_KEY, "junk");
    expect(readVoiceChatVoicePick()).toBeNull();
  });

  it("labels the selected menu row", () => {
    expect(voiceChatVoiceKey(VOICE_CHAT_VOICE_SAME, DEVICE)).toBe("same");
    expect(voiceChatVoiceKey(null, { kind: "cloud", id: "ava" })).toBe("cloud:ava");
    expect(voiceChatVoiceKey(null, null)).toBe("");
  });
});
