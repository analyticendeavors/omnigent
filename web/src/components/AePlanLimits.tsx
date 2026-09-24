// Plan limits behind the composer's context ring: what Claude Code's `/usage`
// shows (the 5-hour and weekly windows, percent used, reset times) and the
// Codex equivalent, one click away instead of the `>_` terminal. The numbers
// come from `GET /v1/ae/limits`, which the box host's relay fills every five
// minutes from Claude Code's statusLine payload and `codex app-server`
// (omnigent-ae `packages/ae_omni_policies/src/ae_omni_policies/limits.py`,
// docs/PLAN-LIMITS.md). omnigent-ae patch P5, 2026-09-24.

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { authenticatedFetch } from "@/lib/identity";
import { cn } from "@/lib/utils";

export const AE_LIMITS_PATH = "/v1/ae/limits";

export type AeHarness = "claude" | "codex";

export interface AeLimitWindow {
  id: string;
  label: string;
  used_percent: number;
  resets_at: string | null;
  window_minutes: number | null;
}

export interface AeLimitSnapshot {
  harness: AeHarness;
  source: string;
  observed_at: string;
  received_at?: string;
  plan: string | null;
  windows: AeLimitWindow[];
  note: string | null;
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

/** Bar colour: the ring's own thresholds, a little later because a limit is not a context. */
export function limitTone(pct: number): "normal" | "warning" | "critical" {
  if (pct >= 90) return "critical";
  if (pct >= 70) return "warning";
  return "normal";
}

export async function fetchAeLimits(): Promise<AeLimitsAnswer> {
  const res = await authenticatedFetch(AE_LIMITS_PATH, { method: "GET" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
  return (await res.json()) as AeLimitsAnswer;
}

const TONE_BAR: Record<ReturnType<typeof limitTone>, string> = {
  normal: "bg-foreground/60",
  warning: "bg-warning",
  critical: "bg-destructive",
};

function WindowRow({ window: w, now }: { window: AeLimitWindow; now: number }) {
  const pct = Math.round(w.used_percent);
  const reset = formatReset(w.resets_at, now);
  const passed = w.resets_at !== null && Date.parse(w.resets_at) <= now;
  const tone = limitTone(w.used_percent);
  return (
    <li className="flex flex-col gap-1" data-testid="ae-limit-window" data-window={w.id}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate">{w.label}</span>
        <span className={cn("shrink-0 tabular-nums", passed && "text-muted-foreground")}>
          {pct}% used
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10"
        role="progressbar"
        aria-label={`${w.label}: ${pct}% used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(pct, 100)}
      >
        <div
          className={cn("h-full rounded-full", passed ? "bg-foreground/25" : TONE_BAR[tone])}
          style={{ width: `${Math.min(Math.max(w.used_percent, 0), 100)}%` }}
        />
      </div>
      {reset && <span className="text-xs text-muted-foreground">{reset}</span>}
    </li>
  );
}

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
            <span className="ml-1.5 text-xs font-normal uppercase text-muted-foreground">
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
        <p className="text-xs text-muted-foreground">
          No reading yet. The box host's limits relay posts one every five minutes.
        </p>
      ) : (
        <>
          {snapshot.windows.length > 0 && (
            <ul className="flex flex-col gap-2.5">
              {snapshot.windows.map((w) => (
                <WindowRow key={w.id} window={w} now={now} />
              ))}
            </ul>
          )}
          {snapshot.note && <p className="text-xs text-muted-foreground">{snapshot.note}</p>}
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
}: {
  data?: AeLimitsAnswer;
  error?: unknown;
  loading?: boolean;
  now?: number;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="ae-plan-limits">
      <div className="font-medium">Plan limits</div>
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

/** Wraps the context ring in a button that opens the plan-limits popover. */
export function AePlanLimitsPopover({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { data, error, loading } = useAeLimits(open);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="ae-plan-limits-trigger"
          aria-label="Context used; open plan limits"
          className="flex items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <AePlanLimitsPanel data={data} error={error} loading={loading} />
      </PopoverContent>
    </Popover>
  );
}
