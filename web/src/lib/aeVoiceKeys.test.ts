import { afterEach, describe, expect, it } from "vitest";
import { overlayIsOpen, voiceKeyAction, type VoiceKeyContext } from "./aeVoiceKeys";

const base: VoiceKeyContext = {
  voiceOn: true,
  sheet: false,
  phase: "listening",
  busy: false,
  overlayOpen: false,
};
const key = (k: string, extra: Record<string, boolean> = {}) => ({
  key: k,
  repeat: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("voiceKeyAction", () => {
  it("Enter sends while listening", () => {
    expect(voiceKeyAction(key("Enter"), base)).toBe("send");
    expect(voiceKeyAction(key("Enter", { shiftKey: true }), base)).toBeNull();
    expect(voiceKeyAction(key("Enter"), { ...base, phase: "speaking" })).toBeNull();
  });

  it.each(["listening", "speaking"] as const)("Esc ends Voice mode while %s", (phase) => {
    expect(voiceKeyAction(key("Escape"), { ...base, phase })).toBe("end");
  });

  it.each(["thinking", "paused", "starting", "unavailable"] as const)(
    "Esc does nothing while %s",
    (phase) => {
      expect(voiceKeyAction(key("Escape"), { ...base, phase })).toBeNull();
    },
  );

  it("Esc does nothing when Voice mode is off (dictation discard stays)", () => {
    expect(voiceKeyAction(key("Escape"), { ...base, voiceOn: false })).toBeNull();
  });

  it("Esc does nothing while the chat is working or a menu or the /btw overlay is open", () => {
    expect(voiceKeyAction(key("Escape"), { ...base, busy: true })).toBeNull();
  });

  it("Esc does nothing with a dialog, menu or listbox open", () => {
    expect(voiceKeyAction(key("Escape"), { ...base, overlayOpen: true })).toBeNull();
    expect(overlayIsOpen()).toBe(false);
    document.body.innerHTML = '<div role="dialog"></div>';
    expect(overlayIsOpen()).toBe(true);
  });

  it("the phone sheet has no key change", () => {
    expect(voiceKeyAction(key("Escape"), { ...base, sheet: true })).toBeNull();
    expect(voiceKeyAction(key("Enter"), { ...base, sheet: true })).toBeNull();
  });

  it("ignores chords, repeats and IME composition", () => {
    expect(voiceKeyAction(key("Escape", { ctrlKey: true }), base)).toBeNull();
    expect(voiceKeyAction(key("Escape", { repeat: true }), base)).toBeNull();
    expect(voiceKeyAction({ ...key("Enter"), isComposing: true }, base)).toBeNull();
  });
});
