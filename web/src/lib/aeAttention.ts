// The Admin Center's "Needs you" count on the sidebar row (omnigent-ae, 2026-11-03, plan v1.5).
// `GET /v1/ae/attention/summary` answers from the server's caches only (it never asks GitHub or
// Azure), so asking every minute while the tab is visible costs nothing outside the box.
//
// What the number means: the urgent count when anything is urgent, else the review count. A red 6
// is six things to act on now, not a backlog; the tooltip always gives the split. When a source
// could not be read the number is the known count plus "?", and when the route itself fails it is
// "?" alone: an error never reads as zero.

import { useQuery } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/identity";

/** The nav row the badge sits on: the Admin Center page's row (plugin.py FABRIC_NAV_ID). */
export const AE_ATTENTION_NAV_ID = "analyticendeavors.parking-lot.fabric-nav";
export const AE_ATTENTION_QUERY_KEY = ["ae", "attention-summary"] as const;
/** The summary is cheap and cached on the server; the sidebar asks once a minute while visible. */
export const AE_ATTENTION_REFETCH_MS = 60_000;
/** Past this the pill says 99+. */
export const AE_ATTENTION_MAX = 99;

const SOURCE_NAMES: Record<string, string> = { git: "Git", box: "Box health" };

export interface AeAttentionSummary {
  sources: string[];
  counts: {
    urgent: number;
    review: number;
    by_source: Record<string, { urgent: number; review: number }>;
  };
  unknown: string[];
}

export type AeAttentionKind = "none" | "urgent" | "review" | "unknown";

export interface AeAttentionView {
  kind: AeAttentionKind;
  /** The pill's text: "6", "23 ?", "99+", or "?". */
  text: string;
  /** The screen-reader label: red versus neutral is never the only signal. */
  label: string;
  /** The hover text, with the per-source split. */
  tooltip: string;
  /** Something is unreadable, so the count may be low. */
  unsure: boolean;
}

const count = (n: number) => (n > AE_ATTENTION_MAX ? `${AE_ATTENTION_MAX}+` : String(n));

/** Read `GET /v1/ae/attention/summary`; throws when the route cannot answer. */
export async function fetchAeAttentionSummary(): Promise<AeAttentionSummary> {
  const res = await authenticatedFetch("/v1/ae/attention/summary", { method: "GET" });
  if (!res.ok) throw new Error(`GET /v1/ae/attention/summary answered ${res.status}`);
  const body = (await res.json()) as Partial<AeAttentionSummary>;
  const counts = body.counts;
  if (!counts || typeof counts.urgent !== "number" || typeof counts.review !== "number") {
    throw new Error("GET /v1/ae/attention/summary carried no counts");
  }
  return {
    sources: Array.isArray(body.sources) ? body.sources : [],
    counts: { urgent: counts.urgent, review: counts.review, by_source: counts.by_source ?? {} },
    unknown: Array.isArray(body.unknown) ? body.unknown.filter((s) => typeof s === "string") : [],
  };
}

/** The pill for an answer, or for the route being down (`summary` null, `failed` true). */
export function aeAttentionView(
  summary: AeAttentionSummary | null | undefined,
  failed = false,
): AeAttentionView {
  if (!summary) {
    if (!failed) return { kind: "none", text: "", label: "", tooltip: "", unsure: false };
    const why = "Needs you could not be read";
    return { kind: "unknown", text: "?", label: why, tooltip: why, unsure: true };
  }
  const { urgent, review } = summary.counts;
  const unsure = summary.unknown.length > 0;
  if (summary.sources.length === 0 && !unsure) {
    return { kind: "none", text: "", label: "", tooltip: "", unsure: false };
  }
  const split = `${urgent} urgent, ${review} to review`;
  const by = Object.entries(summary.counts.by_source)
    .map(([id, c]) => [SOURCE_NAMES[id] ?? id, c.urgent + c.review] as const)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name} ${n}`)
    .join(", ");
  const warn = summary.unknown.join("; ");
  const label = [split, ...summary.unknown].join(", ");
  const tooltip = [`${split}${by ? `. ${by}.` : "."}`, warn ? `${warn}; the count may be low.` : ""]
    .filter(Boolean)
    .join(" ");
  if (urgent === 0 && review === 0) {
    // Nothing known to act on: quiet when all sources read, "?" alone when one did not.
    return unsure
      ? { kind: "unknown", text: "?", label, tooltip, unsure }
      : { kind: "none", text: "", label: "", tooltip: "", unsure: false };
  }
  const shown = urgent > 0 ? urgent : review;
  return {
    kind: urgent > 0 ? "urgent" : "review",
    text: `${count(shown)}${unsure ? " ?" : ""}`,
    label,
    tooltip,
    unsure,
  };
}

/** The summary, refreshed every minute while the tab is visible and on focus. */
export function useAeAttention(): AeAttentionView {
  const { data, isError } = useQuery({
    queryKey: AE_ATTENTION_QUERY_KEY,
    queryFn: fetchAeAttentionSummary,
    refetchInterval: AE_ATTENTION_REFETCH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: false,
  });
  return aeAttentionView(data, isError && !data);
}
