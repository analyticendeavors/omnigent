// A small in-memory log of voice events (mic, sentences, replies, browser errors) so a
// phone's voice session can be diagnosed: the menu row "Add voice log to message" puts the
// last two minutes into the message box. The log goes to the server only when Voice mode
// hits trouble or ends, or when the user taps "Send voice log" (uploadVoiceLog, below).

import { useEffect, useRef } from "react";
import { authenticatedFetch } from "./identity";
import { withBasePath } from "./basePath";

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
  lastUpload.clear();
}

/** Why a log is sent; the server accepts exactly these. */
export type VoiceLogReason =
  "mic_failed" | "mic_deaf" | "mic_stalled" | "mic_paused" | "voice_end" | "manual";

/** The same reason is sent at most this often. */
export const UPLOAD_MIN_GAP_MS = 20_000;
/** The server refuses a body over 64 KB (and so does a keepalive fetch); stay under it. */
const UPLOAD_MAX_BYTES = 60_000;
const UPLOAD_MAX_EVENT = 64;

const lastUpload = new Map<VoiceLogReason, number>();

/**
 * Sends the current log to the server, best effort: never throws, and a failed or refused
 * send is only a "failed" answer. The same reason goes at most once per UPLOAD_MIN_GAP_MS
 * ("throttled" means the last one just went). keepalive lets it finish while the page closes.
 */
export async function uploadVoiceLog(
  reason: VoiceLogReason,
  chatId?: string | null,
): Promise<"sent" | "throttled" | "failed"> {
  try {
    if (typeof window === "undefined") return "failed";
    const now = Date.now();
    const last = lastUpload.get(reason);
    if (last !== undefined && now - last < UPLOAD_MIN_GAP_MS) return "throttled";
    lastUpload.set(reason, now);
    const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
    const head = { t: now, event: "client", detail: ua.slice(0, 200) };
    let lines = [
      head,
      ...entries.map((e) => ({
        t: e.t,
        event: e.event.slice(0, UPLOAD_MAX_EVENT),
        ...(e.detail ? { detail: e.detail.slice(0, MAX_DETAIL) } : {}),
      })),
    ];
    const build = () => JSON.stringify({ reason, ...(chatId ? { chat_id: chatId } : {}), lines });
    let body = build();
    // Oldest events go first when the buffer is too big for one request.
    while (body.length > UPLOAD_MAX_BYTES && lines.length > 1) {
      lines = [head, ...lines.slice(Math.ceil((lines.length - 1) / 4) + 1)];
      body = build();
    }
    const response = await authenticatedFetch(withBasePath("/v1/ae/voice-log"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    });
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
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
      // A slash command takes what follows as arguments, so the log goes before it.
      if (!current) setRef.current(text);
      else if (current.trimStart().startsWith("/")) setRef.current(`${text}\n\n${current}`);
      else setRef.current(`${current}\n\n${text}`);
    };
    window.addEventListener(INSERT_EVENT, onInsert);
    return () => window.removeEventListener(INSERT_EVENT, onInsert);
  }, []);
}
