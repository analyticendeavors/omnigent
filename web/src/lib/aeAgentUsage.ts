// Token use per agent for the Agents card, the sidebar hover and the family
// pill (omnigent-ae). A session's usage covers its whole subtree, so a lead's
// number already holds its native subagents.

import { useQueries } from "@tanstack/react-query";
import { aeClaudeVersion } from "@/lib/aeClaudeModels";
import { getSessionUsage } from "@/lib/sessionsApi";
import type { ModelUsage } from "@/lib/types";

export type AeModelFamily = "fable" | "opus" | "sonnet" | "haiku" | "codex" | "other";

export const AE_MODEL_FAMILIES: readonly AeModelFamily[] = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
  "codex",
  "other",
];

export const AE_MODEL_FAMILY_NAMES: Record<AeModelFamily, string> = {
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  codex: "Codex",
  other: "Other",
};

/** Bar and dot colors: the Claude ones match the model dots in Settings. */
export const AE_MODEL_FAMILY_BG: Record<AeModelFamily, string> = {
  fable: "bg-violet-400",
  opus: "bg-amber-400",
  sonnet: "bg-blue-400",
  haiku: "bg-emerald-400",
  codex: "bg-sky-400",
  other: "bg-muted-foreground",
};

export function aeModelFamily(model: string): AeModelFamily {
  const alias = model.trim().toLowerCase();
  if (alias === "fable" || alias === "opus" || alias === "sonnet" || alias === "haiku")
    return alias;
  const family = aeClaudeVersion(model)?.family;
  if (family === "fable" || family === "opus" || family === "sonnet" || family === "haiku") {
    return family;
  }
  return /gpt|codex|^o\d/i.test(model) ? "codex" : "other";
}

/** Input plus output tokens of one model's usage. */
export function aeModelTokens(usage: ModelUsage): number {
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/** Tokens per model family, summed over a usage map. */
export function aeTokensByFamily(
  usage: Record<string, ModelUsage> | null | undefined,
): Partial<Record<AeModelFamily, number>> {
  const out: Partial<Record<AeModelFamily, number>> = {};
  for (const [model, row] of Object.entries(usage ?? {})) {
    const family = aeModelFamily(model);
    out[family] = (out[family] ?? 0) + aeModelTokens(row);
  }
  return out;
}

/** Input plus output tokens over a usage map, or null when none is known. */
export function aeUsageTokens(usage: Record<string, ModelUsage> | null | undefined): number | null {
  if (!usage || Object.keys(usage).length === 0) return null;
  return Object.values(usage).reduce((sum, row) => sum + aeModelTokens(row), 0);
}

export interface AeSessionUsage {
  tokens: number | null;
  byFamily: Partial<Record<AeModelFamily, number>>;
  effort: string | null;
  /** The model the session runs on, or null when the read does not say. */
  model: string | null;
}

const USAGE_STALE_MS = 30_000;

export interface AeUsageRequest {
  id: string;
  /** Part of the query key: a new stamp (a status change) reads again. */
  stamp: string | number;
  /** The session has stopped: read once and keep it, never poll. */
  done?: boolean;
}

/**
 * Usage of each session listed. A finished one is read once; the others read
 * again after `staleMs` and, while *live*, every `pollMs` (never faster).
 */
export function useAeSessionUsages(
  sessions: readonly AeUsageRequest[],
  {
    enabled = true,
    live = false,
    staleMs = USAGE_STALE_MS,
    pollMs = USAGE_STALE_MS,
  }: { enabled?: boolean; live?: boolean; staleMs?: number; pollMs?: number } = {},
): Map<string, AeSessionUsage> {
  const results = useQueries({
    queries: sessions.map((s) => ({
      queryKey: ["ae-session-usage", s.id, s.stamp],
      queryFn: ({ signal }: { signal: AbortSignal }) => getSessionUsage(s.id, { signal }),
      enabled,
      staleTime: s.done ? Number.POSITIVE_INFINITY : staleMs,
      refetchInterval: live && !s.done ? pollMs : false,
      retry: false,
      placeholderData: (previous: unknown) => previous as never,
    })),
  });
  const out = new Map<string, AeSessionUsage>();
  results.forEach((result, index) => {
    const data = result.data;
    if (!data) return;
    out.set(sessions[index].id, {
      tokens: aeUsageTokens(data.usageByModel),
      byFamily: aeTokensByFamily(data.usageByModel),
      model: data.model,
      effort:
        data.reasoningEffort && data.reasoningEffort !== "default" ? data.reasoningEffort : null,
    });
  });
  return out;
}
