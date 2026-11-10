// Send snips: a picture attached during Voice mode is acknowledged by voice and goes
// with the next spoken sentence, or alone as "Note this." after a quiet wait. This file
// holds the constants, the per-device switch and the picture helpers; the loop is in
// hooks/useAeVoiceSnips.ts.

import { useSyncExternalStore } from "react";

/** Quiet time after a picture lands before it is sent alone. */
export const SNIP_WAIT_MS = 10_000;
/** Spoken when a picture lands. */
export const SNIP_ACK = "Got it.";
/** The text a picture sent alone carries. */
export const SNIP_NOTE = "Note this.";
export const SNIPS_KEY = "omnigent:ae-voice-snips";

export function readSendSnips(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SNIPS_KEY) === "true";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function subscribeSendSnips(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function writeSendSnips(on: boolean): void {
  if (typeof window !== "undefined") {
    try {
      if (on) window.localStorage.setItem(SNIPS_KEY, "true");
      else window.localStorage.removeItem(SNIPS_KEY);
    } catch {
      // A storage failure must not break the composer.
    }
  }
  listeners.forEach((cb) => cb());
}

export function useSendSnips(): boolean {
  return useSyncExternalStore(subscribeSendSnips, readSendSnips, () => false);
}

/** Forget the saved switch; for tests. */
export function resetSnipsStore(): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(SNIPS_KEY);
    } catch {
      // Ignore.
    }
  }
  listeners.forEach((cb) => cb());
}

export function isSnipFile(f: File): boolean {
  return f.type.startsWith("image/");
}

/** The pictures on a paste's clipboard; any other kind of file is left alone. */
export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return Array.from(data.files ?? []).filter(isSnipFile);
}

export function countImageFiles(files: File[]): number {
  return files.filter(isSnipFile).length;
}

/** The composer's own fields handle their paste; the window listener must not add twice. */
export function isComposerPasteTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    (target instanceof HTMLElement && target.isContentEditable === true)
  );
}
