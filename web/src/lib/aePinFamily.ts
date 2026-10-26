// Settings > Chat > Pin a lead's family (omnigent-ae, 2026-10-26): whether
// pinning a family's lead also pins its open sessions, and unpinning it unpins
// the family. Device-local, off by default. The cascade: shell/aePinFamily.ts.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "omnigent:ae-pin-family";

export function readAePinFamily(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function writeAePinFamily(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
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

export function useAePinFamily(): boolean {
  return useSyncExternalStore(subscribe, readAePinFamily, () => false);
}
