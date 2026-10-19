// The rail's Triage section: the session's `ae.*` labels as controls. The
// status switch writes what the sidebar's Status menu writes, an open gate
// offers the Dashboard's four answers, and the absorbed and unfiled counts
// share a row and fold open to their lines: the notes saved on the session,
// then any the loaded messages carry that are not saved yet.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { AE_STATUS_WORDS } from "@/components/AeStatusIcon";
import {
  AE_ABSORBED_KEY,
  AE_FORK_KEY,
  AE_FORK_SUSPECT_KEY,
  AE_GATE_KEY,
  AE_NEXT_KEY,
  AE_OVERFLOW_KEY,
  AE_STARTED_KEY,
  AE_TASK_KEY,
  AE_TRIAGE_KEY,
  AE_UNFILED_KEY,
  type AeStatus,
  aeLabel,
  aeStatusOf,
} from "@/lib/aeLabels";
import {
  AE_GATE_ROUTES,
  type AeGateRoute,
  aeGateLabel,
  aeOverflowTag,
  aeStartedLine,
  countAeUserTurns,
  fetchAeLotTasks,
  parseAeStarted,
  aeTriageLinesWithNotes,
  replyAeGate,
  scanAeTriageLines,
} from "@/lib/aeRailTriage";
import { type AeRailSectionProps, useAeRailSectionActive } from "@/lib/aeSessionRail";
import { useAeSlotLimit } from "@/lib/aeSlotLimit";
import { cn } from "@/lib/utils";
import { applyAeStatus } from "@/shell/AeStatusMenu";
import { AeRailSection } from "./AeRailSection";
import { type AeLabels, useAeRailLoadedBlocks, useAeRailSessionLabels } from "./aeRailSessionData";
import { AE_RAIL_TONE_TEXT, AeRailIcon, AeRailMuted } from "./aeRailUi";

/** The four statuses the switch offers; reference stays in the sidebar menu. */
const SWITCH_STATUSES: readonly AeStatus[] = ["working", "blocked", "review", "parked"];

const LOT_STALE_MS = 5 * 60_000;

export function AeRailTriage({ sessionId }: AeRailSectionProps) {
  const labels = useAeRailSessionLabels(sessionId);
  const gateOpen = aeLabel(labels, AE_GATE_KEY) === "open";
  const status = aeStatusOf(labels);
  const summary = gateOpen ? (
    <span className={AE_RAIL_TONE_TEXT.warning}>1 question open</span>
  ) : status ? (
    AE_STATUS_WORDS[status]
  ) : undefined;
  return (
    <AeRailSection id="triage" summary={summary}>
      <AeTriageBody sessionId={sessionId} labels={labels} />
    </AeRailSection>
  );
}

function AeTriageBody({ sessionId, labels }: { sessionId: string; labels: AeLabels | null }) {
  const active = useAeRailSectionActive("triage");
  const loaded = useAeRailLoadedBlocks(sessionId);
  const limit = useAeSlotLimit();
  const now = useMinuteClock();
  const known = labels ?? {};

  const started = parseAeStarted(aeLabel(known, AE_STARTED_KEY));
  const turns = loaded ? countAeUserTurns(loaded.blocks) : null;
  const startedLine = aeStartedLine(started, now, turns, loaded?.moreHistory ?? false);
  const overflow = aeLabel(known, AE_OVERFLOW_KEY) === "1" ? aeOverflowTag(limit) : null;
  const triageMode = aeLabel(known, AE_TRIAGE_KEY);
  // Saved notes list even when their message is too old to be loaded.
  const lines = aeTriageLinesWithNotes(
    known,
    loaded ? scanAeTriageLines(loaded.blocks) : { absorbed: [], unfiled: [] },
  );
  const next = aeLabel(known, AE_NEXT_KEY);
  const task = aeLabel(known, AE_TASK_KEY);

  return (
    <div className="text-sm">
      {labels === null && (
        <AeRailMuted>This session&apos;s labels have not loaded yet.</AeRailMuted>
      )}
      <AeStatusSwitch sessionId={sessionId} labels={known} />
      {(startedLine || overflow || triageMode) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-0.5 text-xs text-muted-foreground">
          {startedLine && <span data-testid="ae-triage-started">{startedLine}</span>}
          <span className="ml-auto flex flex-wrap gap-1">
            {overflow && <AeTag title={overflow.title}>{overflow.label}</AeTag>}
            {triageMode === "off" && (
              <AeTag title="Forks are absorbed without asking until triage is on again">
                Triage off
              </AeTag>
            )}
            {triageMode === "capture" && (
              <AeTag title="Forks are filed to the Parking Lot without asking until triage is on again">
                Capture mode
              </AeTag>
            )}
          </span>
        </div>
      )}
      {aeLabel(known, AE_GATE_KEY) === "open" && <AeGateBox sessionId={sessionId} labels={known} />}
      <AeTriageCounts
        counts={[
          {
            label: "Absorbed",
            count: countOf(aeLabel(known, AE_ABSORBED_KEY), lines.absorbed.length),
            lines: lines.absorbed,
          },
          {
            label: "Unfiled",
            count: countOf(aeLabel(known, AE_UNFILED_KEY), lines.unfiled.length),
            lines: lines.unfiled,
          },
        ]}
        loaded={loaded !== null}
      />
      {next && (
        <div className="mt-1.5 flex gap-2 py-0.5 text-xs">
          <span className="shrink-0 text-muted-foreground">Next</span>
          <span className="min-w-0 font-medium break-words text-foreground">{next}</span>
        </div>
      )}
      {task && <AeParkedTask taskId={task} active={active} />}
    </div>
  );
}

/** The label's count when it is a whole number, else what the loaded lines show. */
function countOf(label: string | null, fallback: number): number {
  const n = label === null ? Number.NaN : Number(label);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Re-render once a minute so "Started 2h 10m ago" keeps moving. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function AeTag({ title, children }: { title: string; children: string }) {
  return (
    <span
      title={title}
      className="rounded-full border border-border px-1.5 py-px text-[11px] whitespace-nowrap text-muted-foreground"
    >
      {children}
    </span>
  );
}

// ── status ───────────────────────────────────────────────────────────────

function AeStatusSwitch({ sessionId, labels }: { sessionId: string; labels: AeLabels }) {
  const queryClient = useQueryClient();
  const current = aeStatusOf(labels);
  const [pending, setPending] = useState<AeStatus | null>(null);
  const choose = async (status: AeStatus) => {
    if (pending) return;
    setPending(status);
    try {
      // The menu's own action: the slot check before working, the toast on failure.
      await applyAeStatus(queryClient, { id: sessionId, labels }, status);
    } finally {
      setPending(null);
    }
  };
  return (
    <div
      role="group"
      aria-label="Session status"
      className="mt-0.5 mb-2 grid grid-cols-4 gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {SWITCH_STATUSES.map((status) => {
        const pressed = current === status;
        return (
          <button
            key={status}
            type="button"
            aria-pressed={pressed}
            disabled={pending !== null}
            onClick={() => void choose(status)}
            className={cn(
              "min-h-7 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground disabled:cursor-wait",
              pressed && "bg-card font-semibold text-foreground shadow-sm",
              pending === status && "animate-pulse",
            )}
          >
            {AE_STATUS_WORDS[status]}
          </button>
        );
      })}
    </div>
  );
}

// ── the gate ─────────────────────────────────────────────────────────────

function AeGateBox({ sessionId, labels }: { sessionId: string; labels: AeLabels }) {
  const fork = aeLabel(labels, AE_FORK_KEY);
  const suspect = aeLabel(labels, AE_FORK_SUSPECT_KEY) !== null;
  const [pending, setPending] = useState<AeGateRoute | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Held against the labels it answered, so any label change brings the buttons back.
  const [answered, setAnswered] = useState<{ route: AeGateRoute; labels: AeLabels } | null>(null);
  const shownAnswer = answered && answered.labels === labels ? answered.route : null;

  const send = async (route: AeGateRoute) => {
    setPending(route);
    setError(null);
    try {
      await replyAeGate(sessionId, route);
      setAnswered({ route, labels });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setError(
        `Could not send "${aeGateLabel(route)}": ${reason}. ` +
          `Try again, or type the letter in the chat.`,
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      data-testid="ae-triage-gate"
      className="my-2 rounded-lg border border-warning/55 bg-warning/10 px-2.5 py-2"
    >
      <div className="flex items-center gap-1.5 font-semibold">
        <AeRailIcon name="fork" className={cn("size-3.5", AE_RAIL_TONE_TEXT.warning)} />
        Split this off?
      </div>
      {fork && <p className="mt-0.5 mb-1.5 break-words">{fork}</p>}
      {suspect && (
        <p className="-mt-0.5 mb-2 text-xs text-muted-foreground">
          The second model also reads this as separate work
        </p>
      )}
      {shownAnswer ? (
        <p className="text-xs text-muted-foreground" role="status">
          Answered: {aeGateLabel(shownAnswer)}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          {AE_GATE_ROUTES.map(([route, label, hint]) => (
            <button
              key={route}
              type="button"
              title={hint}
              disabled={pending !== null}
              onClick={() => void send(route)}
              className={cn(
                "min-h-7 rounded-md border border-border bg-muted px-2 text-xs whitespace-nowrap hover:bg-muted/70 disabled:cursor-wait disabled:opacity-60",
                pending === route && "animate-pulse",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

// ── absorbed and unfiled ─────────────────────────────────────────────────

interface AeTriageCount {
  label: string;
  count: number;
  lines: string[];
}

/** The counts side by side; the open one lists its lines full width below the row. */
function AeTriageCounts({ counts, loaded }: { counts: AeTriageCount[]; loaded: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const listId = useId();
  const shown = counts.find((item) => item.label === open);
  return (
    <>
      <div className="grid grid-cols-2 gap-x-3">
        {counts.map((item) => (
          <AeTriageHead
            key={item.label}
            item={item}
            open={item.label === open}
            listId={listId}
            onToggle={() => setOpen(item.label === open ? null : item.label)}
          />
        ))}
      </div>
      {shown && <AeTriageLines id={listId} item={shown} loaded={loaded} />}
    </>
  );
}

function AeTriageHead({
  item,
  open,
  listId,
  onToggle,
}: {
  item: AeTriageCount;
  open: boolean;
  listId: string;
  onToggle: () => void;
}) {
  const expandable = item.count > 0 || item.lines.length > 0;
  const head = (
    <>
      {expandable ? (
        <AeRailIcon
          name="chevronRight"
          className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <span>{item.label}</span>
      <span className="ml-auto text-muted-foreground tabular-nums">{item.count}</span>
    </>
  );
  if (!expandable) {
    return <div className="flex min-h-7 items-center gap-1.5">{head}</div>;
  }
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      onClick={onToggle}
      className={cn(
        "-mx-1.5 flex min-h-7 w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-md px-1.5 hover:bg-muted",
        open && "bg-muted",
      )}
    >
      {head}
    </button>
  );
}

function AeTriageLines({ id, item, loaded }: { id: string; item: AeTriageCount; loaded: boolean }) {
  const missing = Math.max(0, item.count - item.lines.length);
  return (
    <ul id={id} aria-label={item.label} className="mb-1 ml-5 space-y-0.5 text-xs">
      {item.lines.map((line, index) => (
        // Two identical lines are still two absorptions.
        // oxlint-disable-next-line react/no-array-index-key
        <li key={index} className="break-words">
          {line}
        </li>
      ))}
      {missing > 0 && (
        <li className="text-muted-foreground">
          {!loaded
            ? "The lines show once this session's messages load."
            : item.lines.length === 0
              ? "The lines are in older messages not loaded here."
              : `${missing} more in older messages not loaded here.`}
        </li>
      )}
    </ul>
  );
}

// ── the parked task ──────────────────────────────────────────────────────

function AeParkedTask({ taskId, active }: { taskId: string; active: boolean }) {
  const lot = useQuery({
    queryKey: ["ae", "rail", "lot"],
    queryFn: fetchAeLotTasks,
    enabled: active,
    staleTime: LOT_STALE_MS,
    retry: false,
  });
  const task = lot.data?.find((row) => row.id === taskId);
  if (task?.url) {
    return (
      <a
        href={task.url}
        target="_blank"
        rel="noopener noreferrer"
        title="Open the parked task in task-store"
        className="-mx-1.5 mt-1 flex min-h-7 w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 text-xs hover:bg-muted"
      >
        <span className="shrink-0 text-muted-foreground">Parked task</span>
        <span className="min-w-0 flex-1 truncate font-medium">{task.title || taskId}</span>
        <AeRailIcon name="external" className="size-3.5 text-muted-foreground" />
      </a>
    );
  }
  let note = "";
  if (lot.isError) {
    const reason = lot.error instanceof Error ? lot.error.message : String(lot.error);
    note = `Could not read the Parking Lot (${reason}); open it from the Session Dashboard.`;
  } else if (lot.data) {
    note = "Not in the open Parking Lot; it may be done.";
  }
  return (
    <div className="mt-1 py-0.5 text-xs">
      <span className="text-muted-foreground">Parked task </span>
      <span className="font-mono">{taskId}</span>
      {note && <p className="text-muted-foreground">{note}</p>}
    </div>
  );
}
