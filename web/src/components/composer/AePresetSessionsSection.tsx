// "Sessions for this chat" in the composer's preset menu (omnigent-ae,
// 2026-10-23): this chat's collaborators, one per agent, ticked to add or
// untick to remove (each saves at once, like picking a preset). A new agent
// gets an idle child session on save, as the "Who works on this?" dialog does.
// A preset whose Helpers rule is "Own subagents only" greys the list out.

import { CheckIcon, PlusIcon } from "lucide-react";
import { useAvailableAgents } from "@/hooks/useAvailableAgents";
import { useChildSessions, type ChildSessionInfo } from "@/hooks/useChildSessions";
import { useHosts } from "@/hooks/useHosts";
import { useSession } from "@/hooks/useSession";
import { AE_TEAM_LIMIT, type AeTeamMember } from "@/lib/aeTeam";
import { AE_WORKING_HINT } from "@/lib/aeTeamPresets";
import { aeReviewerMemberTag, aeReviewerNumberOf } from "@/lib/aeReviewers";
import { aeTeamOptions } from "@/lib/aeTeamOptions";
import { cn } from "@/lib/utils";

function childTitle(child: ChildSessionInfo | undefined): string | null {
  if (!child) return null;
  // Children the dialog creates are titled "ui:<agent>:<name> · <model>"; show the task instead.
  if (child.task_summary) return child.task_summary;
  return child.title && !child.title.startsWith("ui:") ? child.title : null;
}

function SessionRow({
  title,
  detail,
  checked,
  disabled,
  onToggle,
}: {
  title: string;
  detail: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      aria-label={title}
      disabled={disabled}
      onClick={onToggle}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:hover:bg-transparent"
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded border",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-border",
        )}
      >
        {checked && <CheckIcon className="size-3" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

export function AePresetSessionsSection({
  sessionId,
  members,
  open,
  locked,
  lockedHint,
  compact = false,
  working = false,
  pending = false,
  onToggle,
  onNewSession,
  reviewerNumbers,
}: {
  sessionId: string;
  members: AeTeamMember[];
  /** The menu is open: only then are agents, hosts and children fetched. */
  open: boolean;
  locked: boolean;
  lockedHint: string;
  compact?: boolean;
  /** A turn is running: sessions cannot be added or removed until it finishes. */
  working?: boolean;
  /** A session change is still saving: the dialog (which reads the label) waits. */
  pending?: boolean;
  onToggle: (member: AeTeamMember, on: boolean) => void;
  onNewSession: () => void;
  /** Agent id to its reviewer number in the chosen preset. */
  reviewerNumbers?: ReadonlyMap<string, number>;
}) {
  const { session } = useSession(sessionId);
  const { data: agents = [] } = useAvailableAgents({
    enabled: open,
    pinnedAgentIds: [...(session ? [session.agentId] : []), ...members.map((m) => m.agentId)],
  });
  const { data: hosts = [] } = useHosts({ enabled: open, includeSandbox: true });
  const { children } = useChildSessions(sessionId, null, open && members.length > 0);
  const host = hosts.find((h) => h.host_id === session?.hostId) ?? null;
  const options = session ? aeTeamOptions(agents, host, session) : [];
  const offered = options.filter(
    (o) => o.readiness.selectable && o.primary && !members.some((m) => m.agentId === o.agent.id),
  );
  const full = members.length >= AE_TEAM_LIMIT;
  const frozen = locked || working;
  return (
    <div data-testid="ae-preset-sessions" aria-disabled={locked || undefined}>
      <div className="flex items-baseline justify-between px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        <span>Sessions for this chat</span>
        <span className="normal-case tabular-nums">
          {members.length} of {AE_TEAM_LIMIT}
        </span>
      </div>
      {locked && <p className="px-2 pb-1 text-xs text-muted-foreground">{lockedHint}</p>}
      {working && !locked && (
        <p className="px-2 pb-1 text-xs text-muted-foreground">{AE_WORKING_HINT}</p>
      )}
      <div className={cn(locked && "opacity-45")}>
        {members.map((member) => {
          const child = children.find((c) => c.id === member.sessionId);
          const status = child ? (child.busy ? "running" : "idle") : null;
          const model = member.model ?? (compact ? null : "agent default model");
          const task = childTitle(child);
          return (
            <SessionRow
              key={`member-${member.agentId}`}
              title={task ?? member.displayName}
              detail={[task ? member.displayName : null, model, status].filter(Boolean).join(" · ")}
              checked
              disabled={frozen}
              onToggle={() => onToggle(member, false)}
            />
          );
        })}
        {offered.map((option) => (
          <SessionRow
            key={`offer-${option.agent.id}`}
            title={option.name}
            detail={
              aeReviewerMemberTag(aeReviewerNumberOf(reviewerNumbers, option.agent)) ??
              (compact ? "New session" : "New session · agent default model")
            }
            checked={false}
            disabled={frozen || full}
            onToggle={() =>
              onToggle(
                {
                  agentId: option.agent.id,
                  agentName: option.agent.name,
                  displayName: option.name,
                  model: null,
                },
                true,
              )
            }
          />
        ))}
        <button
          type="button"
          role="menuitem"
          disabled={locked || pending}
          onClick={onNewSession}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:hover:bg-transparent"
        >
          <PlusIcon className="size-4 shrink-0" aria-hidden="true" />
          New session from an agent…
        </button>
      </div>
    </div>
  );
}
