import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AE_DEFAULT_SUGGESTION_KEYS,
  AE_SUGGESTION_KEYS_STORAGE_KEY,
  aeChordLabel,
  aeChordProblem,
  aeSuggestionCycleStep,
  parseAeSuggestionKeys,
  readAeSuggestionKeys,
  writeAeSuggestionKey,
  type AeKeyChord,
} from "./aeSuggestionKeys";

const chord = (code: string, mods: Partial<AeKeyChord> = {}): AeKeyChord => ({
  code,
  alt: false,
  ctrl: false,
  meta: false,
  shift: false,
  ...mods,
});

afterEach(() => {
  vi.restoreAllMocks();
  writeAeSuggestionKey("next", null);
  writeAeSuggestionKey("previous", null);
});

describe("aeChordProblem", () => {
  const keys = AE_DEFAULT_SUGGESTION_KEYS;

  it("blocks the voice dictation combo on every platform", () => {
    expect(aeChordProblem(chord("KeyV", { ctrl: true, alt: true }), "next", keys, false)).toMatch(
      /Already used/,
    );
    expect(aeChordProblem(chord("KeyV", { meta: true, alt: true }), "next", keys, true)).toMatch(
      /Already used/,
    );
  });

  it("blocks the app's other hotkeys and paste", () => {
    for (const taken of [
      chord("KeyK", { ctrl: true }),
      chord("KeyV", { ctrl: true }),
      chord("Digit3", { ctrl: true, alt: true }),
      chord("KeyM", { ctrl: true, shift: true }),
      chord("BracketLeft", { ctrl: true, alt: true }),
      chord("Enter", { alt: true }),
    ]) {
      expect(aeChordProblem(taken, "next", keys, false)).not.toBeNull();
    }
  });

  it("allows free combos, including the platform's other modifier", () => {
    expect(aeChordProblem(chord("KeyJ", { ctrl: true }), "next", keys, false)).toBeNull();
    // Ctrl+K is not the command palette on a Mac (that is ⌘K).
    expect(aeChordProblem(chord("Period", { alt: true }), "next", keys, true)).toBeNull();
    expect(aeChordProblem(chord("KeyV", { ctrl: true, alt: true }), "next", keys, true)).toBeNull();
  });
});

describe("saved keys", () => {
  it("a reset that would collide puts the other action back too", () => {
    writeAeSuggestionKey("next", chord("KeyJ", { ctrl: true }));
    writeAeSuggestionKey("previous", chord("BracketRight", { alt: true }));
    writeAeSuggestionKey("next", null);
    expect(readAeSuggestionKeys()).toEqual(AE_DEFAULT_SUGGESTION_KEYS);
    expect(
      aeSuggestionCycleStep({
        code: "BracketLeft",
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(-1);
  });

  it("holds a change in memory when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    writeAeSuggestionKey("next", chord("KeyJ", { ctrl: true }));
    expect(readAeSuggestionKeys().next.code).toBe("KeyJ");
    window.dispatchEvent(new StorageEvent("storage", { key: AE_SUGGESTION_KEYS_STORAGE_KEY }));
    expect(readAeSuggestionKeys().next.code).toBe("KeyJ");
  });

  it("falls back per action on a damaged value", () => {
    expect(parseAeSuggestionKeys("{nope")).toEqual(AE_DEFAULT_SUGGESTION_KEYS);
    expect(parseAeSuggestionKeys(JSON.stringify({ next: chord("KeyJ", { ctrl: true }) }))).toEqual({
      next: chord("KeyJ", { ctrl: true }),
      previous: AE_DEFAULT_SUGGESTION_KEYS.previous,
    });
  });

  it("labels chords per platform", () => {
    expect(aeChordLabel(AE_DEFAULT_SUGGESTION_KEYS.next, false)).toBe("Alt+]");
    expect(aeChordLabel(AE_DEFAULT_SUGGESTION_KEYS.next, true)).toBe("⌥]");
  });
});
