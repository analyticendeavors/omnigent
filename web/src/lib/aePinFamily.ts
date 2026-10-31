// Settings > Chat > Pin a lead's family (omnigent-ae, 2026-10-26; three choices
// 2026-10-31): what pinning a family's lead does with its open sessions, and
// unpinning with its pinned ones. "ask" (default) asks each time, "family"
// always takes the whole family, "parent" only the lead. Device-local. The
// older "on" reads as "family" and "off" as "ask". The cascade and the dialog:
// shell/aePinFamily.ts, shell/AePinFamilyChoice.tsx.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "omnigent:ae-pin-family";

export type AePinFamilyMode = "ask" | "family" | "parent";

export function readAePinFamily(): AePinFamilyMode {
  if (typeof window === "undefined") return "ask";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "family" || stored === "on") return "family";
    if (stored === "parent") return "parent";
  } catch {
    // Storage unreadable: the default.
  }
  return "ask";
}

const listeners = new Set<() => void>();

export function writeAePinFamily(mode: AePinFamilyMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // A local preference; losing it is harmless.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAePinFamily(): AePinFamilyMode {
  return useSyncExternalStore(subscribe, readAePinFamily, () => "ask");
}
