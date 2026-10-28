// The rows of the action dock's limit hover card: every window on the chat's
// login, headline windows first, then the per-model weekly rows. omnigent-ae,
// 2026-10-28.

import type { AeLimitWindow } from "@/components/AePlanLimits";
import { AE_LIMIT_GATE_PERCENT, type AeLimitGate, aeHeadlineWindows } from "@/lib/aeLimitGate";

/** Where the bar's colour changes: red at the gate's own threshold, amber from 70. */
const AMBER_PERCENT = 70;

export type AeLimitLevel = "warn" | "mid" | "ok";

export interface AeLimitHoverRow {
  id: string;
  /** "5-hour", "Weekly · all models", "Weekly · Sonnet". */
  label: string;
  /** Whole percent, as the usage popover rounds it. */
  percent: number;
  resetsAt: string | null;
  /** The window that raised the dock's warning. */
  isGate: boolean;
  level: AeLimitLevel;
}

export function aeLimitLevel(percent: number): AeLimitLevel {
  if (percent >= AE_LIMIT_GATE_PERCENT) return "warn";
  return percent >= AMBER_PERCENT ? "mid" : "ok";
}

/** The server labels a weekly row "Weekly, Sonnet"; the popover reads "Weekly · Sonnet". */
function rowLabel(w: AeLimitWindow): string {
  return w.label.replace(/^(Weekly), /, "$1 · ");
}

/**
 * The 5-hour window, the all-models weekly window, then every other window
 * fullest first. Windows with no usable percentage are left out.
 */
export function aeLimitHoverRows(
  windows: readonly AeLimitWindow[],
  gate: AeLimitGate,
): AeLimitHoverRow[] {
  const usable = windows.filter((w) => Number.isFinite(w.used_percent));
  const { five, week } = aeHeadlineWindows(usable);
  const head = [five, week].filter((w): w is AeLimitWindow => w !== null);
  const rest = usable
    .filter((w) => !head.includes(w))
    .sort((a, b) => b.used_percent - a.used_percent);
  return [...head, ...rest].map((w) => {
    const percent = Math.round(w.used_percent);
    return {
      id: w.id,
      label: rowLabel(w),
      percent,
      resetsAt: w.resets_at,
      isGate: w.id === gate.windowId,
      level: aeLimitLevel(percent),
    };
  });
}
