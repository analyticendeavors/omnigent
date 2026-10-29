// Plan usage behind the composer's context ring: what Claude Code's own usage
// popover shows (the session's context window, the 5-hour window, the weekly
// windows for all models and per model, usage credits, the plan) and the
// Codex equivalent, one click away instead of the `>_` terminal. The numbers
// come from `GET /v1/ae/limits`, which the box host's relay fills every five
// minutes from Claude Code's statusLine payload, the CLI's `get_usage` control
// request and `codex app-server` (omnigent-ae
// `packages/ae_omni_policies/src/ae_omni_policies/limits.py`,
// docs/PLAN-LIMITS.md). omnigent-ae patch P6, 2026-09-24; the context row,
// per-model rows, credits and plan added the same day in a second pass.
//
// The popover is the short view: the context window as one bar (Claude's
// categories when a fresh snapshot exists, else the prompt cache parts), the
// running agents as lanes under it, and the session's own plan. The session
// rail holds the rest; the button at the bottom opens it on Context.

import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useAePickedClaudeAccount } from "@/hooks/useAePickedClaudeAccount";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import { type AeTone, contextTone } from "@/lib/aeContextTone";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import { authenticatedFetch } from "@/lib/identity";
import { isTempConvId } from "@/lib/tempConversationId";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";
import { AeRailIcon } from "./aeRail/aeRailUi";
import { type AeLimitAccountRow, AeLimitsAccountMenu, aeAccountKey } from "./AeLimitsAccountMenu";
import {
  type AeContextEntry,
  type AeContextReading,
  type AeSessionContextsState,
  aeLimitsHarnessFor,
  aeModelName,
  buildActiveContext,
  buildCollaboratorContext,
  useAeSessionContexts,
} from "./aeSessionContext";
import { AeCategoryBar, AeCategoryLegend } from "./AeContextCategories";
import {
  type AeContextSnapshotState,
  aeContextIdentity,
  contextCountdown,
  type ContextUsage,
  useAeContextSnapshot,
} from "./aeContextUsage";

export const AE_LIMITS_PATH = "/v1/ae/limits";

export type AeHarness = "claude" | "codex";

export interface AeLimitWindow {
  id: string;
  label: string;
  used_percent: number;
  resets_at: string | null;
  window_minutes: number | null;
}

/** Usage credits in minor units of `currency` (cents for USD); `limit_minor` null = no cap. */
export interface AeCredits {
  enabled: boolean;
  used_minor: number | null;
  limit_minor: number | null;
  used_percent: number | null;
  currency: string;
}

/** One Claude session's context from its last status line (`context_window.current_usage`). */
export interface AeSessionContext {
  conversation_id: string;
  observed_at: string;
  model: string | null;
  window_size: number;
  used_tokens: number;
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
}

export interface AeLimitSnapshot {
  harness: AeHarness;
  source: string;
  observed_at: string;
  received_at?: string;
  plan: string | null;
  windows: AeLimitWindow[];
  note: string | null;
  // Absent from a server older than the second pass.
  credits?: AeCredits | null;
  contexts?: AeSessionContext[];
  hint?: string | null;
  // Absent from a server older than per-session accounts.
  /** The backup account this answer is for; null or absent = the box's default login. */
  account?: string | null;
  account_label?: string | null;
}

export interface AeLimitsAnswer {
  now: string;
  harnesses: Partial<Record<AeHarness, AeLimitSnapshot | null>>;
}

export const AE_HARNESS_NAMES: Record<AeHarness, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3m", "2h 10m", "3d 4h": the coarse duration a person reads at a glance. */
export function formatDuration(ms: number): string {
  const abs = Math.max(0, ms);
  if (abs < MINUTE) return "<1m";
  if (abs < HOUR) return `${Math.floor(abs / MINUTE)}m`;
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.floor((abs % HOUR) / MINUTE);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** "just now", "4m ago", "2h 5m ago". */
export function formatAgo(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < MINUTE) return "just now";
  return `${formatDuration(ms)} ago`;
}

/** The reset as clock time (with the weekday past today) plus how long until it. */
export function formatReset(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  if (at <= now) return "Window reset; waiting for a new reading";
  const date = new Date(at);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const clock = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const when = sameDay
    ? clock
    : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${clock}`;
  return `Resets ${when} (in ${formatDuration(at - now)})`;
}

/** "950", "12.4k", "216.8k", "1M": token counts as the usage popover prints them. */
export function formatTokens(n: number): string {
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

/** Minor units (7881 cents) as money ("$78.81"), with the currency's own decimals. */
export function formatMoney(minor: number, currency: string): string {
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(undefined, { style: "currency", currency });
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minor / 10 ** digits);
}

/**
 * Bar colour: the ring's own steps (`contextTone`, 60 and 80), a little later
 * because a limit is not a context.
 */
export function limitTone(pct: number): AeTone {
  if (pct >= 90) return "critical";
  if (pct >= 70) return "warning";
  return "normal";
}

/**
 * With a session id the server answers for the account that session runs on.
 * `account` is the login picked for new chats (`""` for the default login): the
 * server uses it for a chat it has no reading for yet, and ignores it once the
 * chat has one. With no session (or a new chat's `temp:` id) the server
 * answers for that login alone, which the card's subscription switcher uses.
 */
export async function fetchAeLimits(
  sessionId?: string | null,
  account?: string | null,
): Promise<AeLimitsAnswer> {
  const params: string[] = [];
  // A new chat's `temp:` id names no server session: ask for the picked login alone.
  if (sessionId && !isTempConvId(sessionId)) {
    params.push(`session_id=${encodeURIComponent(sessionId)}`);
  }
  if (account != null) params.push(`account=${encodeURIComponent(account)}`);
  const path = params.length ? `${AE_LIMITS_PATH}?${params.join("&")}` : AE_LIMITS_PATH;
  const res = await authenticatedFetch(path, { method: "GET" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
  return (await res.json()) as AeLimitsAnswer;
}

/** The first account hint seen per session: a later pick changes new chats, not this one. */
const frozenAccounts = new Map<string, string>();
const FROZEN_ACCOUNTS_KEEP = 200;

function freezeAccount(sessionId: string | null | undefined, account: string | undefined) {
  // A new chat's pick can still change, so its hint is not frozen.
  if (!sessionId || isTempConvId(sessionId)) return account;
  const held = frozenAccounts.get(sessionId);
  if (held !== undefined || account === undefined) return held;
  frozenAccounts.set(sessionId, account);
  if (frozenAccounts.size > FROZEN_ACCOUNTS_KEEP) {
    frozenAccounts.delete(frozenAccounts.keys().next().value as string);
  }
  return account;
}

/**
 * The reset as a row shows it: a countdown within a day ("Resets in 21m"),
 * else the weekday and time ("Resets Wed 4:00 AM"), past a week the date.
 * The full `formatReset` text is the row's title.
 */
export function formatResetShort(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  if (at <= now) return "Waiting for a new reading";
  if (at - now < DAY) return `Resets in ${formatDuration(at - now)}`;
  const date = new Date(at);
  const clock = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day =
    at - now < 7 * DAY
      ? date.toLocaleDateString(undefined, { weekday: "short" })
      : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `Resets ${day} ${clock}`;
}

/** `formatMoney` without a whole amount's zero cents: "$0", "$200", but "$78.81". */
export function formatMoneyShort(minor: number, currency: string): string {
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(undefined, { style: "currency", currency });
  } catch {
    return formatMoney(minor, currency);
  }
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  if (minor % 10 ** digits !== 0) return format.format(minor / 10 ** digits);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(minor / 10 ** digits);
}

/** Claude Desktop's words for the all-models window; every other label as the server sends it. */
export function windowLabel(w: AeLimitWindow): string {
  return w.label === "Weekly, all models" ? "Weekly · all models" : w.label;
}

/** Fill per tone; normal is Claude Desktop's blue (the first chart colour). */
const TONE_BAR: Record<AeTone, string> = {
  normal: "bg-chart-1",
  warning: "bg-warning",
  critical: "bg-destructive",
};

/** A stale reading, or a window past its reset: still drawn, greyed. */
const MUTED_BAR = "bg-foreground/25";

/** A toned percentage as text: an amber that reads on white, unlike the ring's. */
const TONE_TEXT: Record<AeTone, string | undefined> = {
  normal: undefined,
  warning: "text-amber-700 dark:text-amber-400",
  critical: "text-destructive",
};

/** Tabler's `info-circle` (@tabler/icons 3.46.0), inlined for the section toggles. */
const INFO_ICON: AeTablerIconNode = [
  ["path", { d: "M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" }],
  ["path", { d: "M12 9h.01" }],
  ["path", { d: "M11 12h1v4h1" }],
];

const CONTEXT_INFO = "Per session and model; one session's window does not include another's.";
const PLAN_INFO = "Account-wide; shared by every session on that plan.";

interface Segment {
  key: string;
  className: string;
  /** This segment's share of the fill, 0 to 1. */
  share: number;
}

/**
 * A bar: the track, and a fill `pct` wide made of one segment or of the
 * prompt cache's parts joined end to end, each its `share` of the fill.
 */
function Meter({
  label,
  pct,
  segments,
  thick = false,
}: {
  label: string;
  pct: number;
  segments: Segment[];
  thick?: boolean;
}) {
  const rounded = Math.round(pct);
  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-full bg-foreground/10",
        thick ? "h-1.5" : "h-1",
      )}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(rounded, 100)}
    >
      <div
        className="flex h-full gap-px overflow-hidden rounded-full"
        data-testid="ae-meter-fill"
        style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }}
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            data-segment={segment.key}
            className={cn("h-full min-w-0", segment.className)}
            style={{ flexGrow: segment.share, flexBasis: 0 }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * A section's header row: a muted title, an info toggle whose explainer opens
 * under the row (a tap, so it works on a phone), and a value on the right.
 */
function SectionHeader({
  title,
  tag,
  control,
  right,
  info,
  infoLabel,
  infoOpen,
  onInfoOpenChange,
}: {
  title: ReactNode;
  tag?: ReactNode;
  /** A control that stays whole beside the title; the title truncates first (omnigent-ae, 2026-10-28). */
  control?: ReactNode;
  right?: ReactNode;
  info?: string;
  infoLabel?: string;
  infoOpen?: boolean;
  onInfoOpenChange?: (open: boolean) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = infoOpen ?? ownOpen;
  const setOpen = onInfoOpenChange ?? setOwnOpen;
  const infoId = useId();
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <h3
          className={cn(
            "flex min-w-0 items-center gap-1 text-sm font-medium text-foreground",
            control && "flex-1",
          )}
        >
          <span className={cn("min-w-0 truncate", control && "shrink-0")}>{title}</span>
          {info && (
            <button
              type="button"
              aria-label={infoLabel}
              aria-expanded={open}
              aria-controls={infoId}
              data-testid="ae-limits-info-toggle"
              className="-my-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:text-foreground"
              onClick={() => setOpen(!open)}
            >
              <AeTablerSvg node={INFO_ICON} className="size-3.5" />
            </button>
          )}
          {tag}
          {control}
        </h3>
        {right && <span className="ml-auto shrink-0">{right}</span>}
      </div>
      {info && (
        <p
          id={infoId}
          hidden={!open}
          className="text-sm text-muted-foreground"
          data-testid="ae-limits-info"
        >
          {info}
        </p>
      )}
    </div>
  );
}

/**
 * One limit on Claude Desktop's two lines: the label, then the reset and the
 * percentage on the right (wrapping under the label on a narrow phone), and
 * the bar under them. The full reset is the row's title.
 */
function LimitRow({
  id,
  label,
  value,
  pct,
  reset,
  resetFull,
  muted = false,
  testId = "ae-limit-window",
}: {
  id: string;
  label: string;
  value: string;
  pct: number;
  reset?: string | null;
  resetFull?: string | null;
  muted?: boolean;
  testId?: string;
}) {
  return (
    <li
      className="flex flex-col gap-1"
      data-testid={testId}
      data-window={id}
      title={resetFull ?? undefined}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="min-w-0 max-w-full truncate">{label}</span>
        <span className="ml-auto flex shrink-0 items-baseline gap-3">
          {reset && <span className="text-sm text-muted-foreground">{reset}</span>}
          <span
            className={cn("min-w-10 text-right tabular-nums", muted && "text-muted-foreground")}
          >
            {value}
          </span>
        </span>
      </div>
      <Meter
        label={`${label}: ${Math.round(pct)}% used${resetFull ? `. ${resetFull}` : ""}`}
        pct={pct}
        segments={[
          { key: "used", className: muted ? MUTED_BAR : TONE_BAR[limitTone(pct)], share: 1 },
        ]}
      />
    </li>
  );
}

/** One plan window; `short` drops the "Resets" word where the rail is narrow. */
export function AeLimitWindowRow({
  window: w,
  now,
  short = false,
}: {
  window: AeLimitWindow;
  now: number;
  short?: boolean;
}) {
  const passed = w.resets_at !== null && Date.parse(w.resets_at) <= now;
  const reset = formatResetShort(w.resets_at, now);
  return (
    <LimitRow
      id={w.id}
      label={windowLabel(w)}
      value={`${Math.round(w.used_percent)}%`}
      pct={w.used_percent}
      reset={short && reset ? reset.replace(/^Resets /, "") : reset}
      resetFull={formatReset(w.resets_at, now)}
      muted={passed}
    />
  );
}

export function AeCreditsRow({ credits, now }: { credits: AeCredits; now: number }) {
  const used = credits.used_minor;
  if (!credits.enabled) {
    return (
      <li className="flex items-baseline justify-between gap-2" data-testid="ae-limit-credits">
        <span>Usage credits</span>
        <span className="text-sm text-muted-foreground">Off</span>
      </li>
    );
  }
  if (used === null) return null;
  if (credits.limit_minor === null) {
    return (
      <li className="flex items-baseline justify-between gap-2" data-testid="ae-limit-credits">
        <span>Usage credits</span>
        <span className="tabular-nums">{formatMoneyShort(used, credits.currency)} spent</span>
      </li>
    );
  }
  const cap = credits.limit_minor;
  const pct = credits.used_percent ?? (cap > 0 ? (used / cap) * 100 : 0);
  // Credits reset with the calendar month (Claude Code's own /usage row); the
  // row keeps that for its title, as Claude Desktop shows only the amounts.
  const month = new Date(now);
  const reset = new Date(month.getFullYear(), month.getMonth() + 1, 1).toISOString();
  return (
    <LimitRow
      id="credits"
      label="Usage credits"
      value={`${formatMoneyShort(used, credits.currency)} of ${formatMoneyShort(cap, credits.currency)}`}
      pct={pct}
      resetFull={formatReset(reset, now)}
    />
  );
}

/**
 * How the used tokens were sent on the session's last request (read from the
 * prompt cache, written to it, or new). Since P18 each part has its own chart
 * colour, never the warning or destructive ones; since 2026-10-14 the parts
 * are joined segments of the context bar itself, after Claude Desktop, and
 * this legend is their key. It is not a /context-style breakdown by system
 * prompt, tools and messages: the status line carries only these three counts.
 */
const CONTEXT_PARTS = [
  { key: "cache_read_tokens", label: "cached", className: "bg-chart-1" },
  { key: "cache_write_tokens", label: "written", className: "bg-chart-3" },
  { key: "input_tokens", label: "new", className: "bg-chart-5" },
] as const;

const CONTEXT_BREAKDOWN_CAPTION = "How those tokens were billed (prompt cache)";

function contextParts(context: AeSessionContext | null) {
  return context ? CONTEXT_PARTS.filter((part) => context[part.key] > 0) : [];
}

/**
 * The context bar's segments. The breakdown can lag the live figure, so each
 * part takes its share of the breakdown, never its raw count. Near full (the
 * ring's warning steps) the bar is one toned fill, as the ring is.
 */
function contextSegments(
  pct: number,
  stale: boolean,
  breakdown: AeSessionContext | null,
): Segment[] {
  const tone = contextTone(pct);
  if (stale) return [{ key: "used", className: MUTED_BAR, share: 1 }];
  const parts = contextParts(breakdown);
  const total = parts.reduce((sum, part) => sum + breakdown![part.key], 0);
  if (tone !== "normal" || total === 0) {
    return [{ key: "used", className: TONE_BAR[tone], share: 1 }];
  }
  return parts.map((part) => ({
    key: part.key,
    className: part.className,
    share: breakdown![part.key] / total,
  }));
}

function ContextLegend({
  context,
  now,
  dots,
}: {
  context: AeSessionContext;
  now: number;
  /** 2026-10-14: off while the bar is one toned or grey fill, which no dot would match. */
  dots: boolean;
}) {
  const parts = contextParts(context);
  if (parts.length === 0) return null;
  return (
    <p
      className="flex flex-wrap gap-x-2.5 text-sm text-muted-foreground"
      data-testid="ae-context-breakdown"
      title={`${CONTEXT_BREAKDOWN_CAPTION}, from the session's status line, ${formatAgo(context.observed_at, now)}`}
    >
      {parts.map((part) => (
        <span key={part.key} className="inline-flex items-center gap-1 tabular-nums">
          {dots && <span className={cn("inline-block size-1.5 rounded-full", part.className)} />}
          {formatTokens(context[part.key])} {part.label}
        </span>
      ))}
    </p>
  );
}

/** Claude Code compacts a native 1M window at about 967k tokens by default (its model-config docs). */
const AE_AUTOCOMPACT_AT_1M = 967_000;

/** "About 524k until auto-compact", for a Claude Code session on a 1M window only. */
function autoCompactText(entry: AeContextEntry, reading: AeContextReading): string | null {
  if (entry.agent !== "Claude Code" || reading.stale || reading.size < 1_000_000) return null;
  const left = AE_AUTOCOMPACT_AT_1M - reading.used;
  if (left <= 0) return "Auto-compact is due";
  if (left < 1000) return "Less than 1k until auto-compact";
  return `About ${Math.round(left / 1000)}k until auto-compact`;
}

function readingDetail(reading: AeContextReading, now: number): string | null {
  if (reading.source === "live") return null;
  if (reading.source === "snapshot") return "As of the session's last reply";
  const ago = reading.observedAt ? formatAgo(reading.observedAt, now) : "earlier";
  return `From Claude Code's status line, ${ago}${reading.stale ? " (may be out of date)" : ""}`;
}

/** "167.4k / 1M (17%)", the percentage in the ring's tone once the window fills. */
function ContextValue({ reading }: { reading: AeContextReading }) {
  const pct = (reading.used / reading.size) * 100;
  return (
    <span
      className={cn("tabular-nums", reading.stale ? "text-muted-foreground" : "text-foreground")}
      data-testid="ae-context-value"
    >
      {formatTokens(reading.used)} / {formatTokens(reading.size)}{" "}
      <span className={reading.stale ? undefined : TONE_TEXT[contextTone(pct)]}>
        ({Math.round(pct)}%)
      </span>
    </span>
  );
}

/** Tabler's `corner-down-right`, the lead-in of each agent lane. */
const LANE_ICON: AeTablerIconNode = [["path", { d: "M6 6v6a3 3 0 0 0 3 3h10l-4 -4m0 8l4 -4" }]];

/** A snapshot, read as the active row's context. */
function snapshotReading(categories: ContextUsage, now: number): AeContextReading {
  return {
    source: "snapshot",
    used: categories.totalTokens,
    size: categories.maxTokens,
    observedAt: categories.observedAt,
    stale: now - Date.parse(categories.observedAt) > 180_000,
  };
}

/**
 * The active session's context window: the header with tokens and percent,
 * one bar, its legend, then `children` (the agent lanes) and the line with the
 * auto-compact countdown, the model and the reading's age.
 */
function ActiveContextRow({
  entry,
  now,
  categories,
  children,
}: {
  entry: AeContextEntry;
  now: number;
  categories?: ContextUsage;
  children?: ReactNode;
}) {
  const who = [entry.agent, aeModelName(entry.model)].filter(Boolean).join(" · ") || null;
  const reading = categories ? snapshotReading(categories, now) : entry.reading;
  const value = reading ? (
    <ContextValue reading={reading} />
  ) : (
    <span className="text-sm text-muted-foreground">No reading yet</span>
  );
  const head = (
    <SectionHeader
      title="Context window"
      info={CONTEXT_INFO}
      infoLabel="About the context window"
      right={value}
    />
  );
  if (!reading) {
    return (
      <>
        <li
          className="flex flex-col gap-1"
          data-testid="ae-context-unavailable"
          data-session={entry.key}
          data-role={entry.role}
        >
          {head}
          <p className="text-sm text-muted-foreground">
            {who && <span data-testid="ae-usage-who">{who}</span>}
            {who && <span aria-hidden="true"> · </span>}
            <span>{entry.unavailable}</span>
          </p>
        </li>
        {children}
      </>
    );
  }
  const pct = (reading.used / reading.size) * 100;
  const detail = categories ? formatAgo(categories.observedAt, now) : readingDetail(reading, now);
  const autoCompact = (
    categories ? contextCountdown(categories, reading.used) : autoCompactText(entry, reading)
  )?.replace(/^About /, "");
  const ariaLabel = `${entry.name} context${entry.agent ? ` (${entry.agent})` : ""}`;
  const sep = <span aria-hidden="true"> · </span>;
  const shownDetail =
    detail && (who || autoCompact ? detail.charAt(0).toLowerCase() + detail.slice(1) : detail);
  return (
    <>
      <li
        className="flex flex-col gap-1.5"
        data-testid="ae-limit-window"
        data-window={`context:${entry.key}`}
      >
        {head}
        {categories ? (
          <AeCategoryBar data={categories} />
        ) : (
          <Meter
            label={`${ariaLabel}: ${Math.round(pct)}% used`}
            pct={pct}
            segments={contextSegments(pct, reading.stale, entry.breakdown)}
            thick
          />
        )}
        {categories ? (
          <AeCategoryLegend data={categories} />
        ) : (
          entry.breakdown && (
            <ContextLegend
              context={entry.breakdown}
              now={now}
              dots={!reading.stale && contextTone(pct) === "normal"}
            />
          )
        )}
      </li>
      {children}
      {(autoCompact || who || shownDetail) && (
        <li className="text-sm text-muted-foreground tabular-nums" data-testid="ae-context-sub">
          {autoCompact && (
            <span
              data-testid="ae-context-autocompact"
              title={
                categories
                  ? "From Claude Code's context snapshot"
                  : "Claude Code compacts a 1M context window at about 967k tokens by default"
              }
            >
              {autoCompact}
            </span>
          )}
          {autoCompact && who && sep}
          {who && <span data-testid="ae-usage-who">{who}</span>}
          {(autoCompact || who) && shownDetail && sep}
          {shownDetail && <span>{shownDetail}</span>}
        </li>
      )}
    </>
  );
}

/** "Codex", or a Claude Code lane's model ("Sonnet 5.5"): what tells two lanes apart. */
function laneWho(entry: AeContextEntry): string | null {
  if (entry.agent && entry.agent !== "Claude Code") return entry.agent;
  return aeModelName(entry.model) ?? entry.agent;
}

/**
 * Running agents under the context bar, each its own window and percent,
 * never added together, then a count of Claude Code's own subagents.
 */
function AgentLanes({
  entries,
  subagents,
  hidden,
  error,
}: {
  entries: AeContextEntry[];
  subagents: number;
  /** Collaborators past the fetch cap, counted but not drawn. */
  hidden: number;
  error?: string | null;
}) {
  if (entries.length === 0 && subagents === 0 && hidden === 0 && !error) return null;
  return (
    <li className="flex flex-col gap-1.5" data-testid="ae-context-collaborators">
      {entries.length > 0 && (
        <ul
          aria-label="Running agents"
          className="grid grid-cols-[auto_minmax(0,1fr)_4rem_2.25rem] items-center gap-x-2 gap-y-1 text-xs"
        >
          {entries.map((entry) => {
            const who = laneWho(entry);
            const pct = entry.reading ? (entry.reading.used / entry.reading.size) * 100 : null;
            return (
              <li
                key={entry.key}
                className="contents"
                data-testid="ae-context-lane"
                data-session={entry.key}
                title={entry.unavailable ?? undefined}
              >
                <AeTablerSvg node={LANE_ICON} className="size-3.5 text-muted-foreground" />
                <span className="min-w-0 truncate">
                  {entry.name}
                  {who && <span className="text-muted-foreground"> · {who}</span>}
                </span>
                {pct === null ? (
                  <span className="h-1 rounded-full bg-foreground/10" />
                ) : (
                  <Meter
                    label={`${entry.name} context${entry.agent ? ` (${entry.agent})` : ""}: ${Math.round(pct)}% used`}
                    pct={pct}
                    segments={[
                      {
                        key: "used",
                        className: entry.reading?.stale ? MUTED_BAR : TONE_BAR[contextTone(pct)],
                        share: 1,
                      },
                    ]}
                  />
                )}
                <span
                  className={cn(
                    "text-right tabular-nums",
                    pct === null ? "text-muted-foreground" : "font-semibold",
                  )}
                >
                  {pct === null ? "-" : `${Math.round(pct)}%`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {subagents > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="ae-context-subagents">
          + {subagents} Claude Code {subagents === 1 ? "subagent" : "subagents"} running (no
          reading)
        </p>
      )}
      {hidden > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="ae-context-hidden">
          + {hidden} more {hidden === 1 ? "agent" : "agents"} not shown
        </p>
      )}
      {error && (
        <p className="text-sm text-muted-foreground">
          Could not list this session's agents ({error}).
        </p>
      )}
    </li>
  );
}

/** What to do about "No reading yet", shown as its tooltip. */
const EMPTY_TEXT: Record<AeHarness, string> = {
  claude:
    "No reading yet. Send one message in any Claude session; the box host's limits relay " +
    "posts within five minutes. Still empty after that: the relay timer is off " +
    "(docs/PLAN-LIMITS.md, step 3).",
  codex:
    "No reading yet. The limits relay asks Codex every five minutes; it needs `codex login` " +
    "as the box user.",
};

interface AeLimitsBlockProps {
  harness: AeHarness;
  snapshot: AeLimitSnapshot | null | undefined;
  now: number;
  /** This session runs on this harness's plan, and another plan is listed too. */
  inUse?: boolean;
  /** The block that heads the section, which carries the section's info toggle. */
  lead?: boolean;
  /** Narrow rows: resets without the "Resets" word. */
  short?: boolean;
  infoOpen?: boolean;
  onInfoOpenChange?: (open: boolean) => void;
}

/**
 * One plan's limits: the popover shows the session's own, the rail both.
 * With `sessionId`, the Claude block's account name is a menu of the box's
 * Claude logins (see `AeSwitchedBlock`); Codex and a block with no session are plain.
 */
export function AeLimitsHarnessBlock(props: AeLimitsBlockProps & { sessionId?: string | null }) {
  const { sessionId, ...block } = props;
  if (sessionId && block.harness === "claude" && block.snapshot) {
    return <AeSwitchedBlock sessionId={sessionId} {...block} />;
  }
  return <AeLimitsBlockView {...block} />;
}

function AeLimitsBlockView({
  harness,
  snapshot,
  now,
  inUse = false,
  lead = false,
  short = false,
  infoOpen,
  onInfoOpenChange,
  accountMenu,
  pending,
}: AeLimitsBlockProps & {
  /** The account chip, placed beside the title instead of inside it. */
  accountMenu?: ReactNode;
  /** What to say while there is no snapshot to draw, instead of "No reading yet". */
  pending?: string;
}) {
  return (
    <section
      className="flex flex-col gap-2.5"
      data-testid="ae-limits-harness"
      data-harness={harness}
      data-in-use={inUse || undefined}
    >
      <SectionHeader
        title={
          <>
            {AE_HARNESS_NAMES[harness]}
            {!accountMenu && snapshot?.plan && (
              <>
                {" · "}
                <span data-testid="ae-limits-plan">{snapshot.plan}</span>
              </>
            )}
            {!accountMenu && (snapshot?.account_label || snapshot?.account) && (
              <>
                {" · "}
                <span data-testid="ae-limits-account">
                  {snapshot.account_label || snapshot.account}
                </span>
              </>
            )}
          </>
        }
        tag={
          inUse ? (
            <span
              role="img"
              aria-label="This session"
              className="size-1.5 shrink-0 rounded-full bg-emerald-500"
              data-testid="ae-limits-in-use"
              title="This session"
            />
          ) : null
        }
        control={accountMenu}
        info={lead ? PLAN_INFO : undefined}
        infoLabel="About plan limits"
        infoOpen={infoOpen}
        onInfoOpenChange={onInfoOpenChange}
        right={
          snapshot && !short ? (
            <span
              className="text-sm text-muted-foreground"
              title={`Updated ${new Date(snapshot.observed_at).toLocaleString()}`}
            >
              {formatAgo(snapshot.observed_at, now)}
            </span>
          ) : null
        }
      />
      {!snapshot ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="ae-limits-empty"
          title={EMPTY_TEXT[harness]}
        >
          {pending ?? "No reading yet"}
        </p>
      ) : (
        <>
          {(snapshot.windows.length > 0 || snapshot.credits) && (
            <ul className="flex flex-col gap-2.5">
              {snapshot.windows.map((w) => (
                <AeLimitWindowRow key={w.id} window={w} now={now} short={short} />
              ))}
              {snapshot.credits && <AeCreditsRow credits={snapshot.credits} now={now} />}
            </ul>
          )}
          {snapshot.note && <p className="text-sm text-muted-foreground">{snapshot.note}</p>}
          {short && (
            <p
              className="text-xs text-muted-foreground"
              title={`Updated ${new Date(snapshot.observed_at).toLocaleString()}`}
            >
              Updated {formatAgo(snapshot.observed_at, now)}
            </p>
          )}
          {snapshot.hint && (
            <p className="text-sm text-muted-foreground" data-testid="ae-limits-hint">
              {snapshot.hint}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export const AE_LIMIT_ACCOUNTS_PATH = "/v1/ae/limits/accounts";

async function fetchAeLimitAccounts(): Promise<AeLimitAccountRow[]> {
  const res = await authenticatedFetch(AE_LIMIT_ACCOUNTS_PATH, { method: "GET" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
  const body = (await res.json()) as { accounts?: AeLimitAccountRow[] };
  return Array.isArray(body.accounts) ? body.accounts.filter((a) => a.harness === "claude") : [];
}

/**
 * The second line of a menu row: that login's all-models weekly percentage in
 * the window's tone. Nothing while loading, on an error, with no such window, or once it has reset.
 * Mounted only while the menu is open, so each row fetches once per opening.
 * omnigent-ae, 2026-10-28.
 */
function AeAccountWeekly({ accountKey, now }: { accountKey: string; now: number }) {
  const { data } = useAeLimits(true, null, accountKey);
  const w = data?.harnesses.claude?.windows.find((x) => x.label === "Weekly, all models");
  // A window past its reset reports last week's number, so it shows no line.
  if (!w || (w.resets_at !== null && Date.parse(w.resets_at) <= now)) return null;
  return (
    <span className="text-xs text-muted-foreground" data-testid="ae-limits-account-weekly">
      {"Weekly "}
      <span className={cn("tabular-nums", TONE_TEXT[limitTone(w.used_percent)])}>
        {Math.round(w.used_percent)}%
      </span>
    </span>
  );
}

/**
 * The Claude block with a subscription switcher: the account name opens a menu
 * of every Claude login, and picking one shows that login's usage while the
 * chat stays on its own. The pick is this chat's alone and ends with it.
 */
function AeSwitchedBlock({ sessionId, ...block }: AeLimitsBlockProps & { sessionId: string }) {
  const own = block.snapshot;
  const ownKey = aeAccountKey(own?.account);
  const [picked, setPicked] = useState<{ sessionId: string; key: string } | null>(null);
  useEffect(() => setPicked(null), [sessionId]);
  const [menuOpen, setMenuOpen] = useState(false);
  const accounts = useQuery({
    queryKey: ["ae-limit-accounts"],
    queryFn: fetchAeLimitAccounts,
    enabled: menuOpen,
    staleTime: MINUTE / 2,
    retry: false,
  });
  const rows = accounts.data ?? [];
  const selectedKey = picked?.sessionId === sessionId ? picked.key : ownKey;
  const viewingOther = selectedKey !== ownKey;
  const other = useAeLimits(viewingOther, null, selectedKey);
  const shown = viewingOther ? other.data?.harnesses.claude : own;
  const label = viewingOther
    ? (shown?.account_label ??
      rows.find((r) => aeAccountKey(r.account) === selectedKey)?.label ??
      (selectedKey || null))
    : own?.account_label || own?.account || null;
  return (
    <AeLimitsBlockView
      {...block}
      snapshot={shown}
      inUse={block.inUse && !viewingOther}
      pending={
        other.error ? "Could not load that login's usage." : viewingOther ? "Loading…" : undefined
      }
      accountMenu={
        <AeLimitsAccountMenu
          rows={rows}
          ownKey={ownKey}
          selectedKey={selectedKey}
          label={label}
          plan={shown?.plan ?? null}
          viewingOther={viewingOther}
          onOpenChange={setMenuOpen}
          onSelect={(key) => setPicked({ sessionId, key })}
          renderDetail={(key) => <AeAccountWeekly accountKey={key} now={block.now} />}
        />
      }
    />
  );
}

/** What `/v1/ae/limits` failed with, and where to look. */
export function aeLimitsErrorText(error: unknown): string {
  return `Could not load plan limits (${error instanceof Error ? error.message : String(error)}). The /v1/ae/limits route belongs to omnigent-ae; check the server is on a current tag.`;
}

const NO_SESSIONS: AeSessionContextsState = { collaborators: [] };

function isClaudeCode(harness: string | null | undefined): boolean {
  return harness === "claude-native" || harness === "native-claude";
}

/** The popover body; exported so tests and stories render it without a click. */
export function AePlanLimitsPanel({
  data,
  error,
  loading,
  now = Date.now(),
  conversationId = null,
  contextWindow = null,
  tokensUsed = null,
  harness = null,
  model = null,
  sessions = NO_SESSIONS,
  snapshot,
  onShowRail,
}: {
  data?: AeLimitsAnswer;
  error?: unknown;
  loading?: boolean;
  now?: number;
  conversationId?: string | null;
  /** The store's live ring figures for the active session. */
  contextWindow?: number | null;
  tokensUsed?: number | null;
  /** The active session's harness and model, e.g. `"codex-native"`, `"gpt-5.5"`. */
  harness?: string | null;
  model?: string | null;
  /** This session's snapshot and its collaborators', from `useAeSessionContexts`. */
  sessions?: AeSessionContextsState;
  /** Claude Code's category snapshot, from `useAeContextSnapshot`. */
  snapshot?: AeContextSnapshotState;
  /** Runs before the rail opens: the popover closes itself here. */
  onShowRail?: () => void;
}) {
  const isMobile = useIsMobileViewport();
  // The loading, error and loaded states each draw their own plan header, so
  // the panel keeps its explainer open across them.
  const [planInfoOpen, setPlanInfoOpen] = useState(false);
  const planInfo = { infoOpen: planInfoOpen, onInfoOpenChange: setPlanInfoOpen };
  const statusLines = data?.harnesses.claude?.contexts;
  const active = buildActiveContext(
    { conversationId, harness, model, contextWindow, tokensUsed },
    sessions.self,
    statusLines,
    now,
  );
  const categories =
    isClaudeCode(active.harness) && snapshot?.fresh && snapshot.data?.available
      ? snapshot.data
      : undefined;
  const lanes = sessions.collaborators
    .filter((c) => c.running !== false)
    .map((c) => buildCollaboratorContext(c, statusLines, now));
  // The active row's harness, so a stale store harness cannot pick the block.
  const primary: AeHarness = aeLimitsHarnessFor(active.harness) === "codex" ? "codex" : "claude";
  const showRail = () => {
    onShowRail?.();
    useAeSessionRailStore.getState().focusSection("context", { sheet: isMobile });
  };
  return (
    <div className="flex flex-col gap-3" data-testid="ae-plan-limits">
      <section className="flex flex-col gap-2" data-testid="ae-limits-context">
        <ul data-testid="ae-context-active" className="flex flex-col gap-1.5">
          <ActiveContextRow entry={active} now={now} categories={categories}>
            <AgentLanes
              entries={lanes}
              subagents={sessions.subagents ?? 0}
              hidden={sessions.hidden ?? 0}
              error={sessions.error}
            />
          </ActiveContextRow>
        </ul>
      </section>
      <div className="flex flex-col gap-2.5 border-t pt-3" data-testid="ae-limits-plans">
        {error ? (
          <>
            <SectionHeader
              title="Plan limits"
              info={PLAN_INFO}
              infoLabel="About plan limits"
              {...planInfo}
            />
            <p className="text-sm text-destructive">{aeLimitsErrorText(error)}</p>
          </>
        ) : loading && !data ? (
          <>
            <SectionHeader
              title="Plan limits"
              info={PLAN_INFO}
              infoLabel="About plan limits"
              {...planInfo}
            />
            <p className="text-sm text-muted-foreground">Loading…</p>
          </>
        ) : (
          <AeLimitsHarnessBlock
            harness={primary}
            snapshot={data?.harnesses[primary]}
            sessionId={conversationId}
            now={now}
            lead
            {...planInfo}
          />
        )}
      </div>
      <div className="border-t pt-3">
        <button
          type="button"
          data-testid="ae-limits-show-rail"
          className="flex min-h-8 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-sm outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-10"
          onClick={showRail}
        >
          <AeRailIcon name="rail" />
          Show details in session rail
        </button>
      </div>
    </div>
  );
}

/**
 * `GET /v1/ae/limits` while `active`, then once a minute; one shared query per
 * session. Sessions on different Claude accounts never share a reading, so the
 * session id is part of the cache key, and so is the account hint (the login
 * picked for new chats, frozen at the first one seen for that session).
 */
export function useAeLimits(
  active: boolean,
  sessionId?: string | null,
  account?: string,
): {
  data?: AeLimitsAnswer;
  error?: unknown;
  loading: boolean;
} {
  const named = freezeAccount(sessionId, account);
  const query = useQuery({
    queryKey: ["ae-limits", sessionId ?? null, named ?? null],
    queryFn: () => fetchAeLimits(sessionId, named),
    enabled: active,
    refetchInterval: active ? MINUTE : false,
    staleTime: MINUTE / 2,
    retry: false,
  });
  return {
    data: query.data,
    error: query.error ?? undefined,
    loading: active && query.isFetching,
  };
}

/**
 * The composer's context ring, as upstream renders it (`ComposerContextRing`,
 * v0.15.0). Upstream's own suites pin this test id, so a rename shows up
 * there and in this component's suite, which renders the real ring.
 */
export const AE_CONTEXT_RING_SELECTOR = '[data-testid="composer-context-ring"]';

/**
 * Opens the usage popover when the context ring is clicked.
 *
 * Mounted beside the ring, not around it: since upstream v0.15.0 the ring is
 * its own button inside a flex row whose layout upstream's tests pin, so a
 * wrapper element (or a second button) would change upstream's markup. The
 * component renders no element of its own; it listens for clicks (and the
 * click a keyboard Enter or Space produces) on any context ring in the
 * document, anchors the popover to the one clicked, and a second click on it
 * closes the popover again.
 *
 * It closes like upstream's other popovers (Radix: a press outside, Escape,
 * focus moving out) and also when this window loses focus. Radix watches only
 * its own document, so in the split view (each pane is an iframe) a click or
 * Escape in another pane left the popover open; a window blur is what that
 * click produces here (found 2026-09-24).
 *
 * The context rows read the same chat store fields the ring does
 * (`contextWindow`, `tokensUsed`, harness, model) and the session id, so
 * ChatPage.tsx passes nothing and the patch stays two lines there.
 */
export function AePlanLimitsPopover() {
  const conversationId = useChatStore((s) => s.conversationId);
  const contextWindow = useChatStore((s) => s.contextWindow);
  const tokensUsed = useChatStore((s) => s.tokensUsed);
  const harness = useChatStore((s) => s.sessionHarness);
  const model = useChatStore((s) => s.llmModel);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = anchor !== null;
  const toRail = useRef(false);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const ring = target?.closest<HTMLElement>(AE_CONTEXT_RING_SELECTOR) ?? null;
      if (ring) setAnchor((current) => (current === ring ? null : ring));
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setAnchor(null);
    const onVisibility = () => document.visibilityState === "hidden" && close();
    window.addEventListener("blur", close);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", close);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [open]);
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  // A press on the open ring is outside the popover's content; left alone,
  // Radix would close on the press and the click would reopen it.
  const keepOpenOnRing = (event: Event) => {
    if (anchor && event.target instanceof Node && anchor.contains(event.target)) {
      event.preventDefault();
    }
  };
  return (
    <Popover open={open} onOpenChange={(next) => !next && setAnchor(null)}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        side="top"
        align="end"
        // Claude Desktop's width; a phone still caps at the room Radix measured and scrolls.
        className="max-h-(--radix-popover-content-available-height) w-[22rem] max-w-[calc(100vw-2rem)] overflow-y-auto"
        aria-label="Usage"
        onInteractOutside={keepOpenOnRing}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // Not after a blur (focus went to another pane or window) or a
          // move to the rail (focus belongs there).
          if (document.hasFocus() && !toRail.current) anchorRef.current?.focus();
          toRail.current = false;
        }}
      >
        <AePlanLimitsPopoverBody
          conversationId={conversationId}
          contextWindow={contextWindow}
          tokensUsed={tokensUsed}
          harness={harness}
          model={model}
          onShowRail={() => {
            toRail.current = true;
            setAnchor(null);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The popover's data, read only while it is open (Radix mounts the content on open). */
function AePlanLimitsPopoverBody({
  conversationId,
  contextWindow,
  tokensUsed,
  harness,
  model,
  onShowRail,
}: {
  conversationId: string | null;
  contextWindow: number | null;
  tokensUsed: number | null;
  harness: string | null;
  model: string | null;
  onShowRail: () => void;
}) {
  const identity = aeContextIdentity(harness, model);
  const picked = useAePickedClaudeAccount(conversationId, isClaudeCode(harness));
  const { data, error, loading } = useAeLimits(picked.ready, conversationId, picked.account);
  const sessions = useAeSessionContexts(true, conversationId, 60_000, identity);
  // A cached category snapshot shows at once; a stale one refreshes.
  const snapshot = useAeContextSnapshot(conversationId, {
    enabled: isClaudeCode(harness),
    identity,
  });
  return (
    <AePlanLimitsPanel
      data={data}
      error={error}
      loading={loading}
      conversationId={conversationId}
      contextWindow={contextWindow}
      tokensUsed={tokensUsed}
      harness={harness}
      model={model}
      sessions={sessions}
      snapshot={snapshot}
      onShowRail={onShowRail}
    />
  );
}
