// The session rail's Triage section, the pure parts: the absorbed and unfiled
// lines in the loaded assistant messages, the user turns, the "started" age,
// and the gate reply the Dashboard's buttons send.

import type { AnyBlock } from "@/lib/blocks";
import { authenticatedFetch } from "@/lib/identity";
import { isSystemUserContent } from "@/lib/systemMessage";

export interface AeTriageLines {
  absorbed: string[];
  unfiled: string[];
}

// Read like the observer reads them: the token at the start of a line only.
const ABSORBED = /^Absorbed:\s*(.*)$/;
const UNFILED = /^UNFILED\b[\s:,.-]*(.*)$/;

/**
 * Every "Absorbed:" and "UNFILED" line in the loaded assistant messages, the
 * token stripped (an UNFILED line with nothing after it keeps the token).
 */
export function scanAeTriageLines(blocks: readonly AnyBlock[]): AeTriageLines {
  const absorbed: string[] = [];
  const unfiled: string[] = [];
  for (const block of blocks) {
    if (block.type !== "text_done") continue;
    for (const raw of block.fullText.split("\n")) {
      const line = raw.replace(/\r$/, "");
      const a = ABSORBED.exec(line);
      if (a) {
        absorbed.push(a[1].trim() || "Absorbed");
        continue;
      }
      const u = UNFILED.exec(line);
      if (u) unfiled.push(u[1].trim() || "UNFILED");
    }
  }
  return { absorbed, unfiled };
}

/** The user messages loaded for the session, leaving out runtime `[System: ...]` markers. */
export function countAeUserTurns(blocks: readonly AnyBlock[]): number {
  let turns = 0;
  for (const block of blocks) {
    if (block.type === "user_message" && !isSystemUserContent(block.content)) turns += 1;
  }
  return turns;
}

/** `ae.started` (epoch seconds as text) as a number, or `null` when blank or not a time. */
export function parseAeStarted(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** "2h 10m", "5m", "3d 4h", "just now" for an age in seconds. */
export function formatAeAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return "just now";
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/**
 * "Started 2h 10m ago · 41 turns", either half alone when the other is
 * unknown, or `null` when both are. With older history unloaded the count
 * would only be a floor, so it is left out.
 */
export function aeStartedLine(
  startedS: number | null,
  nowMs: number,
  turns: number | null,
  moreHistory = false,
): string | null {
  const parts: string[] = [];
  if (startedS !== null) {
    const age = formatAeAge(nowMs / 1000 - startedS);
    parts.push(age === "just now" ? "Started just now" : `Started ${age} ago`);
  }
  if (turns !== null && !moreHistory) {
    parts.push(`${turns} ${turns === 1 ? "turn" : "turns"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

const ORDINAL_SUFFIX = ["th", "st", "nd", "rd"];

/** 4 reads "4th", 11 "11th", 22 "22nd". */
export function aeOrdinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${(!teen && ORDINAL_SUFFIX[n % 10]) || "th"}`;
}

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

/** The overflow tag and its title for a slot limit: "4th working" over three. */
export function aeOverflowTag(limit: number): { label: string; title: string } {
  const count = NUMBER_WORDS[limit] ?? String(limit);
  return {
    label: `${aeOrdinal(limit + 1)} working`,
    title: `Started while ${count} sessions were already working`,
  };
}

// ── the gate reply ───────────────────────────────────────────────────────

export type AeGateRoute = "A" | "B" | "C" | "close";

/** The Dashboard's four answers (ae_omni_extension gate.ts): route, label, tooltip. */
export const AE_GATE_ROUTES: readonly [AeGateRoute, string, string][] = [
  ["A", "Do it now", "A, act now: absorb it into this thread"],
  ["B", "Write a note", "B, handoff note here, then back to the task"],
  ["C", "Save for later", "C, file it to the Parking Lot"],
  ["close", "Drop it", "Close: neither urgent nor important, so drop it"],
];

export function aeGateLabel(route: AeGateRoute): string {
  return AE_GATE_ROUTES.find(([r]) => r === route)?.[1] ?? route;
}

/** The server's `{"error": {"message"}}`, else FastAPI's `detail`, else the status line. */
export async function aeErrorMessage(res: Response): Promise<string> {
  const status = `${res.status} ${res.statusText}`.trim();
  try {
    const body = (await res.json()) as {
      error?: { message?: unknown };
      detail?: unknown;
    };
    if (typeof body.error?.message === "string") return body.error.message;
    if (typeof body.detail === "string") return body.detail;
    if (body.detail !== undefined) return `${status}: ${JSON.stringify(body.detail)}`;
  } catch {
    // No JSON body; the status line is all there is.
  }
  return status;
}

/**
 * Answer an open gate as the Dashboard does: `POST /v1/ae/gate/{id}/reply`
 * posts the letter as the session's next user turn and marks the gate
 * answered. Throws with the server's reason (409 when no gate is open).
 */
export async function replyAeGate(sessionId: string, route: AeGateRoute): Promise<void> {
  const res = await authenticatedFetch(`/v1/ae/gate/${encodeURIComponent(sessionId)}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ route }),
  });
  if (!res.ok) throw new Error(await aeErrorMessage(res));
}

// ── the parked task ──────────────────────────────────────────────────────

export interface AeLotTask {
  id: string;
  title: string | null;
  url: string | null;
}

/** The open Parking Lot through `GET /v1/ae/lot` (the Dashboard's read), id, title and link only. */
export async function fetchAeLotTasks(): Promise<AeLotTask[]> {
  const res = await authenticatedFetch("/v1/ae/lot?status=open&limit=100", { method: "GET" });
  if (!res.ok) throw new Error(await aeErrorMessage(res));
  const body = (await res.json()) as { tasks?: unknown };
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
  return tasks.flatMap((raw): AeLotTask[] => {
    if (!raw || typeof raw !== "object") return [];
    const task = raw as Record<string, unknown>;
    if (typeof task.id !== "string") return [];
    return [
      {
        id: task.id,
        title: typeof task.title === "string" ? task.title : null,
        url: typeof task.url === "string" ? task.url : null,
      },
    ];
  });
}
