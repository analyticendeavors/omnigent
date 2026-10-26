// Model changes the lead made with set_session_model (omnigent-ae): the band above every chat,
// the Agents card and the Family row share these. Routes: `POST /v1/ae/sessions/{id}/model`
// (change and Undo) and `GET /v1/ae/sessions/{id}/model-changes` (the band's feed).

import { useQuery } from "@tanstack/react-query";
import { AE_MODEL_FAMILY_NAMES, aeModelFamily, type AeModelFamily } from "@/lib/aeAgentUsage";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";

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

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function point(value: unknown): AeModelPoint {
  const rec = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return { model: str(rec.model), effort: str(rec.effort) };
}

/** One row of the feed: the change, when it happened, and whether it was itself an Undo. */
export interface AeModelChangeItem {
  change: AeModelChange;
  at: number;
  undone: boolean;
}

function pair(value: unknown): AeModelPoint | null {
  return Array.isArray(value) ? { model: str(value[0]), effort: str(value[1]) } : null;
}

const APPROVED: Record<string, AeModelChange["approved"]> = {
  a: "auto",
  r: "reid",
  u: "user",
  auto: "auto",
  reid: "reid",
  user: "user",
};

interface Last {
  from: AeModelPoint;
  to: AeModelPoint;
  kind: "raise" | "lower";
  reason: string;
  at: number | null;
  approved: AeModelChange["approved"];
  undo: AeModelPoint | null;
  undone: boolean;
}

/**
 * The `ae.model_last` object. The server writes compact keys (f, t, k, r, a, p, u, x; a
 * missing u means undo equals f); the long names are accepted as a fallback.
 */
function parseLast(raw: unknown): Last | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const compact = "t" in r || "f" in r;
  const from = pair(r.f) ?? point(r.from);
  const to = pair(r.t) ?? point(r.to);
  const k = r.k ?? r.kind;
  const at = r.a ?? r.at;
  const undo = pair(r.u) ?? (r.undo && typeof r.undo === "object" ? point(r.undo) : null);
  const p = r.p ?? r.approved;
  return {
    from,
    to,
    kind: k === "l" || k === "lower" ? "lower" : "raise",
    reason: str(r.r ?? r.reason) ?? "",
    at: typeof at === "number" && Number.isFinite(at) ? at : null,
    approved: typeof p === "string" ? (APPROVED[p] ?? null) : null,
    undo: undo ?? (compact ? from : null),
    undone: r.x === 1 || r.undone === true,
  };
}

function parseItem(raw: unknown): AeModelChangeItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const sessionId = str(rec.session_id);
  const ch = parseLast(rec.change);
  if (!sessionId || !ch || ch.at === null) return null;
  return {
    at: ch.at,
    undone: ch.undone,
    change: {
      status: "changed",
      sessionId,
      title: str(rec.title) ?? "",
      role: str(rec.role),
      isLead: rec.is_lead === true,
      from: ch.from,
      to: ch.to,
      kind: ch.kind,
      raises: 0,
      cap: null,
      counted: false,
      approved: ch.approved,
      reason: ch.reason,
      refusal: null,
      undo: ch.undo,
    },
  };
}

/** What the band remembers a dismissal by: a later change in the same second still shows. */
export function aeChangeSignature(item: AeModelChangeItem): string {
  const { to } = item.change;
  return `${item.at}:${to.model ?? ""}:${to.effort ?? ""}:${item.undone ? 1 : 0}`;
}

export interface AeModelChangeFeed {
  items: AeModelChangeItem[];
  /** The server answered 404: an older one, so the band stays empty and stops asking. */
  unsupported: boolean;
}

export const AE_MODEL_CHANGES_POLL_MS = 60_000;
const AE_MODEL_CHANGES_ERROR_MAX_MS = 120_000;
export const AE_MODEL_CHANGES_STALE_MS = 20_000;

export async function fetchAeModelChanges(leadId: string): Promise<AeModelChangeFeed> {
  const res = await authenticatedFetch(
    `/v1/ae/sessions/${encodeURIComponent(leadId)}/model-changes`,
    {
      method: "GET",
    },
  );
  // 404 is an older server and 403 a session that is not yours: neither will change.
  if (res.status === 404 || res.status === 403) return { items: [], unsupported: true };
  if (!res.ok) throw new Error(`Model changes failed (${res.status})`);
  const body = (await res.json().catch(() => null)) as { changes?: unknown } | null;
  const list = Array.isArray(body?.changes) ? body.changes : [];
  const items = list.flatMap((raw) => {
    const item = parseItem(raw);
    return item ? [item] : [];
  });
  return { items: items.sort((a, b) => b.at - a.at), unsupported: false };
}

/** The lead's model changes and its family's, newest first; polled while the page shows. */
export function useAeModelChanges(leadId: string | null) {
  return useQuery({
    queryKey: ["ae-model-changes", leadId],
    queryFn: () => fetchAeModelChanges(leadId as string),
    enabled: !!leadId,
    retry: false,
    staleTime: AE_MODEL_CHANGES_STALE_MS,
    refetchInterval: (query: { state: { data?: AeModelChangeFeed; errorUpdateCount: number } }) => {
      if (query.state.data?.unsupported || document.visibilityState === "hidden") return false;
      // A failing read backs off (15 s, 30 s, ... at most 2 min) instead of hammering.
      const errors = query.state.errorUpdateCount;
      if (errors > 0) return Math.min(AE_MODEL_CHANGES_ERROR_MAX_MS, 15_000 * 2 ** (errors - 1));
      return AE_MODEL_CHANGES_POLL_MS;
    },
  });
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

/** The `ae.model_last` label parsed, or null when absent or not JSON. */
function parseModelLast(label: string | undefined): Last | null {
  if (!label) return null;
  try {
    return parseLast(JSON.parse(label));
  } catch {
    return null;
  }
}

/** What a helper's labels say about its raises, for the hover card's raise line. */
export interface AeRaiseDetail {
  /** Where it started (`ae.model_start`). */
  start: AeModelPoint;
  /** Where the last change left it, when `ae.model_last` names one. */
  now: AeModelPoint | null;
  /** The last change's reason and time (epoch seconds), when recorded. */
  reason: string;
  at: number | null;
  raises: number;
  cap: number | null;
  capReached: boolean;
}

/**
 * A raised helper's start, last change and raise count, or null when it was never
 * raised or now runs at or below where it started. `current` is what it runs on
 * now when usage has landed; without it the last change's target stands in.
 */
export function aeRaiseDetail(
  labels: Readonly<Record<string, string>> | null | undefined,
  current: AeModelPoint | null,
): AeRaiseDetail | null {
  const start = parseAeModelStart(labels?.["ae.model_start"]);
  if (!start) return null;
  const last = parseModelLast(labels?.["ae.model_last"]);
  const raises = aeLabelCount(labels?.["ae.raises"]) ?? 0;
  const known = current && (current.model || current.effort) ? current : null;
  // An undone change is settled in the labels at once, while usage can lag a read
  // behind, so the undo's point wins over usage then.
  const now = last?.undone ? (last.undo ?? last.from) : (known ?? last?.to ?? null);
  if (!now || !aeRunsAboveStart(now, start)) return null;
  const cap = aeLabelCount(labels?.["ae.raise_cap"]);
  return {
    start,
    now,
    reason: last?.kind === "raise" && !last.undone ? last.reason : "",
    at: last?.kind === "raise" && !last.undone ? last.at : null,
    raises,
    cap,
    capReached: raises >= 1 && cap !== null && raises >= cap,
  };
}

export interface AeRaiseMarks {
  raised: boolean;
  capReached: boolean;
  title: string;
  line: string;
}

/**
 * The raise marks of a helper: whether it runs above where it started, the cap chip and the
 * texts. The Agents card and the Family row share this. `current` is what it runs on now.
 */
export function aeRaiseMarks(
  labels: Readonly<Record<string, string>> | null | undefined,
  current: AeModelPoint,
): AeRaiseMarks {
  const started = parseAeModelStart(labels?.["ae.model_start"]);
  const raises = aeLabelCount(labels?.["ae.raises"]) ?? 0;
  const cap = aeLabelCount(labels?.["ae.raise_cap"]);
  const capReached = raises >= 1 && cap !== null && raises >= cap;
  // Without a start label only the count can say it was raised (the Agents card's old rule).
  if (!started) {
    return {
      raised: raises >= 1,
      capReached,
      title: `Raised ${raises} time${raises === 1 ? "" : "s"}`,
      line: "",
    };
  }
  const raised = aeRunsAboveStart(current, started);
  const last = parseModelLast(labels?.["ae.model_last"]);
  const now = current.model || current.effort ? current : (last?.to ?? current);
  const line = `\u2191 ${aeModelPointText(now)} \u00b7 from ${aeModelPointText(started)}`;
  const count = `Raised ${raises} time${raises === 1 ? "" : "s"}`;
  let title = `${count} from ${aeModelPointText(started)}`;
  if (last?.at != null) {
    const time = new Date(last.at * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    title = `${count}, ${time}${last.reason ? `: ${last.reason}` : ""}.`;
    if (capReached) title += " The next raise asks you first.";
  }
  return { raised, capReached, title, line };
}
