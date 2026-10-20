// The rail's Agents section: each collaborator's own context window (never
// summed), then Claude Code's subagents: running ones with a one-line note on
// what each is doing (its newest step), finished ones under their own Finished group.

import { useState } from "react";
import { RunningDot } from "@/components/RunningDot";
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import { type AeRailSectionProps, useAeRailSectionActive } from "@/lib/aeSessionRail";
import { cn } from "@/lib/utils";
import {
  childElapsedSeconds,
  formatElapsed,
  isChildFinished,
  splitAgentSections,
} from "@/shell/aeAgentsPaneModel";
import { readAeAgentsClearedAt } from "@/shell/AeAgentsSections";
import { childPrimaryLabel } from "@/shell/subagentLabel";
import { activityDotClassName, childStatus } from "@/shell/subagentStatus";
import { useChatStore } from "@/store/chatStore";
import { useAeLimits } from "../AePlanLimits";
import { aeContextIdentity } from "../aeContextUsage";
import {
  type AeContextEntry,
  aeModelName,
  buildCollaboratorContext,
  useAeSessionContexts,
} from "../aeSessionContext";
import { AeRailSection } from "./AeRailSection";
import { useAeRailNow } from "./aeRailNow";
import { useAeSubagentSteps } from "./aeRailSubagentSteps";
import { useAeRailOpenWorkspaceTab } from "./aeRailActions";
import { AE_RAIL_TONE_TEXT, AeRailBar, AeRailIcon, AeRailMuted, AeRailRow } from "./aeRailUi";

/** The popover's own cadence; the section never polls faster. */
const POLL_MS = 60_000;

/** Finished rows the group lists before pointing at the Agents tab. */
const MAX_FINISHED = 8;

/** The Finished group's open state, kept per browser; closed until opened. */
const FINISHED_OPEN_KEY = "ae.rail.agents.finishedOpen";

function readFinishedOpen(): boolean {
  try {
    return window.localStorage.getItem(FINISHED_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFinishedOpen(open: boolean): void {
  try {
    window.localStorage.setItem(FINISHED_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Blocked storage: the choice lasts until the page reloads.
  }
}

function who(entry: AeContextEntry): string | null {
  return [entry.agent, aeModelName(entry.model)].filter(Boolean).join(" · ") || null;
}

/** What a running subagent is doing: a wait on the user, else its newest step. */
function runningNote(
  child: ChildSessionInfo,
  step: string | undefined,
): { text: string; waiting: boolean } | null {
  const pending = child.pending_elicitations_count;
  if (pending > 0) {
    return {
      text: pending === 1 ? "Waiting on you" : `Waiting on you: ${pending} prompts`,
      waiting: true,
    };
  }
  // Never its latest message: for a subagent that is the prompt it was given.
  return step ? { text: step, waiting: false } : null;
}

/** How long a running row has run, or how long ago a finished one stopped. */
function rowTime(child: ChildSessionInfo, nowMs: number): string {
  if (!isChildFinished(child)) {
    return formatElapsed(childElapsedSeconds(child, nowMs), { compact: true });
  }
  const end = child.updated_at ?? child.created_at;
  if (end === undefined) return "";
  return `${formatElapsed(Math.max(0, Math.floor(nowMs / 1000 - end)), { compact: true })} ago`;
}

function SubagentDot({ child }: { child: ChildSessionInfo }) {
  const { activity } = childStatus(child);
  if (activity === "working") return <RunningDot className="mt-0.5" />;
  return (
    <span
      aria-hidden
      className={cn(
        "mt-1 size-2 shrink-0 rounded-full",
        activity === "awaiting" ? "bg-warning" : activityDotClassName(activity),
      )}
    />
  );
}

function SubagentRow({
  child,
  step,
  nowMs,
  onOpen,
}: {
  child: ChildSessionInfo;
  step?: string;
  nowMs: number;
  onOpen?: () => void;
}) {
  const status = childStatus(child);
  const finished = isChildFinished(child);
  const note = finished ? null : runningNote(child, step);
  // A finished row names its outcome only when it did not simply end.
  const outcome =
    finished && (status.activity === "failed" || status.activity === "disconnected")
      ? status.label
      : null;
  const content = (
    <>
      <span className="flex size-3 shrink-0 justify-center">
        <SubagentDot child={child} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate">{childPrimaryLabel(child)}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {rowTime(child, nowMs)}
          </span>
        </span>
        {note && (
          <span
            className={cn(
              "block truncate text-xs",
              note.waiting ? AE_RAIL_TONE_TEXT.warning : "text-muted-foreground",
            )}
          >
            {note.text}
          </span>
        )}
        {outcome && (
          <span
            className={cn(
              "block truncate text-xs",
              status.activity === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {outcome}
          </span>
        )}
      </span>
    </>
  );
  const base = cn("flex w-full items-start gap-2 py-1 text-left", finished && "opacity-75");
  const testProps = {
    "data-testid": "ae-rail-subagent",
    "data-session": child.id,
    "data-activity": status.activity,
  };
  if (!onOpen) {
    return (
      <div className={base} {...testProps}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      title="Open the Agents tab"
      onClick={onOpen}
      className={cn(base, "-mx-1.5 w-[calc(100%+0.75rem)] rounded-md px-1.5 hover:bg-muted")}
      {...testProps}
    >
      {content}
    </button>
  );
}

export function AeRailAgents({ sessionId }: AeRailSectionProps) {
  const harness = useChatStore((s) => (s.conversationId === sessionId ? s.sessionHarness : null));
  const model = useChatStore((s) => (s.conversationId === sessionId ? s.llmModel : null));
  const active = useAeRailSectionActive("agents");
  const sessions = useAeSessionContexts(
    active,
    sessionId,
    POLL_MS,
    aeContextIdentity(harness, model),
  );
  // Claude Code collaborators report their window through the limits relay's status lines.
  const statusLines = useAeLimits(active, sessionId).data?.harnesses.claude?.contexts;
  const [finishedOpen, setFinishedOpen] = useState(readFinishedOpen);
  const openTab = useAeRailOpenWorkspaceTab();
  const openAgents = openTab ? () => openTab("subagents") : undefined;
  // Ticks the elapsed and "ago" times between polls.
  const now = useAeRailNow(active, 10_000);
  const rows = sessions.collaborators.map((c) => ({
    running: c.running !== false,
    entry: buildCollaboratorContext(c, statusLines, now),
  }));
  // Rows cleared in the Agents tab stay cleared here too.
  const split = splitAgentSections(sessions.subagentRows ?? [], readAeAgentsClearedAt(sessionId));
  const runningSubagents = split.running;
  const steps = useAeSubagentSteps(
    active,
    runningSubagents.map((c) => c.id),
  );
  // Newest finish first.
  const finishedSubagents = [...split.finished].sort(
    (a, b) => (b.updated_at ?? b.created_at ?? 0) - (a.updated_at ?? a.created_at ?? 0),
  );
  const running = rows.filter((r) => r.running).length + runningSubagents.length;
  const finished = rows.length - rows.filter((r) => r.running).length + finishedSubagents.length;
  const hidden = sessions.hidden ?? 0;
  const subagentCount = runningSubagents.length + finishedSubagents.length;
  const empty = rows.length === 0 && subagentCount === 0;
  const toggleFinished = () => {
    writeFinishedOpen(!finishedOpen);
    setFinishedOpen(!finishedOpen);
  };
  const summary =
    running > 0 ? `${running} running` : finished > 0 ? `${finished} finished` : undefined;
  return (
    <AeRailSection id="agents" summary={summary}>
      <div className="flex flex-col gap-2 text-sm" data-testid="ae-rail-agents">
        {!empty && running === 0 && <AeRailMuted>Nothing running now.</AeRailMuted>}
        {rows.map(({ entry, running: live }) => {
          const pct = entry.reading ? (entry.reading.used / entry.reading.size) * 100 : null;
          const detail = [who(entry), live ? null : "finished"].filter(Boolean).join(" · ");
          return (
            <div
              key={entry.key}
              className={cn("flex flex-col gap-1", !live && "opacity-70")}
              data-testid="ae-rail-agent"
              data-session={entry.key}
              title={entry.unavailable ?? undefined}
            >
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{entry.name}</span>
                  {detail && (
                    <span className="block truncate text-xs text-muted-foreground">{detail}</span>
                  )}
                </span>
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    pct === null ? "text-xs text-muted-foreground" : "font-semibold",
                  )}
                >
                  {pct === null ? "No reading" : `${Math.round(pct)}%`}
                </span>
              </div>
              <AeRailBar pct={pct ?? 0} />
            </div>
          );
        })}
        {runningSubagents.length > 0 && (
          <div className="flex flex-col">
            {runningSubagents.map((child) => (
              <SubagentRow
                key={child.id}
                child={child}
                step={steps[child.id]}
                nowMs={now}
                onOpen={openAgents}
              />
            ))}
          </div>
        )}
        {finishedSubagents.length > 0 && (
          <div className="flex flex-col border-t border-border/60 pt-1">
            <button
              type="button"
              onClick={toggleFinished}
              aria-expanded={finishedOpen}
              data-testid="ae-rail-agents-finished-toggle"
              className="-mx-1.5 flex min-h-7 w-[calc(100%+0.75rem)] items-center gap-1 rounded-md px-1.5 text-left hover:bg-muted"
            >
              <AeRailIcon
                name={finishedOpen ? "chevronDown" : "chevronRight"}
                className="size-3.5 text-muted-foreground"
              />
              <span className="flex-1">Finished</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {finishedSubagents.length}
              </span>
            </button>
            {finishedOpen &&
              finishedSubagents
                .slice(0, MAX_FINISHED)
                .map((child) => (
                  <SubagentRow key={child.id} child={child} nowMs={now} onOpen={openAgents} />
                ))}
            {finishedOpen && finishedSubagents.length > MAX_FINISHED && (
              <AeRailMuted>
                {finishedSubagents.length - MAX_FINISHED} more in the Agents tab.
              </AeRailMuted>
            )}
          </div>
        )}
        {subagentCount > 0 && openAgents && (
          <AeRailRow
            title="Open the Agents tab"
            onClick={openAgents}
            className="text-xs text-muted-foreground"
            trailing={<AeRailIcon name="chevronRight" className="size-3.5" />}
          >
            Open the Agents tab
          </AeRailRow>
        )}
        {hidden > 0 && (
          <AeRailMuted>
            {hidden} more {hidden === 1 ? "agent" : "agents"} not shown.
          </AeRailMuted>
        )}
        {sessions.error && (
          <AeRailMuted className="text-destructive">
            Could not list this session's agents ({sessions.error}). The section retries within a
            minute.
          </AeRailMuted>
        )}
        {empty && !sessions.error && (
          <AeRailMuted>
            {sessions.loading ? "Loading agents…" : "No agents have run in this session."}
          </AeRailMuted>
        )}
      </div>
    </AeRailSection>
  );
}
