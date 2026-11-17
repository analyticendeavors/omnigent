// A small in-memory log of voice events (mic, sentences, replies, browser errors) so a
// phone's voice session can be diagnosed: the menu row "Add voice log to message" puts the
// last two minutes into the message box. The log goes to the server only when Voice mode
// hits trouble or ends, or when the user taps "Send voice log" (uploadVoiceLog, below).

import { useEffect, useRef } from "react";
import { showToast } from "@/components/ui/toast";
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
  lastAutoUpload = null;
  autoInFlight = false;
  lastHideUpload = null;
  hideInFlight = false;
}

/** Why a log is sent; the server accepts exactly these. */
export type VoiceLogReason =
  "mic_failed" | "mic_deaf" | "mic_stalled" | "mic_paused" | "page_hidden" | "voice_end" | "manual";

/** The last two minutes: what "Add voice log to message" shows and what an upload carries. */
export const VOICE_LOG_WINDOW_MS = 120_000;
/** Automatic uploads share one budget: at most one per this long, whatever the reason. */
export const UPLOAD_MIN_GAP_MS = 60_000;
/** The server refuses a body over 64 KB (and so does a keepalive fetch); stay under it. */
const UPLOAD_MAX_BYTES = 60_000;
const UPLOAD_MAX_EVENT = 64;

/** When the last automatic upload was accepted by the server (null: none yet). */
let lastAutoUpload: number | null = null;
let autoInFlight = false;
/** Page-hide uploads keep their own budget, so a backgrounded phone never spends the failure one. */
let lastHideUpload: number | null = null;
let hideInFlight = false;
const encoder = new TextEncoder();
/** An in-page upload that has not answered by now is given up, so the budget never stays claimed. */
export const UPLOAD_TIMEOUT_MS = 10_000;

export interface UploadVoiceLogOptions {
  /**
   * Let the request outlive the page (pagehide). Only for a page that is going away: iOS WebKit
   * drops a keepalive request made from a page that stays open, so in-page uploads leave it off.
   */
  keepalive?: boolean;
}

/** One POST with a timeout; a keepalive request that is rejected is retried once without it. */
async function postVoiceLog(body: string, keepalive: boolean): Promise<Response> {
  const attempt = async (withKeepalive: boolean): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      return await authenticatedFetch(withBasePath("/v1/ae/voice-log"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
        ...(withKeepalive ? { keepalive: true } : {}),
      });
    } finally {
      clearTimeout(timer);
    }
  };
  if (!keepalive) return attempt(false);
  try {
    return await attempt(true);
  } catch (error) {
    // A timeout is not a rejected keepalive, and a page that is going away cannot retry.
    if (errName(error) === "AbortError") throw error;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") throw error;
    logVoice("log upload", "keepalive rejected, retry");
    return attempt(false);
  }
}

function errName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "error";
}

/** The short reason shown when a voice_end upload did not go. */
function failureReason(name: string): string {
  if (name === "AbortError") return "timed out";
  return name.startsWith("http") ? `server answered ${name.slice(4)}` : "network error";
}

/**
 * Sends the last two minutes of the log to the server, best effort: never throws, and a
 * failed or refused send is only a "failed" answer. Automatic reasons share one budget of one
 * upload per UPLOAD_MIN_GAP_MS ("throttled" means one just went or is on its way); the budget
 * is spent only when the server accepted the upload, so a failure can be retried. "manual"
 * (the user tapped Send) skips that budget. In-page uploads are plain requests (no keepalive, which
 * iOS drops) with a 10 s timeout; `keepalive` is for a page that is going away. Every result lands
 * in the log buffer, and a voice_end result is also toasted.
 */
export async function uploadVoiceLog(
  reason: VoiceLogReason,
  chatId?: string | null,
  opts?: UploadVoiceLogOptions,
): Promise<"sent" | "throttled" | "failed"> {
  let errorName = "ok";
  const result = await uploadVoiceLogInner(reason, chatId, opts, (n) => {
    errorName = n;
  });
  logVoice("log upload", `${reason} ${result} ${errorName}`);
  // A throttled End means the failure upload just sent the log: no toast either way.
  if (reason === "voice_end" && result !== "throttled") {
    try {
      showToast(
        result === "sent" ? "Voice log sent" : `Voice log not sent: ${failureReason(errorName)}`,
      );
    } catch {
      // A toast must never break voice.
    }
  }
  return result;
}

async function uploadVoiceLogInner(
  reason: VoiceLogReason,
  chatId: string | null | undefined,
  opts: UploadVoiceLogOptions | undefined,
  setError: (name: string) => void,
): Promise<"sent" | "throttled" | "failed"> {
  const automatic = reason !== "manual";
  const hide = reason === "page_hidden";
  let claimed = false;
  try {
    if (typeof window === "undefined") return "failed";
    const now = Date.now();
    if (hide) {
      if (hideInFlight || (lastHideUpload !== null && now - lastHideUpload < UPLOAD_MIN_GAP_MS)) {
        return "throttled";
      }
      hideInFlight = true;
      claimed = true;
    } else if (automatic) {
      if (autoInFlight || (lastAutoUpload !== null && now - lastAutoUpload < UPLOAD_MIN_GAP_MS)) {
        return "throttled";
      }
      autoInFlight = true;
      claimed = true;
    }
    const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
    const head = { t: now, event: "client", detail: ua.slice(0, 200) };
    let lines = [
      head,
      ...entries
        .filter((e) => now - e.t <= VOICE_LOG_WINDOW_MS)
        .map((e) => ({
          t: e.t,
          event: e.event.slice(0, UPLOAD_MAX_EVENT),
          ...(e.detail ? { detail: e.detail.slice(0, MAX_DETAIL) } : {}),
        })),
    ];
    const build = () => JSON.stringify({ reason, ...(chatId ? { chat_id: chatId } : {}), lines });
    let body = build();
    // Oldest events go first when the buffer is too big for one request (bytes, not characters).
    while (encoder.encode(body).length > UPLOAD_MAX_BYTES && lines.length > 1) {
      lines = [head, ...lines.slice(Math.ceil((lines.length - 1) / 4) + 1)];
      body = build();
    }
    const response = await postVoiceLog(body, opts?.keepalive === true);
    if (!response.ok) {
      setError(`http${response.status}`);
      return "failed";
    }
    if (hide) lastHideUpload = now;
    else if (automatic) lastAutoUpload = now;
    return "sent";
  } catch (error) {
    setError(errName(error));
    return "failed";
  } finally {
    if (claimed) {
      if (hide) hideInFlight = false;
      else autoInFlight = false;
    }
  }
}

export function formatVoiceLog(windowMs = VOICE_LOG_WINDOW_MS): string {
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

/**
 * While `active` (a voice session is on), sends the log when the page is hidden or closing, the
 * one place a keepalive request is used: the page may be gone before a plain request answers.
 * It has its own budget (reason page_hidden), so a backgrounded phone sends at most one a minute
 * and never spends the automatic failure budget.
 */
export function useVoiceLogOnHide(active: boolean, chatId: () => string | null | undefined): void {
  const chatRef = useRef(chatId);
  chatRef.current = chatId;
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const send = () => {
      logVoice("page hidden");
      void uploadVoiceLog("page_hidden", chatRef.current(), { keepalive: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") send();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", send);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", send);
    };
  }, [active]);
}
