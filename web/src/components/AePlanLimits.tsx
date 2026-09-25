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

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { type AeTone, contextTone } from "@/lib/aeContextTone";
import { authenticatedFetch } from "@/lib/identity";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";

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

export async function fetchAeLimits(): Promise<AeLimitsAnswer> {
  const res = await authenticatedFetch(AE_LIMITS_PATH, { method: "GET" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
  return (await res.json()) as AeLimitsAnswer;
}

const TONE_BAR: Record<AeTone, string> = {
  normal: "bg-foreground/60",
  warning: "bg-warning",
  critical: "bg-destructive",
};

/** One labelled bar: the row every section of the popover is made of. */
function UsageRow({
  id,
  label,
  value,
  pct,
  detail,
  muted = false,
  tone = limitTone(pct),
  children,
}: {
  id: string;
  label: string;
  value: string;
  pct: number;
  detail?: string | null;
  muted?: boolean;
  /** Defaults to the plan limit steps; the context row passes `contextTone`. */
  tone?: AeTone;
  children?: ReactNode;
}) {
  const rounded = Math.round(pct);
  return (
    <li className="flex flex-col gap-1" data-testid="ae-limit-window" data-window={id}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate">{label}</span>
        <span className={cn("shrink-0 tabular-nums", muted && "text-muted-foreground")}>
          {value}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10"
        role="progressbar"
        aria-label={`${label}: ${rounded}% used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(rounded, 100)}
      >
        <div
          className={cn("h-full rounded-full", muted ? "bg-foreground/25" : TONE_BAR[tone])}
          style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }}
        />
      </div>
      {children}
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
    </li>
  );
}

function WindowRow({ window: w, now }: { window: AeLimitWindow; now: number }) {
  const passed = w.resets_at !== null && Date.parse(w.resets_at) <= now;
  return (
    <UsageRow
      id={w.id}
      label={w.label}
      value={`${Math.round(w.used_percent)}% used`}
      pct={w.used_percent}
      detail={formatReset(w.resets_at, now)}
      muted={passed}
    />
  );
}

function CreditsRow({ credits, now }: { credits: AeCredits; now: number }) {
  const used = credits.used_minor;
  if (!credits.enabled) {
    return (
      <li className="flex items-baseline justify-between gap-2" data-testid="ae-limit-credits">
        <span>Usage credits</span>
        <span className="text-xs text-muted-foreground">Off</span>
      </li>
    );
  }
  if (used === null) return null;
  const spent = formatMoney(used, credits.currency);
  if (credits.limit_minor === null) {
    return (
      <li className="flex items-baseline justify-between gap-2" data-testid="ae-limit-credits">
        <span>Usage credits</span>
        <span className="tabular-nums">{spent} spent</span>
      </li>
    );
  }
  const cap = credits.limit_minor;
  const pct = credits.used_percent ?? (cap > 0 ? (used / cap) * 100 : 0);
  // Credits reset with the calendar month (Claude Code's own /usage row).
  const month = new Date(now);
  const reset = new Date(month.getFullYear(), month.getMonth() + 1, 1).toISOString();
  return (
    <UsageRow
      id="credits"
      label="Usage credits"
      value={`${spent} of ${formatMoney(cap, credits.currency)}`}
      pct={pct}
      detail={formatReset(reset, now)}
    />
  );
}

/**
 * The thin bar under the context row: how the used tokens were sent on the
 * session's last request (read from the prompt cache, written to it, or new).
 * Three greys read as a second meter (Reid, 2026-09-24), so since P18 each part
 * has its own chart colour (blue, green, grey; never the warning or destructive
 * colours the bars above use for "nearly full") and a caption says what it is.
 * It is not a /context-style breakdown by system prompt, tools and messages:
 * the status line the relay reads carries only these three counts.
 */
const CONTEXT_PARTS = [
  { key: "cache_read_tokens", label: "Cached", className: "bg-chart-1" },
  { key: "cache_write_tokens", label: "Cache write", className: "bg-chart-3" },
  { key: "input_tokens", label: "New input", className: "bg-chart-5" },
] as const;

const CONTEXT_BREAKDOWN_CAPTION = "How those tokens were billed (prompt cache)";

function ContextBreakdown({ context, now }: { context: AeSessionContext; now: number }) {
  const parts = CONTEXT_PARTS.filter((part) => context[part.key] > 0);
  if (parts.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-1"
      data-testid="ae-context-breakdown"
      title={`From the session's status line, ${formatAgo(context.observed_at, now)}`}
    >
      <span className="text-xs text-muted-foreground" data-testid="ae-context-breakdown-caption">
        {CONTEXT_BREAKDOWN_CAPTION}
      </span>
      <div className="flex h-1 w-full overflow-hidden rounded-full bg-foreground/10">
        {parts.map((part) => (
          <div
            key={part.key}
            className={part.className}
            style={{ width: `${(context[part.key] / context.window_size) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-2.5 text-xs text-muted-foreground">
        {parts.map((part) => (
          <span key={part.key} className="inline-flex items-center gap-1 tabular-nums">
            <span className={cn("inline-block size-1.5 rounded-full", part.className)} />
            {part.label} {formatTokens(context[part.key])}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Context window: the ring's live numbers, else the session's last status line. */
function ContextRow({
  contextWindow,
  tokensUsed,
  context,
  now,
}: {
  contextWindow?: number | null;
  tokensUsed?: number | null;
  context?: AeSessionContext;
  now: number;
}) {
  const live = contextWindow != null && contextWindow > 0 && tokensUsed != null;
  const size = live ? contextWindow : context?.window_size;
  const used = live ? tokensUsed : context?.used_tokens;
  if (!size || used == null) return null;
  const pct = (used / size) * 100;
  return (
    <ul className="flex flex-col" data-testid="ae-limits-context">
      <UsageRow
        id="context"
        label="Context window"
        value={`${formatTokens(used)} / ${formatTokens(size)} · ${Math.round(pct)}%`}
        pct={pct}
        tone={contextTone(pct)}
      >
        {context && <ContextBreakdown context={context} now={now} />}
      </UsageRow>
    </ul>
  );
}

/** "No reading yet", with what to do about it. */
const EMPTY_TEXT: Record<AeHarness, string> = {
  claude:
    "No reading yet. Send one message in any Claude session; the box host's limits relay " +
    "posts within five minutes. Still empty after that: the relay timer is off " +
    "(docs/PLAN-LIMITS.md, step 3).",
  codex:
    "No reading yet. The limits relay asks Codex every five minutes; it needs `codex login` " +
    "as the box user.",
};

function HarnessBlock({
  harness,
  snapshot,
  now,
}: {
  harness: AeHarness;
  snapshot: AeLimitSnapshot | null | undefined;
  now: number;
}) {
  return (
    <section className="flex flex-col gap-2" data-testid="ae-limits-harness" data-harness={harness}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium">
          {AE_HARNESS_NAMES[harness]}
          {snapshot?.plan && (
            <span
              className="ml-1.5 text-xs font-normal text-muted-foreground"
              data-testid="ae-limits-plan"
            >
              {snapshot.plan}
            </span>
          )}
        </h3>
        {snapshot && (
          <span
            className="shrink-0 text-xs text-muted-foreground"
            title={new Date(snapshot.observed_at).toLocaleString()}
          >
            Updated {formatAgo(snapshot.observed_at, now)}
          </span>
        )}
      </div>
      {!snapshot ? (
        <p className="text-xs text-muted-foreground">{EMPTY_TEXT[harness]}</p>
      ) : (
        <>
          {(snapshot.windows.length > 0 || snapshot.credits) && (
            <ul className="flex flex-col gap-2">
              {snapshot.windows.map((w) => (
                <WindowRow key={w.id} window={w} now={now} />
              ))}
              {snapshot.credits && <CreditsRow credits={snapshot.credits} now={now} />}
            </ul>
          )}
          {snapshot.note && <p className="text-xs text-muted-foreground">{snapshot.note}</p>}
          {snapshot.hint && (
            <p className="text-xs text-muted-foreground" data-testid="ae-limits-hint">
              {snapshot.hint}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** The popover body; exported so tests and stories render it without a click. */
export function AePlanLimitsPanel({
  data,
  error,
  loading,
  now = Date.now(),
  conversationId,
  contextWindow,
  tokensUsed,
}: {
  data?: AeLimitsAnswer;
  error?: unknown;
  loading?: boolean;
  now?: number;
  conversationId?: string | null;
  contextWindow?: number | null;
  tokensUsed?: number | null;
}) {
  const context = conversationId
    ? data?.harnesses.claude?.contexts?.find((c) => c.conversation_id === conversationId)
    : undefined;
  return (
    <div className="flex flex-col gap-3" data-testid="ae-plan-limits">
      <div className="font-medium">Usage</div>
      <ContextRow
        contextWindow={contextWindow}
        tokensUsed={tokensUsed}
        context={context}
        now={now}
      />
      {error ? (
        <p className="text-xs text-destructive">
          Could not load plan limits ({error instanceof Error ? error.message : String(error)}). The
          /v1/ae/limits route belongs to omnigent-ae; check the server is on a current tag.
        </p>
      ) : loading && !data ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        (["claude", "codex"] as const).map((harness) => (
          <HarnessBlock
            key={harness}
            harness={harness}
            snapshot={data?.harnesses[harness]}
            now={now}
          />
        ))
      )}
    </div>
  );
}

/** `GET /v1/ae/limits` while `active`, then once a minute; plain state, no query cache,
 * so the composer renders the same under tests that mount it without a QueryClient. */
export function useAeLimits(active: boolean): {
  data?: AeLimitsAnswer;
  error?: unknown;
  loading: boolean;
} {
  const [state, setState] = useState<{ data?: AeLimitsAnswer; error?: unknown }>({});
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const load = () => {
      setLoading(true);
      fetchAeLimits()
        .then((data) => !cancelled && setState({ data }))
        .catch((error: unknown) => !cancelled && setState((prev) => ({ ...prev, error })))
        .finally(() => !cancelled && setLoading(false));
    };
    load();
    const timer = window.setInterval(load, MINUTE);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active]);
  return { ...state, loading };
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
 * The context row reads the same chat store fields the ring does
 * (`contextWindow`, `tokensUsed`) and the session id, so ChatPage.tsx passes
 * nothing and the patch stays two lines there.
 */
export function AePlanLimitsPopover() {
  const conversationId = useChatStore((s) => s.conversationId);
  const contextWindow = useChatStore((s) => s.contextWindow);
  const tokensUsed = useChatStore((s) => s.tokensUsed);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = anchor !== null;
  const { data, error, loading } = useAeLimits(open);
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
        // Nine rows outgrow a phone: cap at the room Radix measured and scroll.
        className="max-h-(--radix-popover-content-available-height) w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
        onInteractOutside={keepOpenOnRing}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // Not after a blur: focusing the ring would pull focus back from
          // the pane or window the click went to.
          if (document.hasFocus()) anchorRef.current?.focus();
        }}
      >
        <AePlanLimitsPanel
          data={data}
          error={error}
          loading={loading}
          conversationId={conversationId}
          contextWindow={contextWindow}
          tokensUsed={tokensUsed}
        />
      </PopoverContent>
    </Popover>
  );
}
