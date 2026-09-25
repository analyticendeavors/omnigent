// The context ring's colour as the context window fills. Upstream draws
// `ComposerContextRing` in grayscale on purpose (a near-full context is a
// neutral fact, not an error). Reid asked on 2026-09-24 for the cue Claude Code
// desktop gives instead: the ring turns a warning colour as the window
// approaches full, so a compaction or a fresh session is not a surprise.
// omnigent-ae patch P18; the plan limits popover (P6, P9) tones its Context
// window bar with the same function so the ring and the bar always agree.

/** Same three steps as the popover's `limitTone`, so one colour map serves both. */
export type AeTone = "normal" | "warning" | "critical";

/** Warning from this percentage of the context window used. */
export const AE_CONTEXT_WARNING_PCT = 60;
/** Critical from this percentage. */
export const AE_CONTEXT_CRITICAL_PCT = 80;

/**
 * Tone for a context window `pct` (0 to 100) used.
 *
 * Earlier than the plan limit bars (70 and 90, `limitTone`): a context fills
 * inside one session and the harness compacts before 100%, while a plan limit
 * only stops work at 100%. Decided on the rounded percentage, the number the
 * ring's tooltip and the popover print, so "60%" is never shown in grey.
 */
export function contextTone(pct: number): AeTone {
  const shown = Math.round(pct);
  if (shown >= AE_CONTEXT_CRITICAL_PCT) return "critical";
  if (shown >= AE_CONTEXT_WARNING_PCT) return "warning";
  return "normal";
}

/**
 * Text colour for the ring's used arc (its stroke is `currentColor`). Normal
 * adds nothing, so the arc keeps the ring's own `text-muted-foreground`. The
 * theme's warning and destructive tokens are defined for light and dark mode.
 */
const RING_TEXT: Record<AeTone, string | undefined> = {
  normal: undefined,
  warning: "text-warning",
  critical: "text-destructive",
};

/** Class for the used arc of `ComposerContextRing` at `pct` (0 to 100) used. */
export function aeContextRingClass(pct: number): string | undefined {
  return RING_TEXT[contextTone(pct)];
}
