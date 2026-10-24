// What the spend pills show (omnigent-ae, 2026-10-24): tokens, the estimated
// cost, or nothing. Device-local. Tokens are the default because an OAuth
// (subscription) account does not pay the API-price estimate the cost shows.

import { useSyncExternalStore } from "react";
import { aeFormatCost, aeFormatTokens } from "@/lib/aeAgentRole";
import { aeSpendOf, type AeSessionUsage } from "@/lib/aeAgentUsage";
import type { ModelUsage } from "@/lib/types";

const STORAGE_KEY = "omnigent:ae-spend-display";

export type AeSpendDisplay = "tokens" | "cost" | "off";
export const AE_SPEND_DISPLAYS: readonly AeSpendDisplay[] = ["tokens", "cost", "off"];
export const DEFAULT_AE_SPEND_DISPLAY: AeSpendDisplay = "tokens";

export function readAeSpendDisplay(): AeSpendDisplay {
  if (typeof window === "undefined") return DEFAULT_AE_SPEND_DISPLAY;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return AE_SPEND_DISPLAYS.includes(stored as AeSpendDisplay)
      ? (stored as AeSpendDisplay)
      : DEFAULT_AE_SPEND_DISPLAY;
  } catch {
    return DEFAULT_AE_SPEND_DISPLAY;
  }
}

const listeners = new Set<() => void>();

export function writeAeSpendDisplay(value: AeSpendDisplay): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // A local view preference; losing it is harmless.
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

export function useAeSpendDisplay(): AeSpendDisplay {
  return useSyncExternalStore(subscribe, readAeSpendDisplay, () => DEFAULT_AE_SPEND_DISPLAY);
}

export interface AeTokenStats {
  /** New input plus output; cache reads are not counted. */
  spent: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Some row reported cache writes; the server folds them into input otherwise. */
  cacheWriteKnown: boolean;
  /** Every model row reported tokens. */
  complete: boolean;
}

/** Token counts over the model rows that have them, or null when none does. */
export function aeTokenStats(
  byModel: Record<string, ModelUsage> | null | undefined,
): AeTokenStats | null {
  let found = false;
  let complete = true;
  let cacheWriteKnown = false;
  const stats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const row of Object.values(byModel ?? {})) {
    if (row.inputTokens == null && row.outputTokens == null) {
      complete = false;
      continue;
    }
    found = true;
    stats.input += row.inputTokens ?? 0;
    stats.output += row.outputTokens ?? 0;
    stats.cacheRead += row.cacheReadInputTokens ?? 0;
    stats.cacheWrite += row.cacheCreationInputTokens ?? 0;
    if (row.cacheCreationInputTokens != null) cacheWriteKnown = true;
  }
  if (!found) return null;
  return {
    ...stats,
    spent: stats.input + stats.cacheWrite + stats.output,
    cacheWriteKnown,
    complete,
  };
}

/** New input plus output tokens of one session, or null when it has no count. */
export function aeUsageSpentTokens(usage: AeSessionUsage): number | null {
  return aeTokenStats(usage.byModel)?.spent ?? usage.tokens ?? null;
}

/** "input 150k, output 20k, cache reads 1.2M, cache writes 40k". */
export function aeTokenBreakdown(stats: AeTokenStats): string {
  return [
    `input${stats.cacheWriteKnown ? "" : " (incl. cache writes)"} ${aeFormatTokens(stats.input)}`,
    `output ${aeFormatTokens(stats.output)}`,
    `cache reads ${aeFormatTokens(stats.cacheRead)}`,
    stats.cacheWriteKnown ? `cache writes ${aeFormatTokens(stats.cacheWrite)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

export interface AeSpendLabel {
  /** Pill text, e.g. "212k tok" or "$1.64". */
  text: string;
  /** Sentence form, e.g. "212k tokens" or "$1.64". */
  long: string;
  title: string;
  /** Cost mode: what the number is, for a title built around the pill's own "+". */
  unit: "estimated" | "tokens";
}

/**
 * The one formatter behind every spend pill. Cost mode is the old behavior;
 * tokens mode sums the sessions that have counts and marks the total with "+"
 * when some do not (or when `extraMissing` says more sessions are unread).
 */
export function aeSpendLabel(
  usages: Iterable<AeSessionUsage>,
  mode: AeSpendDisplay,
  omitted = 0,
): AeSpendLabel | null {
  if (mode === "off") return null;
  const list = [...usages];
  if (mode === "cost") {
    const spend = aeSpendOf(list);
    if (!spend) return null;
    const text = spend.kind === "cost" ? aeFormatCost(spend.value) : aeFormatTokens(spend.value);
    const long = spend.kind === "cost" ? text : `${text} tokens`;
    const unit = spend.kind === "cost" ? "estimated" : "tokens";
    return { text, long, title: `${text} ${unit}`, unit };
  }
  let spent = 0;
  let missing = omitted;
  let cacheWriteKnown = false;
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const usage of list) {
    const stats = aeTokenStats(usage.byModel);
    const own = stats?.spent ?? usage.tokens ?? null;
    if (own === null || (stats && !stats.complete)) missing += 1;
    if (own === null) continue;
    spent += own;
    if (stats) {
      sum.input += stats.input;
      sum.output += stats.output;
      sum.cacheRead += stats.cacheRead;
      sum.cacheWrite += stats.cacheWrite;
      cacheWriteKnown ||= stats.cacheWriteKnown;
    }
  }
  if (spent <= 0) return null;
  const plus = missing > 0 ? "+" : "";
  const text = `${aeFormatTokens(spent)}${plus}`;
  const note =
    missing > 0 ? ` · ${missing} session${missing === 1 ? " has" : "s have"} no token count` : "";
  return {
    text: `${text} tok`,
    long: `${text} tokens`,
    unit: "tokens",
    title: `${text} tokens: ${aeTokenBreakdown({ ...sum, spent, cacheWriteKnown, complete: true })}${note}`,
  };
}
