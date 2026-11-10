// A small in-memory log of voice events (mic, sentences, replies, browser errors) so a
// phone's voice session can be diagnosed: the menu row "Add voice log to message" puts the
// last two minutes into the message box. Nothing leaves the device until the user sends.

import { useEffect, useRef } from "react";

interface VoiceLogEntry {
  t: number;
  event: string;
  detail?: string;
}

const MAX_ENTRIES = 300;
const MAX_DETAIL = 80;
const INSERT_EVENT = "ae-voice-log-insert";

let entries: VoiceLogEntry[] = [];

export function logVoice(event: string, detail?: string): void {
  try {
    if (typeof window === "undefined") return;
    entries.push({ t: Date.now(), event, detail });
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  } catch {
    // Logging must never break voice.
  }
}

export function resetVoiceLog(): void {
  entries = [];
}

export function formatVoiceLog(windowMs = 120_000): string {
  const now = Date.now();
  const inWindow = entries.filter((e) => now - e.t <= windowMs);
  const start = inWindow.length > 0 ? inWindow[0].t : now;
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const header = `Voice log ${new Date(start).toISOString()} ${ua}`;
  const lines = inWindow.map((e) => {
    const detail = e.detail ? ` ${e.detail.slice(0, MAX_DETAIL)}` : "";
    return `+${((e.t - start) / 1000).toFixed(2)}s ${e.event}${detail}`;
  });
  return [header, ...lines].join("\n");
}

export function requestVoiceLogInsert(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(INSERT_EVENT, { detail: { text: formatVoiceLog() } }));
}

/** Appends the voice log to the message box when the speaker menu asks for it. */
export function useVoiceLogInsert(value: string, setValue: (next: string) => void): void {
  const valueRef = useRef(value);
  valueRef.current = value;
  const setRef = useRef(setValue);
  setRef.current = setValue;
  useEffect(() => {
    const onInsert = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text;
      if (!text) return;
      const current = valueRef.current;
      setRef.current(current ? `${current}\n\n${text}` : text);
    };
    window.addEventListener(INSERT_EVENT, onInsert);
    return () => window.removeEventListener(INSERT_EVENT, onInsert);
  }, []);
}
