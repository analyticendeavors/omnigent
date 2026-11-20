import { afterEach, describe, expect, it } from "vitest";
import {
  isComposerKeyTarget,
  overlayIsOpen,
  voiceKeyAction,
  type VoiceKeyContext,
} from "./aeVoiceKeys";

const base: VoiceKeyContext = {
  voiceOn: true,
  sheet: false,
  phase: "listening",
  busy: false,
  overlayOpen: false,
  targetOk: true,
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

  it("Esc and Enter do nothing while the chat is working or a menu or the /btw overlay is open", () => {
    expect(voiceKeyAction(key("Escape"), { ...base, busy: true })).toBeNull();
    expect(voiceKeyAction(key("Enter"), { ...base, busy: true })).toBeNull();
  });

  it("neither key acts from a button, link, other input or editor", () => {
    expect(voiceKeyAction(key("Escape"), { ...base, targetOk: false })).toBeNull();
    expect(voiceKeyAction(key("Enter"), { ...base, targetOk: false })).toBeNull();
  });

  it("Esc does nothing with a dialog, menu or listbox open", () => {
    expect(voiceKeyAction(key("Escape"), { ...base, overlayOpen: true })).toBeNull();
    expect(voiceKeyAction(key("Enter"), { ...base, overlayOpen: true })).toBeNull();
    expect(overlayIsOpen()).toBe(false);
    document.body.innerHTML = '<div role="dialog"></div>';
    expect(overlayIsOpen()).toBe(true);
  });

  it("a closed or hidden overlay does not count", () => {
    document.body.innerHTML =
      '<div role="menu" data-state="closed"></div><div aria-hidden="true"><div role="listbox"></div></div>';
    expect(overlayIsOpen()).toBe(false);
  });

  it("only the composer text box or the page itself is a key target", () => {
    const composer = document.createElement("textarea");
    const button = document.createElement("button");
    const term = document.createElement("div");
    term.className = "xterm";
    const editable = document.createElement("div");
    document.body.append(composer, button, term, editable);
    expect(isComposerKeyTarget(composer, composer)).toBe(true);
    expect(isComposerKeyTarget(document.body, composer)).toBe(true);
    expect(isComposerKeyTarget(null, composer)).toBe(true);
    expect(isComposerKeyTarget(button, composer)).toBe(false);
    expect(isComposerKeyTarget(term, composer)).toBe(false);
    expect(isComposerKeyTarget(editable, composer)).toBe(false);
    expect(isComposerKeyTarget(document.createElement("textarea"), composer)).toBe(false);
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
