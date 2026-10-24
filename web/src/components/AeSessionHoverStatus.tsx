// The sidebar hover card's status block: what a session is doing right now,
// read from the row's own state so it matches the row's icon, with its step,
// question, agents or last reply fetched only while the card is open.

import { useQuery } from "@tanstack/react-query";
import { useContext, useEffect, useState } from "react";
import { RunningDot } from "@/components/RunningDot";
import { type ChildSessionInfo, fetchChildSessions } from "@/hooks/useChildSessions";
import type { SessionState } from "@/hooks/useSessionState";
import { useAeRoles } from "@/hooks/useAeRoles";
import { aeAgentRole, aeFormatCost, aeFormatTokens, aeRoleName } from "@/lib/aeAgentRole";
import {
  AE_MODEL_FAMILY_BG,
  aeSpendOf,
  type AeSessionUsage,
  aeModelFamily,
  useAeSessionUsages,
} from "@/lib/aeAgentUsage";
import { aeOrchParent } from "@/lib/aeFamily";
import { AeFamilyContext } from "@/lib/aeFamilyView";
import { fetchAeSessionPeek } from "@/lib/aeSessionPeek";
import { aeDuration, aeScheduledTooltip, aeWaitingLabel } from "@/lib/aeSessionActivity";
import { cn } from "@/lib/utils";
import { agentModelLabel, isChildFinished } from "@/shell/aeAgentsPaneModel";
import { childPrimaryLabel } from "@/shell/subagentLabel";
import { AE_RAIL_TONE_TEXT } from "./aeRail/aeRailUi";
import { useAeSubagentSteps } from "./aeRail/aeRailSubagentSteps";

/** A hover within this long reuses the last read instead of fetching again. */
const PEEK_STALE_MS = 15_000;

/** How often an open card re-reads, so it follows the session as it moves on. */
const PEEK_POLL_MS = 5_000;

/** Running agents the block names; the Agents tab lists the rest. */
const MAX_AGENTS = 2;

type Tone = "normal" | "warning";

function Head({
  icon,
  label,
  tone = "normal",
}: {
  icon: "spin" | "dot";
  label: string;
  tone?: Tone;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-sm",
        tone === "warning" && AE_RAIL_TONE_TEXT.warning,
      )}
    >
      {icon === "spin" ? (
        <RunningDot className={cn(tone === "warning" && "text-current")} />
      ) : (
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-current opacity-70" />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  );
}

function Line({ lead, text, code }: { lead: string; text: string; code?: boolean }) {
  return (
    <p className="truncate text-xs text-muted-foreground" data-testid="ae-hover-status-line">
      {lead}{" "}
      {code ? (
        <code className="rounded bg-muted px-1 font-mono text-[11px] text-foreground">{text}</code>
      ) : (
        text
      )}
    </p>
  );
}

function RunningAgents({ sessionId, updatedAt }: { sessionId: string; updatedAt: number }) {
  const children = useQuery({
    queryKey: ["ae-hover-status-agents", sessionId, updatedAt],
    queryFn: () => fetchChildSessions(sessionId),
    staleTime: PEEK_STALE_MS,
    refetchInterval: PEEK_POLL_MS,
    placeholderData: (previous) => previous,
  });
  const running = (children.data ?? []).filter((c: ChildSessionInfo) => !isChildFinished(c));
  const shown = running.slice(0, MAX_AGENTS);
  const steps = useAeSubagentSteps(
    true,
    shown.map((c) => c.id),
  );
  return (
    <>
      {shown.map((child) => (
        <p
          key={child.id}
          className="flex min-w-0 items-center gap-1.5 text-xs"
          data-testid="ae-hover-status-agent"
        >
          <RunningDot className="size-2.5" />
          <span className="max-w-[60%] truncate">{childPrimaryLabel(child)}</span>
          {steps[child.id] && (
            <span className="min-w-0 truncate text-muted-foreground">· {steps[child.id]}</span>
          )}
        </p>
      ))}
      {running.length > MAX_AGENTS && (
        <p className="text-xs text-muted-foreground">
          {running.length - MAX_AGENTS} more in the Agents tab
        </p>
      )}
    </>
  );
}

function LeadLine({
  labels,
  count,
  usage,
}: {
  labels: Record<string, string> | undefined;
  count: number;
  usage: ReadonlyMap<string, AeSessionUsage>;
}) {
  const roles = useAeRoles();
  const spend = aeSpendOf(usage.values());
  const presetId = labels?.["ae.preset"];
  const title = roles.data?.presets.find((p) => p.id === presetId)?.title ?? null;
  const parts = [
    title,
    `leads ${count} session${count === 1 ? "" : "s"}`,
    spend
      ? `family ${spend.kind === "cost" ? aeFormatCost(spend.value) : `${aeFormatTokens(spend.value)} tokens`}`
      : null,
  ].filter(Boolean);
  return (
    <p className="truncate text-xs text-muted-foreground" data-testid="ae-hover-lead-line">
      {parts.join(" · ")}
    </p>
  );
}

/** Third line: a started session's role, model and use, or a lead's preset and family total. */
function AeRoleLine({
  sessionId,
  labels,
  updatedAt,
}: {
  sessionId: string;
  labels: Record<string, string> | undefined;
  updatedAt: number;
}) {
  const { families } = useContext(AeFamilyContext);
  const role = aeAgentRole({ labels });
  const familyRole = families.byRow.get(sessionId);
  const started = role !== null || aeOrchParent(labels) !== null;
  const lead =
    familyRole?.isLead === true && familyRole.family.members.length > 1 ? familyRole.family : null;
  // A lead's total is its family's sessions, each read once; a child shows its own use.
  const ids = lead ? lead.members.map((m) => m.id) : started ? [sessionId] : [];
  const usage = useAeSessionUsages(
    ids.map((id) => ({ id, stamp: id === sessionId ? updatedAt : 0 })),
    { enabled: ids.length > 0 },
  );
  if (lead) {
    return <LeadLine labels={labels} count={lead.members.length - 1} usage={usage} />;
  }
  if (!started) return null;
  const own = usage.get(sessionId);
  const detail = [
    own?.model ? agentModelLabel(own.model) : null,
    own?.effort,
    own?.costUsd != null ? aeFormatCost(own.costUsd) : null,
    own?.tokens != null && own.tokens > 0 ? `${aeFormatTokens(own.tokens)} tokens` : null,
  ].filter(Boolean);
  return (
    <>
      <p
        className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        data-testid="ae-hover-role-line"
      >
        {role && (
          <span className="shrink-0 rounded bg-foreground/[0.07] px-1.5 text-[10px] font-medium uppercase tracking-wide">
            {aeRoleName(role)}
          </span>
        )}
        {own?.model && (
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              AE_MODEL_FAMILY_BG[aeModelFamily(own.model)],
            )}
          />
        )}
        <span className="min-w-0 truncate">{detail.join(" · ")}</span>
      </p>
      {familyRole?.parentTitle && (
        <p className="truncate text-xs text-muted-foreground" data-testid="ae-hover-started-by">
          Started by {familyRole.parentTitle}
        </p>
      )}
    </>
  );
}

/**
 * The status block under a session's title in the sidebar hover card.
 *
 * :param sessionId: The hovered session.
 * :param state: The row's own state, the same one its icon shows.
 * :param updatedAt: Epoch ms of the session's last update; a new one re-reads at once.
 * :param labels: The session's labels, for its role and preset.
 */
export function AeSessionHoverStatus({
  sessionId,
  state,
  updatedAt,
  labels,
}: {
  sessionId: string;
  state: SessionState | null;
  updatedAt: number;
  labels?: Record<string, string>;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const kind = state?.kind ?? "idle";
  const needsPeek = kind !== "scheduled" && kind !== "waiting" && kind !== "starting";
  const peek = useQuery({
    queryKey: ["ae-hover-status-peek", sessionId, kind, updatedAt],
    queryFn: ({ signal }) => fetchAeSessionPeek(sessionId, signal),
    enabled: needsPeek,
    staleTime: PEEK_STALE_MS,
    refetchInterval: needsPeek ? PEEK_POLL_MS : false,
    placeholderData: (previous) => previous,
  }).data;

  let body;
  if (state?.kind === "running" || state?.kind === "starting") {
    const since = peek?.turnStartedAt ?? null;
    body = (
      <>
        <Head
          icon="spin"
          label={since === null ? "Working" : `Working · ${aeDuration(now - since)}`}
        />
        {peek?.step && (
          <Line lead={peek.stepRunning ? "Now:" : "Last step:"} text={peek.step} code />
        )}
      </>
    );
  } else if (state?.kind === "quiet") {
    body = (
      <>
        <Head
          icon="spin"
          label={`Quiet for ${aeDuration(state.quietForMs, true)}`}
          tone="warning"
        />
        {peek?.step && <Line lead="Last step:" text={peek.step} code />}
      </>
    );
  } else if (state?.kind === "awaiting") {
    body = (
      <>
        <Head icon="dot" label="Waiting on you" tone="warning" />
        {peek?.question ? (
          <Line lead="Asks:" text={peek.question} />
        ) : peek?.step && peek.stepRunning ? (
          <Line lead="Approve:" text={peek.step} code />
        ) : (
          <Line lead="Asks:" text="a permission request" />
        )}
      </>
    );
  } else if (state?.kind === "waiting") {
    body = (
      <>
        <Head icon="spin" label={aeWaitingLabel(state.agents, 0)} />
        <RunningAgents sessionId={sessionId} updatedAt={updatedAt} />
      </>
    );
  } else if (state?.kind === "scheduled") {
    body = (
      <Head icon="dot" label={aeScheduledTooltip({ at: state.at, waker: state.waker }, now)} />
    );
  } else {
    const failed = state?.kind === "error" || state?.kind === "disconnected";
    body = (
      <>
        <Head icon="dot" label={failed ? "Stopped with an error" : "Idle"} />
        {failed && peek?.lastError ? (
          <Line lead="Error:" text={peek.lastError} />
        ) : (
          peek?.lastReply && <Line lead="Last reply:" text={peek.lastReply} />
        )}
      </>
    );
  }

  return (
    <div
      className="mt-2.5 flex flex-col gap-1 border-t border-border pt-2.5"
      data-testid="ae-hover-status"
      data-kind={kind}
    >
      {body}
      <AeRoleLine sessionId={sessionId} labels={labels} updatedAt={updatedAt} />
    </div>
  );
}
