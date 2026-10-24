// The lead's set_session_model result and its Undo call (omnigent-ae). The chat row, the
// Agents card and their tests share these; the server route is `POST /v1/ae/sessions/{id}/model`.

import { AE_MODEL_FAMILY_NAMES, aeModelFamily, type AeModelFamily } from "@/lib/aeAgentUsage";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";

/** Tool names the lead's call arrives under (the native MCP form carries the server prefix). */
export const AE_SET_SESSION_MODEL_NAMES: ReadonlySet<string> = new Set([
  "set_session_model",
  "mcp__ae__set_session_model",
]);

export interface AeModelPoint {
  model: string | null;
  effort: string | null;
}

export type AeModelChangeStatus =
  "changed" | "needs_approval" | "declined" | "refused" | "unchanged";

export interface AeModelChange {
  status: AeModelChangeStatus;
  sessionId: string;
  title: string;
  role: string | null;
  isLead: boolean;
  from: AeModelPoint;
  to: AeModelPoint;
  kind: "raise" | "lower" | "same";
  raises: number;
  cap: number | null;
  counted: boolean;
  approved: "auto" | "reid" | "user" | null;
  reason: string;
  refusal: string | null;
  undo: AeModelPoint | null;
}

const STATUSES: readonly string[] = [
  "changed",
  "needs_approval",
  "declined",
  "refused",
  "unchanged",
];

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function point(value: unknown): AeModelPoint {
  const rec = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return { model: str(rec.model), effort: str(rec.effort) };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The contract JSON, or null when the output is not one (so the caller shows the plain tool card). */
export function parseAeModelChange(output: string | null): AeModelChange | null {
  if (!output) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const status = rec.status;
  const sessionId = str(rec.session_id);
  if (typeof status !== "string" || !STATUSES.includes(status) || !sessionId) return null;
  const kind = rec.kind === "raise" || rec.kind === "lower" ? rec.kind : "same";
  const approved = rec.approved === "auto" || rec.approved === "reid" || rec.approved === "user";
  const undo = rec.undo && typeof rec.undo === "object" ? point(rec.undo) : null;
  return {
    status: status as AeModelChangeStatus,
    sessionId,
    title: str(rec.title) ?? "",
    role: str(rec.role),
    isLead: rec.is_lead === true,
    from: point(rec.from),
    to: point(rec.to),
    kind,
    raises: count(rec.raises),
    cap: typeof rec.cap === "number" ? rec.cap : null,
    counted: rec.counted === true,
    approved: approved ? (rec.approved as AeModelChange["approved"]) : null,
    reason: str(rec.reason) ?? "",
    refusal: str(rec.refusal),
    undo,
  };
}

/** Put the model and effort from before a change back. The browser sends no caller, so no rule applies. */
export async function aeUndoModelChange(sessionId: string, undo: AeModelPoint): Promise<void> {
  const res = await authenticatedFetch(`/v1/ae/sessions/${encodeURIComponent(sessionId)}/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: undo.model,
      effort: undo.effort,
      undo: true,
      reason: "Undo",
    }),
  });
  if (!res.ok) throw await apiErrorFromResponse(res);
  // A 200 can still mean nothing moved (for example "unchanged"); never read that as undone.
  const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
  if (body?.status !== "changed") throw new Error("Could not undo: nothing changed");
}

/** "Sonnet", or the id itself for a model with no Claude family. */
export function aeModelPointName(model: string | null): string {
  if (!model) return "its model";
  const family = aeModelFamily(model);
  return family === "other" || family === "codex" ? model : AE_MODEL_FAMILY_NAMES[family];
}

/** The family a point's dot takes its color from, or null with no model. */
export function aeModelPointFamily(at: AeModelPoint): AeModelFamily | null {
  return at.model ? aeModelFamily(at.model) : null;
}

/** "Sonnet medium"; the effort is left out when unknown. */
export function aeModelPointText(at: AeModelPoint): string {
  return [aeModelPointName(at.model), at.effort].filter(Boolean).join(" ");
}

/** The `ae.model_start` label ("<model>|<effort>") as a point, or null when absent. */
export function parseAeModelStart(label: string | undefined): AeModelPoint | null {
  if (!label) return null;
  const [model, effort] = label.split("|");
  const parsed = { model: model || null, effort: effort || null };
  return parsed.model || parsed.effort ? parsed : null;
}

/** A non-negative whole number label, or null. */
export function aeLabelCount(label: string | undefined): number | null {
  const n = label !== undefined && /^\d+$/.test(label) ? Number(label) : NaN;
  return Number.isFinite(n) ? n : null;
}

const FAMILY_RANK: Readonly<Record<string, number>> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };
const EFFORT_RANK: Readonly<Record<string, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

/**
 * Whether a helper now runs above the model and effort it started on: family first
 * (haiku < sonnet < opus < fable), then effort. A part either side does not
 * name is skipped; with nothing to compare, the raise label stands (true).
 */
export function aeRunsAboveStart(now: AeModelPoint, start: AeModelPoint): boolean {
  const family = (m: string | null) => (m ? FAMILY_RANK[aeModelFamily(m)] : undefined);
  const effort = (e: string | null) => (e ? EFFORT_RANK[e] : undefined);
  const pairs = [
    [family(now.model), family(start.model)],
    [effort(now.effort), effort(start.effort)],
  ];
  for (const [a, b] of pairs) {
    if (a === undefined || b === undefined || a === b) continue;
    return a > b;
  }
  const compared = pairs.some(([a, b]) => a !== undefined && b !== undefined);
  return !compared;
}
