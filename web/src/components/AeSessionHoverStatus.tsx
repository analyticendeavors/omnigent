// The sidebar hover card's status block: what a session is doing right now,
// read from the row's own state so it matches the row's icon, with its step,
// question, agents or last reply fetched only while the card is open.

import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useContext, useEffect, useState } from "react";
import { RunningDot } from "@/components/RunningDot";
import { type ChildSessionInfo, fetchChildSessions } from "@/hooks/useChildSessions";
import type { SessionState } from "@/hooks/useSessionState";
import { useAeRoles } from "@/hooks/useAeRoles";
import { aeAgentRole, aeFormatCost, aeFormatTokens, aeRoleName } from "@/lib/aeAgentRole";
import { AE_MODEL_FAMILY_BG, aeModelFamily, useAeSessionUsages } from "@/lib/aeAgentUsage";
import type { Conversation } from "@/hooks/useConversations";
import { aeFamilyParent, aeOrchParent } from "@/lib/aeFamily";
import { AE_FAMILY_BADGES } from "@/lib/aeFamilyBadge";
import { type AeRaiseDetail, aeModelPointText, aeRaiseDetail } from "@/lib/aeModelChange";
import { relativeTime } from "@/lib/relativeTime";
import { aeIsClosedMember } from "@/lib/aeFamilyClosed";
import { aeSpendLabel, useAeSpendDisplay } from "@/lib/aeSpendDisplay";
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

/** One label and value row of the family block, as the card's details rows read. */
function FamilyRow({
  label,
  testId,
  title,
  children,
}: {
  label: string;
  testId: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex items-center justify-between gap-3" title={title}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate tabular-nums">{children}</span>
    </div>
  );
}

/** The sessions under *id* in its family: its children, theirs, and so on. */
function descendantsOf(members: readonly Conversation[], id: string): Conversation[] {
  const childrenOf = new Map<string, Conversation[]>();
  for (const m of members) {
    const parent = aeFamilyParent(m.labels);
    if (!parent || parent === m.id) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(m);
    else childrenOf.set(parent, [m]);
  }
  const out: Conversation[] = [];
  const seen = new Set([id]);
  const walk = (at: string) => {
    for (const c of childrenOf.get(at) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

/**
 * A family's block above the status (2026-10-26): on a lead, its preset, its
 * sessions open and closed, the family total as Spend shows sets it, and the open
 * sessions by name; on a child that started sessions of its own, the same for
 * those. The lead row itself shows only its name (patch 0184), so this is where
 * the counts live.
 */
function AeFamilyBlock({
  sessionId,
  labels,
  updatedAt,
}: {
  sessionId: string;
  labels: Record<string, string> | undefined;
  updatedAt: number;
}) {
  const { families } = useContext(AeFamilyContext);
  const familyRole = families.byRow.get(sessionId);
  if (!familyRole) return null;
  const { family } = familyRole;
  const isLead = familyRole.isLead && family.members.length > 1;
  const under = isLead ? [] : descendantsOf(family.members, sessionId);
  if (!isLead && under.length === 0) return null;
  const self = family.members.find((m) => m.id === sessionId);
  // Its own component, so a session that leads nothing reads no roles or usage.
  return (
    <FamilyBlockBody
      sessionId={sessionId}
      heading={isLead ? "Family" : "Its sessions"}
      members={isLead ? family.members : self ? [self, ...under] : under}
      isLead={isLead}
      labels={labels}
      updatedAt={updatedAt}
    />
  );
}

/** Open sessions the block names; "+N more" covers the rest. */
const MAX_NAMED = 4;

type MemberState = "waiting" | "working" | "idle";

function memberState(c: Conversation): MemberState {
  if ((c.pending_elicitations_count ?? 0) > 0) return "waiting";
  if (c.turn_active === true || c.status === "running") return "working";
  return "idle";
}

const STATE_TEXT: Record<MemberState, string> = {
  waiting: "waits on you",
  working: "working",
  idle: "idle",
};
const STATE_RANK: Record<MemberState, number> = { waiting: 0, working: 1, idle: 2 };

/** "3 open · 6 closed", leaving out a side that is zero. */
export function aeFamilyCountText(open: number, closed: number): string {
  if (closed <= 0) return `${open} open`;
  if (open <= 0) return `${closed} closed`;
  return `${open} open \u00b7 ${closed} closed`;
}

function FamilyBlockBody({
  sessionId,
  heading,
  members,
  isLead,
  labels,
  updatedAt,
}: {
  sessionId: string;
  heading: string;
  /** The sessions it covers, the hovered one included. */
  members: readonly Conversation[];
  isLead: boolean;
  labels: Record<string, string> | undefined;
  updatedAt: number;
}) {
  const { tree } = useContext(AeFamilyContext);
  const roles = useAeRoles();
  const mode = useAeSpendDisplay();
  // The total is every covered session's use, each read once.
  const usage = useAeSessionUsages(
    members.map((m) => ({ id: m.id, stamp: m.id === sessionId ? updatedAt : 0 })),
  );
  const others = members.filter((m) => m.id !== sessionId);
  const openOthers = others.filter((m) => !aeIsClosedMember(m));
  // Grouping > Family also counts a lead's archived children, as its "N closed" row does.
  const treeLead = isLead ? tree?.leads.get(sessionId) : undefined;
  const count = treeLead?.count ?? others.length;
  const open = treeLead ? (treeLead.closed?.open ?? treeLead.count) : openOthers.length;
  const spend = aeSpendLabel(usage.values(), mode);
  const spendRows =
    spend && mode === "both" && spend.parts
      ? [spend.parts.tokens, spend.parts.cost].filter((p): p is NonNullable<typeof p> => !!p)
      : spend
        ? [spend]
        : [];
  const presetId = isLead ? labels?.["ae.preset"] : undefined;
  const preset = roles.data?.presets.find((p) => p.id === presetId)?.title ?? null;
  const named = [...openOthers].sort(
    (a, b) =>
      STATE_RANK[memberState(a)] - STATE_RANK[memberState(b)] || b.updated_at - a.updated_at,
  );
  const shown = named.slice(0, MAX_NAMED);
  return (
    <div
      className="mt-2.5 flex flex-col gap-1 border-t border-border pt-2.5 text-sm"
      data-testid="ae-hover-family"
      data-kind={isLead ? "family" : "own"}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {heading}
      </p>
      {preset && (
        // Truncates in the narrow card; the title holds the whole name.
        <FamilyRow label="Preset" testId="ae-hover-family-preset" title={preset}>
          {preset}
        </FamilyRow>
      )}
      <FamilyRow label="Sessions" testId="ae-hover-family-sessions">
        {aeFamilyCountText(open, count - open)}
      </FamilyRow>
      {spendRows.map((row) => (
        <FamilyRow
          key={row.unit}
          label={row.unit === "estimated" ? "Cost" : "Tokens"}
          testId={
            spendRows.length > 1
              ? `ae-hover-family-spend-${row.unit === "estimated" ? "cost" : "tokens"}`
              : "ae-hover-family-spend"
          }
          title={row.title}
        >
          {row.long.replace(/ tokens$/, "")}
        </FamilyRow>
      ))}
      {shown.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1" data-testid="ae-hover-family-open">
          {shown.map((m) => {
            const state = memberState(m);
            const role = aeAgentRole({ labels: m.labels });
            const badge = role ? AE_FAMILY_BADGES[role] : undefined;
            const raised = aeRaiseDetail(m.labels, null) !== null;
            return (
              <li key={m.id} className="flex min-w-0 items-center gap-1.5" data-state={state}>
                {badge ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-bold",
                      badge.className,
                    )}
                  >
                    {badge.letter}
                  </span>
                ) : (
                  <span aria-hidden="true" className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{m.title ?? m.id}</span>
                <span
                  className={cn(
                    "shrink-0 text-xs",
                    state === "waiting" ? "text-brand-accent" : "text-muted-foreground",
                  )}
                >
                  {STATE_TEXT[state]}
                  {raised && (
                    <span className="ml-1 text-amber-500" title="Raised above where it started">
                      {"\u2191"}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
          {named.length > shown.length && (
            <li className="text-xs text-muted-foreground" data-testid="ae-hover-family-more">
              +{named.length - shown.length} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * A raised helper's change: where it started, when and how often it was raised,
 * and why (2026-10-26). The row's arrow only says that it was raised.
 */
function RaiseLine({ raise }: { raise: AeRaiseDetail }) {
  const ago = raise.at !== null ? relativeTime(raise.at * 1000) : "";
  const parts = [
    `Raised from ${aeModelPointText(raise.start)}`,
    ago ? (ago === "now" ? "just now" : `${ago} ago`) : null,
    raise.capReached ? "cap reached" : raise.raises > 1 ? `${raise.raises} raises` : null,
  ].filter(Boolean);
  return (
    <>
      <p className="truncate text-xs text-muted-foreground" data-testid="ae-hover-raise-line">
        <span aria-hidden="true" className="mr-1 text-amber-500">
          {"\u2191"}
        </span>
        {parts.join(" \u00b7 ")}
      </p>
      {raise.reason && (
        // Two lines at most; the title holds the whole reason.
        <p
          className="line-clamp-2 text-xs text-muted-foreground"
          data-testid="ae-hover-raise-reason"
          title={raise.reason}
        >
          {raise.reason}
        </p>
      )}
    </>
  );
}

/** Third line: a started session's role, model and use. A lead's family: `AeFamilyBlock`. */
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
  const mode = useAeSpendDisplay();
  const role = aeAgentRole({ labels });
  const familyRole = families.byRow.get(sessionId);
  const started = role !== null || aeOrchParent(labels) !== null;
  const lead = familyRole?.isLead === true && familyRole.family.members.length > 1;
  // A child shows its own use; a lead's family total is AeFamilyBlock's.
  const ids = !lead && started ? [sessionId] : [];
  const usage = useAeSessionUsages(
    ids.map((id) => ({ id, stamp: id === sessionId ? updatedAt : 0 })),
    { enabled: ids.length > 0 },
  );
  if (lead || !started) return null;
  const own = usage.get(sessionId);
  const ownSpend = own ? aeSpendLabel([own], mode) : null;
  const raise = aeRaiseDetail(
    labels,
    own ? { model: own.model ?? null, effort: own.effort ?? null } : null,
  );
  const detail = [
    own?.model ? agentModelLabel(own.model) : null,
    own?.effort,
    ...(mode === "cost"
      ? [
          own?.costUsd != null ? aeFormatCost(own.costUsd) : null,
          own?.tokens != null && own.tokens > 0 ? `${aeFormatTokens(own.tokens)} tokens` : null,
        ]
      : [ownSpend?.long]),
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
      {raise && <RaiseLine raise={raise} />}
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
    <>
      <AeFamilyBlock sessionId={sessionId} labels={labels} updatedAt={updatedAt} />
      <div
        className="mt-2.5 flex flex-col gap-1 border-t border-border pt-2.5"
        data-testid="ae-hover-status"
        data-kind={kind}
      >
        {body}
        <AeRoleLine sessionId={sessionId} labels={labels} updatedAt={updatedAt} />
      </div>
    </>
  );
}
