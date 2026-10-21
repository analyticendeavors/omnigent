// The keys that step through the composer's suggestion alternatives, set in
// Settings > Chat and saved in this browser. Matched on the physical key
// (`event.code`): ⌥ on a Mac turns "[" and "]" into quote characters.

import { useSyncExternalStore } from "react";
import { hasCommandModifier, isMacPlatform } from "@/lib/hotkeys";

export interface AeKeyChord {
  /** `KeyboardEvent.code`, e.g. `"BracketRight"`. */
  code: string;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export type AeSuggestionKeyAction = "next" | "previous";

export type AeSuggestionKeys = Record<AeSuggestionKeyAction, AeKeyChord>;

export const AE_SUGGESTION_KEYS_STORAGE_KEY = "omnigent:ae-suggestion-keys";

const altChord = (code: string): AeKeyChord => ({
  code,
  alt: true,
  ctrl: false,
  meta: false,
  shift: false,
});

/** Alt+] and Alt+[, the keys Copilot uses to cycle its suggestions. */
export const AE_DEFAULT_SUGGESTION_KEYS: AeSuggestionKeys = {
  next: altChord("BracketRight"),
  previous: altChord("BracketLeft"),
};

interface ChordEvent {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const DIGITS = Array.from({ length: 10 }, (_, i) => `Digit${i}`);

const MODIFIER_CODE = /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)/;

/** The chord a keydown makes, or `null` for a modifier pressed on its own. */
export function aeChordFromEvent(event: ChordEvent): AeKeyChord | null {
  if (!event.code || MODIFIER_CODE.test(event.code)) return null;
  return {
    code: event.code,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  };
}

export function aeSameChord(a: AeKeyChord, b: AeKeyChord): boolean {
  return (
    a.code === b.code &&
    a.alt === b.alt &&
    a.ctrl === b.ctrl &&
    a.meta === b.meta &&
    a.shift === b.shift
  );
}

function parseChord(value: unknown): AeKeyChord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== "string" || !v.code) return null;
  const flags = [v.alt, v.ctrl, v.meta, v.shift];
  if (!flags.every((f) => typeof f === "boolean")) return null;
  return {
    code: v.code,
    alt: v.alt as boolean,
    ctrl: v.ctrl as boolean,
    meta: v.meta as boolean,
    shift: v.shift as boolean,
  };
}

/** Saved keys over the defaults; anything unreadable falls back per action. */
export function parseAeSuggestionKeys(raw: string | null): AeSuggestionKeys {
  if (!raw) return AE_DEFAULT_SUGGESTION_KEYS;
  let saved: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return AE_DEFAULT_SUGGESTION_KEYS;
    saved = parsed as Record<string, unknown>;
  } catch {
    return AE_DEFAULT_SUGGESTION_KEYS;
  }
  return {
    next: parseChord(saved.next) ?? AE_DEFAULT_SUGGESTION_KEYS.next,
    previous: parseChord(saved.previous) ?? AE_DEFAULT_SUGGESTION_KEYS.previous,
  };
}

// Held in memory when storage is blocked, so a change lasts until reload.
let override: AeSuggestionKeys | null = null;
let cached: AeSuggestionKeys | null = null;
const listeners = new Set<() => void>();

function readStorage(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(AE_SUGGESTION_KEYS_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The keys in force now (read once, then cached until a change). */
export function readAeSuggestionKeys(): AeSuggestionKeys {
  cached ??= override ?? parseAeSuggestionKeys(readStorage());
  return cached;
}

function changed() {
  cached = null;
  for (const listener of listeners) listener();
}

function save(keys: AeSuggestionKeys) {
  const isDefault =
    aeSameChord(keys.next, AE_DEFAULT_SUGGESTION_KEYS.next) &&
    aeSameChord(keys.previous, AE_DEFAULT_SUGGESTION_KEYS.previous);
  try {
    if (isDefault) window.localStorage.removeItem(AE_SUGGESTION_KEYS_STORAGE_KEY);
    else window.localStorage.setItem(AE_SUGGESTION_KEYS_STORAGE_KEY, JSON.stringify(keys));
    override = null;
  } catch {
    override = keys;
  }
  changed();
}

/**
 * Save one action's chord, or `null` to put it back to its default. A reset
 * whose default the other action now holds resets that one too, so the two
 * never share a chord.
 */
export function writeAeSuggestionKey(action: AeSuggestionKeyAction, chord: AeKeyChord | null) {
  const keys = { ...readAeSuggestionKeys(), [action]: chord ?? AE_DEFAULT_SUGGESTION_KEYS[action] };
  if (chord === null && aeSameChord(keys.next, keys.previous)) {
    const other: AeSuggestionKeyAction = action === "next" ? "previous" : "next";
    keys[other] = AE_DEFAULT_SUGGESTION_KEYS[other];
  }
  save(keys);
}

// One storage listener for every subscriber: another tab saving new keys.
function onStorage(event: StorageEvent) {
  if (event.key === AE_SUGGESTION_KEYS_STORAGE_KEY) changed();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function useAeSuggestionKeys(): AeSuggestionKeys {
  return useSyncExternalStore(subscribe, readAeSuggestionKeys, () => AE_DEFAULT_SUGGESTION_KEYS);
}

/** +1 for the next suggestion, -1 for the previous, 0 for any other key. */
export function aeSuggestionCycleStep(
  event: ChordEvent,
  keys: AeSuggestionKeys = readAeSuggestionKeys(),
): 1 | -1 | 0 {
  const chord = aeChordFromEvent(event);
  if (!chord) return 0;
  if (aeSameChord(chord, keys.next)) return 1;
  if (aeSameChord(chord, keys.previous)) return -1;
  return 0;
}

// The app's own hotkeys (hooks/use*Hotkey.ts, the shortcuts dialog) and the
// text-editing keys a composer needs, by modifier set. "cmd" is ⌘ on a Mac and
// Ctrl elsewhere; "ctrl" is the literal Control key.
const RESERVED: { mods: "cmd" | "cmd+alt" | "ctrl+shift"; codes: string[]; what: string }[] = [
  { mods: "cmd", codes: ["BracketLeft", "BracketRight"], what: "switch sessions" },
  { mods: "cmd", codes: ["KeyK"], what: "open the command palette" },
  { mods: "cmd", codes: ["Enter", "Slash"], what: "approve and show shortcuts" },
  { mods: "cmd", codes: DIGITS, what: "open pinned sessions" },
  { mods: "cmd", codes: ["KeyA", "KeyC", "KeyV", "KeyX", "KeyY", "KeyZ"], what: "edit text" },
  { mods: "cmd+alt", codes: ["BracketLeft", "BracketRight"], what: "open and close the sidebars" },
  { mods: "cmd+alt", codes: DIGITS, what: "open pinned sessions" },
  {
    mods: "cmd+alt",
    codes: ["KeyS", "KeyB", "KeyN", "KeyT", "KeyV"],
    what: "run another app shortcut",
  },
  { mods: "cmd+alt", codes: ["Comma", "Backslash"], what: "run another app shortcut" },
  { mods: "ctrl+shift", codes: ["KeyL", "KeyM"], what: "focus the composer or pick a model" },
];

function modsOf(chord: AeKeyChord, isMac: boolean): string | null {
  const command = hasCommandModifier({ metaKey: chord.meta, ctrlKey: chord.ctrl }, isMac);
  if (command && !chord.shift) return chord.alt ? "cmd+alt" : "cmd";
  if (chord.ctrl && chord.shift && !chord.alt && !chord.meta) return "ctrl+shift";
  return null;
}

/**
 * Why a chord cannot be used for `action`, or `null` when it can. A chord
 * needs Alt, Ctrl or ⌘ (a bare key would type into the box) and must not be
 * the other action's chord or one the app already binds.
 */
export function aeChordProblem(
  chord: AeKeyChord,
  action: AeSuggestionKeyAction,
  keys: AeSuggestionKeys,
  isMac: boolean = isMacPlatform(),
): string | null {
  if (!chord.alt && !chord.ctrl && !chord.meta) {
    return `Use ${isMac ? "⌥, ⌃ or ⌘" : "Alt or Ctrl"} with the key, or it would type into the box.`;
  }
  if (["Tab", "Escape", "Enter", "NumpadEnter"].includes(chord.code)) {
    return "Tab, Esc and Enter keep their own jobs in the composer.";
  }
  const other = action === "next" ? keys.previous : keys.next;
  if (aeSameChord(chord, other)) {
    return `Already used for ${action === "next" ? "previous" : "next"} suggestion.`;
  }
  const mods = modsOf(chord, isMac);
  const taken = RESERVED.find((r) => r.mods === mods && r.codes.includes(chord.code));
  return taken ? `Already used to ${taken.what}.` : null;
}

const CODE_LABELS: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  Space: "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function codeLabel(code: string): string {
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  return code;
}

/** The chord as key caps, e.g. `["Alt", "]"]` or `["⌥", "]"]` on a Mac. */
export function aeChordKeys(chord: AeKeyChord, isMac: boolean = isMacPlatform()): string[] {
  const keys: string[] = [];
  if (chord.ctrl) keys.push(isMac ? "⌃" : "Ctrl");
  if (chord.alt) keys.push(isMac ? "⌥" : "Alt");
  if (chord.shift) keys.push(isMac ? "⇧" : "Shift");
  if (chord.meta) keys.push(isMac ? "⌘" : "Win");
  keys.push(codeLabel(chord.code));
  return keys;
}

/** The chord as one string for a tooltip, e.g. `"Alt+]"` or `"⌥]"`. */
export function aeChordLabel(chord: AeKeyChord, isMac: boolean = isMacPlatform()): string {
  return aeChordKeys(chord, isMac).join(isMac ? "" : "+");
}
