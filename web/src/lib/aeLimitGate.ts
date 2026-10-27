// The usage gate: when the account a chat runs on reaches
// AE_LIMIT_GATE_PERCENT of its 5-hour or weekly window, the action dock offers
// a way out (another model, another account, a new chat) before the session
// runs into the limit. It never blocks sending. Pure, so the threshold, the
// window pick and the dismiss rule are unit-tested (aeLimitGate.test.ts).
// Fed by the session's own `GET /v1/ae/limits?session_id=` answer, which
// already carries the windows of the account that session runs on.
// omnigent-ae, 2026-10-21.

import type { AeHarness, AeLimitWindow, AeLimitsAnswer } from "@/components/AePlanLimits";

/** The gate's one step: either headline window at or past this percent. */
export const AE_LIMIT_GATE_PERCENT = 90;

const FIVE_HOUR_MINUTES = 300;
const WEEK_MINUTES = 7 * 24 * 60;
const HOUR_MS = 3_600_000;

/** What the server calls the default CLI login when it has no label for it. */
export const AE_DEFAULT_ACCOUNT_LABEL = "Default CLI account";

export type AeLimitSpan = "5-hour" | "weekly";

export interface AeLimitGate {
  harness: AeHarness;
  /** The backup account name; null is the default login (or Codex's one login). */
  account: string | null;
  /** "AE Default", "Default CLI account", "Codex". */
  label: string;
  windowId: string;
  /** The window across sessions: harness, account and window id. */
  windowKey: string;
  span: AeLimitSpan;
  /** Whole percent, rounded as the usage popover rounds it. */
  percent: number;
  resetsAt: string | null;
}

/** One dismissed window and the reset it was dismissed for. */
export interface AeLimitDismissal {
  window: string;
  resets: number | null;
}

/**
 * The 5-hour and the weekly window, as the server's `headline_windows` picks
 * them: Claude's by id (`five_hour`, `seven_day`; never a per-model weekly
 * row), Codex's by length, the first of each.
 */
export function aeHeadlineWindows(windows: readonly AeLimitWindow[]): {
  five: AeLimitWindow | null;
  week: AeLimitWindow | null;
} {
  const five =
    windows.find((w) => w.id === "five_hour") ??
    windows.find((w) => w.window_minutes === FIVE_HOUR_MINUTES) ??
    null;
  const week =
    windows.find((w) => w.id === "seven_day") ??
    windows.find((w) => w.window_minutes === WEEK_MINUTES && !w.id.startsWith("seven_day")) ??
    null;
  return { five, week };
}

function resetMs(resetsAt: string | null): number | null {
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

export function aeLimitWindowKey(
  harness: AeHarness,
  account: string | null,
  windowId: string,
): string {
  return [harness, account ?? "", windowId].join("|");
}

/**
 * Whether this window's reading falls under a standing dismissal. Readings
 * of one window differ by seconds; the next window resets at least five
 * hours later, so a reset within the hour is the same window.
 */
export function aeLimitDismissed(
  dismissed: readonly AeLimitDismissal[],
  windowKey: string,
  resetsAt: string | null,
): boolean {
  const at = resetMs(resetsAt);
  return dismissed.some(
    (d) =>
      d.window === windowKey &&
      (d.resets === null || at === null ? d.resets === at : Math.abs(d.resets - at) < HOUR_MS),
  );
}

/** Dismissals kept: both windows of a few accounts. */
export const AE_LIMIT_GATE_DISMISS_KEEP = 8;

/** The dismissals after one more; a window keeps only its newest. */
export function aeLimitGateDismiss(
  dismissed: readonly AeLimitDismissal[],
  gate: AeLimitGate,
): AeLimitDismissal[] {
  return [
    ...dismissed.filter((d) => d.window !== gate.windowKey),
    { window: gate.windowKey, resets: resetMs(gate.resetsAt) },
  ].slice(-AE_LIMIT_GATE_DISMISS_KEEP);
}

/**
 * The gate for one session's limits answer, or null when no window is at
 * the threshold and not dismissed. The fullest of those windows wins, so a
 * dismissed 5-hour gate never hides a weekly one; on a tie, the one that
 * resets later (the longer wait). A window whose reset has passed waits for
 * a new reading.
 */
export function aeLimitGate(
  answer: AeLimitsAnswer | null | undefined,
  harness: AeHarness | null,
  now: number,
  dismissed: readonly AeLimitDismissal[] = [],
  threshold: number = AE_LIMIT_GATE_PERCENT,
): AeLimitGate | null {
  if (!harness) return null;
  const snapshot = answer?.harnesses?.[harness];
  if (!snapshot || !Array.isArray(snapshot.windows)) return null;
  const account = snapshot.account ?? null;
  const { five, week } = aeHeadlineWindows(snapshot.windows);
  let pick: { window: AeLimitWindow; span: AeLimitSpan } | null = null;
  for (const [window, span] of [
    [five, "5-hour"],
    [week, "weekly"],
  ] as const) {
    if (!window || !Number.isFinite(window.used_percent)) continue;
    if (window.used_percent < threshold) continue;
    const at = resetMs(window.resets_at);
    if (at !== null && at <= now) continue;
    if (
      aeLimitDismissed(dismissed, aeLimitWindowKey(harness, account, window.id), window.resets_at)
    )
      continue;
    const laterReset = pick !== null && (at ?? 0) > (resetMs(pick.window.resets_at) ?? 0);
    if (
      !pick ||
      window.used_percent > pick.window.used_percent ||
      (window.used_percent === pick.window.used_percent && laterReset)
    ) {
      pick = { window, span };
    }
  }
  if (!pick) return null;
  const fallback = harness === "codex" ? "Codex" : (account ?? AE_DEFAULT_ACCOUNT_LABEL);
  return {
    harness,
    account,
    label: snapshot.account_label?.trim() || fallback,
    windowId: pick.window.id,
    windowKey: aeLimitWindowKey(harness, account, pick.window.id),
    span: pick.span,
    percent: Math.round(pick.window.used_percent),
    resetsAt: pick.window.resets_at,
  };
}

/** "9:00 AM" today, "Thu 9:00 AM" on another day, in the viewer's clock. */
export function aeLimitResetClock(iso: string, now: number): string {
  const date = new Date(iso);
  const clock = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (new Date(now).toDateString() === date.toDateString()) return clock;
  return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${clock}`;
}

/** "AE Default is at 92% of its weekly limit, resets Thu 09:00". */
export function aeLimitGateText(
  gate: AeLimitGate,
  now: number,
  clock: (iso: string, now: number) => string = aeLimitResetClock,
): string {
  const head = `${gate.label} is at ${gate.percent}% of its ${gate.span} limit`;
  const at = gate.resetsAt ? Date.parse(gate.resetsAt) : Number.NaN;
  return Number.isFinite(at) ? `${head}, resets ${clock(gate.resetsAt!, now)}` : head;
}

/** The phone line and the badge: "92% weekly". */
export function aeLimitGateShort(gate: AeLimitGate): string {
  return `${gate.percent}% ${gate.span}`;
}

/** The fields of a detected credential row the account check reads. */
export interface AeLimitCredentialRow {
  family: string;
  env_var?: string | null;
}

/**
 * Whether the host offers a Claude login other than the one this session
 * runs on, so a fork onto another account has somewhere to go. Mirrors the
 * fork dialog's account row: none on a host signed in with provider
 * credentials. `currentAccount` is the session's account label; without
 * one the session runs on the host's active login.
 */
export function aeHasOtherClaudeAccount(
  rows: readonly AeLimitCredentialRow[],
  currentAccount: string | null | undefined,
): boolean {
  if (rows.some((row) => row.family.startsWith("claude-provider"))) return false;
  const logins = rows.filter((row) => row.family.startsWith("claude-oauth"));
  const active = logins.find((row) => row.family === "claude-oauth-active");
  const current = currentAccount ?? active?.env_var ?? "";
  return logins.some((row) => (row.env_var ?? "") !== current);
}

/**
 * The Claude login new chats start on: the host's selected row (`""` is the
 * default login), as the account picker shows it. `undefined` when the host
 * lists no Claude login or the chat runs on a provider gateway, where no login
 * names the chat's account.
 */
export function aePickedClaudeAccount(rows: readonly AeLimitCredentialRow[]): string | undefined {
  if (rows.some((row) => row.family.startsWith("claude-provider"))) return undefined;
  const logins = rows.filter((row) => row.family.startsWith("claude-oauth"));
  if (logins.length === 0) return undefined;
  return logins.find((row) => row.family === "claude-oauth-active")?.env_var ?? "";
}
