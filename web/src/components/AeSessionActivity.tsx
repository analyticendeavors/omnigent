// What the session is doing, drawn twice: a compact sidebar badge (quiet,
// waiting, scheduled) and the chat status line above the composer (working,
// quiet, waiting, scheduled). Both read the same derivation in
// `@/lib/aeSessionActivity`, so they never disagree.

import type { ReactElement, ReactNode } from "react";
import { AE_RAIL_ICONS } from "@/components/aeRail/aeRailIcons";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrandLogo } from "@/components/BrandLogo";
import { workingIndicatorLabel } from "@/components/chat/chatBubbleParts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  useAeChatActivity,
  useAeRegisterWaitingLine,
  type AeAgentChip,
} from "@/hooks/aeSessionActivityHooks";
import {
  aeDuration,
  aeFormatAgo,
  aeQuietLabel,
  aeScheduledDetail,
  aeScheduledHeadline,
  aeScheduledTooltip,
  aeShortRunTime,
  aeStepBody,
  aeStepVerb,
  aeWaitingLabel,
  isAeSessionState,
  type AeSessionState,
  type AeStep,
} from "@/lib/aeSessionActivity";
import {
  AE_NO_OUTPUT_HINT,
  aeProgressText,
  aeShowsNoOutputHint,
  type AeSessionProgress,
} from "@/lib/aeSessionProgress";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";
import type { BackgroundTaskInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Tabler outline nodes (tabler.io/icons); hourglass and terminal-2 copied from @tabler/icons. */
export const AE_ACTIVITY_ICONS = {
  hourglass: [
    ["path", { d: "M6.5 7h11" }],
    ["path", { d: "M6.5 17h11" }],
    ["path", { d: "M6 20v-2a6 6 0 1 1 12 0v2a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1" }],
    ["path", { d: "M6 4v2a6 6 0 1 0 12 0v-2a1 1 0 0 0 -1 -1h-10a1 1 0 0 0 -1 1" }],
  ],
  terminal: [
    ["path", { d: "M8 9l3 3l-3 3" }],
    ["path", { d: "M13 15l3 0" }],
    [
      "path",
      { d: "M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12" },
    ],
  ],
  robot: AE_RAIL_ICONS.robot,
  alarm: AE_RAIL_ICONS.alarm,
  loader: AE_RAIL_ICONS.loader,
} satisfies Record<string, AeTablerIconNode>;

const PULSE = "motion-safe:animate-pulse [animation-duration:2.4s]";
const SLOW_SPIN = "motion-safe:animate-spin [animation-duration:1.8s]";

// ── Sidebar badge ────────────────────────────────────────────────────

/** The activity badges carry a number or time beside the icon, so they need more than a dot slot. */
export function aeIsWideMarker(state: { kind: string } | null): boolean {
  return state !== null && isAeSessionState(state);
}

/**
 * Title padding a row keeps clear of a wide badge. A scheduled time ("9:30 PM",
 * or a longer locale's day period) needs more than a count or "12m" does.
 */
export function aeWideMarkerReserve(state: { kind: string } | null, shared: boolean): string {
  if (state?.kind === "scheduled") return shared ? "pr-26" : "pr-20";
  return shared ? "pr-20" : "pr-14";
}

export interface AeBadgeVisual {
  /** Quiet reports `running`: it is still a running turn to upstream styling and tests. */
  kind: Exclude<AeSessionState["kind"], "quiet"> | "running";
  ariaLabel: string;
  tooltip: string;
  render: () => ReactElement;
}

/** The sidebar visual for an activity state; see `SessionStateBadge`. */
export function aeDescribeSessionState(state: AeSessionState, now = Date.now()): AeBadgeVisual {
  if (state.kind === "waiting") {
    const label = aeWaitingLabel(state.agents, 0);
    const tooltip =
      state.sinceEventMs === null
        ? label
        : `${label} · last update ${aeFormatAgo(state.sinceEventMs)}`;
    return {
      kind: state.kind,
      ariaLabel: label,
      tooltip,
      render: () => (
        <span data-ae-activity="waiting" className="inline-flex items-center gap-1">
          <AeTablerSvg
            node={AE_ACTIVITY_ICONS.hourglass}
            className={cn("size-3.5 text-info", PULSE)}
          />
          <span className="inline-grid h-4 min-w-4 place-items-center rounded-full bg-muted px-1 text-[10px] leading-none text-foreground tabular-nums">
            {state.agents}
          </span>
        </span>
      ),
    };
  }
  if (state.kind === "scheduled") {
    const next = { at: state.at, waker: state.waker };
    const tooltip = aeScheduledTooltip(next, now);
    return {
      kind: state.kind,
      ariaLabel: tooltip,
      tooltip,
      render: () => (
        <span
          data-ae-activity="scheduled"
          className="inline-flex items-center gap-1 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums"
        >
          <AeTablerSvg node={AE_ACTIVITY_ICONS.alarm} className="size-3.5 shrink-0" />
          {aeShortRunTime(state.at, now)}
        </span>
      ),
    };
  }
  const tooltip = aeQuietLabel(state.quietForMs);
  return {
    kind: "running",
    ariaLabel: tooltip,
    tooltip,
    render: () => (
      <span
        data-ae-activity="quiet"
        className="inline-flex items-center gap-1 text-[11px] text-warning tabular-nums"
      >
        <AeTablerSvg node={AE_ACTIVITY_ICONS.loader} className={cn("size-3 shrink-0", SLOW_SPIN)} />
        {aeDuration(state.quietForMs, true)}
      </span>
    ),
  };
}

// ── Chat status line ─────────────────────────────────────────────────

function StepText({ step, now, lead }: { step: AeStep; now: number; lead: "Now" | "Last step" }) {
  const elapsed = step.startedAt === null ? null : aeDuration(now - step.startedAt, lead !== "Now");
  return (
    <>
      {lead}: {aeStepVerb(step.title)}{" "}
      <code className="inline-block max-w-[22ch] truncate rounded bg-muted px-1 align-bottom font-mono text-xs sm:max-w-[48ch]">
        {aeStepBody(step.title)}
      </code>
      {elapsed !== null && (lead === "Now" ? ` for ${elapsed}` : ` (${elapsed})`)}
    </>
  );
}

function ProgressText({ progress, now }: { progress: AeSessionProgress; now: number }) {
  return (
    <div data-testid="ae-activity-progress" className="truncate text-xs text-muted-foreground">
      {aeProgressText(progress, now)}
    </div>
  );
}

/** The later of two optional epoch-ms times; a turn that just started is not silent. */
function aeLatest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  return b === null ? a : Math.max(a, b);
}

/** Under "Working": the running tool, else the terminal's spinner, else a hint after a silent minute. */
function WorkingDetail({
  step,
  progress,
  lastContentAt,
  now,
}: {
  step: AeStep | null;
  progress: AeSessionProgress | null;
  lastContentAt: number | null;
  now: number;
}) {
  if (step?.running) {
    return (
      <div className="truncate text-xs text-muted-foreground">
        <StepText step={step} now={now} lead="Now" />
      </div>
    );
  }
  if (progress) return <ProgressText progress={progress} now={now} />;
  if (!aeShowsNoOutputHint(lastContentAt, now)) return null;
  return (
    <div data-testid="ae-activity-no-output" className="text-xs text-muted-foreground">
      {AE_NO_OUTPUT_HINT}
    </div>
  );
}

/** "Working", or why the turn is parked (a terminal dialog, say). */
function WorkingLabel({ blockedOn }: { blockedOn: string | null }) {
  return (
    <Shimmer className="font-mono text-sm" duration={1.5}>
      {blockedOn ? workingIndicatorLabel(0, blockedOn) : "Working"}
    </Shimmer>
  );
}

function StatusRow({
  icon,
  children,
  aside,
  testId,
  state,
}: {
  icon: ReactElement;
  children: ReactNode;
  aside?: string | null;
  testId: string;
  state: string;
}) {
  return (
    <Message from="assistant" data-testid={testId} data-ae-activity={state}>
      <MessageContent className="w-full">
        <div className="flex w-full flex-wrap items-start gap-x-3 gap-y-0.5 py-0.5">
          <div className="flex min-w-0 grow basis-64 items-start gap-1.5">
            <span className="mt-0.5 flex h-4 shrink-0 items-center">{icon}</span>
            <div className="min-w-0 flex-1">{children}</div>
          </div>
          {aside && (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
              {aside}
            </span>
          )}
        </div>
      </MessageContent>
    </Message>
  );
}

function AgentChip({ agent, now }: { agent: AeAgentChip; now: number }) {
  return (
    <span
      data-testid="ae-activity-agent-chip"
      data-needs-approval={agent.needsApproval || undefined}
      title={agent.needsApproval ? `${agent.label} (needs approval)` : agent.label}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs",
        agent.needsApproval ? "border-warning/60" : "border-border",
      )}
    >
      <AeTablerSvg node={AE_ACTIVITY_ICONS.robot} className="size-3.5 shrink-0" />
      <span className="truncate">{agent.label}</span>
      {agent.needsApproval ? (
        <span className="shrink-0 font-medium text-warning">needs approval</span>
      ) : (
        agent.startedAt !== null && (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {aeDuration(now - agent.startedAt, true)}
          </span>
        )
      )}
    </span>
  );
}

function shellLabel(task: BackgroundTaskInfo): string {
  return task.description?.trim() || task.command?.trim() || "Background shell";
}

/** A shell chip opens the full description and command, as the composer pill did. */
function ShellChip({ task }: { task: BackgroundTaskInfo }) {
  const label = shellLabel(task);
  const command = task.command?.trim();
  return (
    <Popover modal={false}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="ae-activity-shell-chip"
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted"
        >
          <AeTablerSvg node={AE_ACTIVITY_ICONS.terminal} className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={8}
        className="w-80 max-w-[90vw] p-3"
      >
        <div className="flex flex-col gap-1">
          <span className="text-sm text-foreground [overflow-wrap:anywhere]">{label}</span>
          {command && command !== label && (
            <span className="whitespace-pre-wrap font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {command}
            </span>
          )}
          {task.status && <span className="text-xs text-muted-foreground">{task.status}</span>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The status line at the foot of the transcript. `showsWorking` is the page's
 * working gate; needs-a-response states render nothing here (the question
 * card owns them).
 */
export function AeSessionActivityLine({ showsWorking }: { showsWorking: boolean }) {
  const data = useAeChatActivity(showsWorking);
  const { activity, now } = data;
  useAeRegisterWaitingLine(
    data.conversationId,
    activity.kind === "waiting" && data.shells.length > 0,
  );
  const ago = data.lastEventAt === null ? null : aeFormatAgo(Math.max(0, now - data.lastEventAt));

  if (activity.kind === "working") {
    const elapsed = data.turnStartedAt === null ? null : aeDuration(now - data.turnStartedAt);
    return (
      <>
        <span role="status" aria-live="polite" className="sr-only">
          Working…
        </span>
        <StatusRow
          testId="working-indicator"
          state="working"
          aside={ago && `last activity ${ago}`}
          icon={<BrandLogo variant="icon" className="otto-working h-4 w-auto shrink-0" />}
        >
          <div className="flex flex-wrap items-baseline gap-x-1.5" aria-hidden="true">
            <WorkingLabel blockedOn={data.blockedOn} />
            {elapsed && <span className="text-sm text-muted-foreground">· {elapsed}</span>}
          </div>
          <WorkingDetail
            step={data.step}
            progress={data.progress}
            lastContentAt={aeLatest(data.lastEventAt, data.turnStartedAt)}
            now={now}
          />
        </StatusRow>
      </>
    );
  }

  if (activity.kind === "quiet") {
    return (
      <>
        <span role="status" aria-live="polite" className="sr-only">
          Still working, no new output
        </span>
        <StatusRow
          testId="working-indicator"
          state="quiet"
          aside={ago && `last activity ${ago}`}
          icon={
            <AeTablerSvg
              node={AE_ACTIVITY_ICONS.loader}
              className={cn("size-3.5 text-warning", SLOW_SPIN)}
            />
          }
        >
          <div className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
            <span className="font-medium text-warning">Still working</span>
            <span className="text-muted-foreground">
              · no new output for {aeDuration(activity.quietForMs, true)}
            </span>
          </div>
          {data.progress && <ProgressText progress={data.progress} now={now} />}
          <div className="text-xs text-muted-foreground">
            {data.step && (
              <>
                <StepText step={data.step} now={now} lead="Last step" />.{" "}
              </>
            )}
            Long runs are often quiet; the Stop button still works.
          </div>
        </StatusRow>
      </>
    );
  }

  if (activity.kind === "waiting") {
    return (
      <StatusRow
        testId="ae-activity-line"
        state="waiting"
        icon={
          <AeTablerSvg
            node={AE_ACTIVITY_ICONS.hourglass}
            className={cn("size-3.5 text-info", PULSE)}
          />
        }
      >
        <div className="text-sm font-medium" role="status">
          {activity.label}
        </div>
        <div className="text-xs text-muted-foreground">
          The session picks up when they report.
          {ago && ` Last update ${ago}.`}
        </div>
        {data.agents.length + data.shells.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {data.agents.map((agent) => (
              <AgentChip key={agent.id} agent={agent} now={now} />
            ))}
            {data.shells.map((task, i) => (
              <ShellChip key={task.id ?? `shell-${i}`} task={task} />
            ))}
          </div>
        )}
      </StatusRow>
    );
  }

  if (activity.kind === "scheduled") {
    const next = { at: activity.at, waker: activity.waker };
    return (
      <StatusRow
        testId="ae-activity-line"
        state="scheduled"
        icon={
          <AeTablerSvg node={AE_ACTIVITY_ICONS.alarm} className="size-3.5 text-muted-foreground" />
        }
      >
        <div className="text-sm font-medium">{aeScheduledHeadline(next, now)}</div>
        <div className="text-xs text-muted-foreground">{aeScheduledDetail(next)}</div>
      </StatusRow>
    );
  }

  return null;
}
