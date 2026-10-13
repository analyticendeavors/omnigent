import { useId, useState } from "react";
import { ChevronDown, UsersRound } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAvailableAgents, type AvailableAgent } from "@/hooks/useAvailableAgents";
import { useHostModelOptions, useHosts, type Host } from "@/hooks/useHosts";
import { childSessionsQueryKey } from "@/hooks/useChildSessions";
import {
  aeTeamAgentName,
  aeTeamLeadName,
  aeTeamOptions,
  aeTeamReadiness,
  type AeTeamLead,
  type AeTeamOption,
} from "@/lib/aeTeamOptions";
import {
  readAeTeam,
  saveAeTeam,
  AE_TEAM_LIMIT,
  type AeTeam,
  type AeTeamMember,
} from "@/lib/aeTeam";
import type { Session } from "@/lib/types";
import { SwitchAgentDialog } from "@/shell/SwitchAgentDialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

function MemberChoice({
  option,
  host,
  member,
  disabled,
  onChange,
}: {
  option: AeTeamOption;
  host: Host | null;
  member: AeTeamMember | undefined;
  disabled: boolean;
  onChange: (member: AeTeamMember | null) => void;
}) {
  const { agent, name, readiness, recommendation } = option;
  const descriptionId = useId();
  const catalog = useHostModelOptions(
    host?.host_id ?? null,
    agent.harness ?? "",
    !!member && readiness.selectable,
  );
  const models = catalog.data ?? [];
  const choose = (model: string | null) =>
    onChange({
      agentId: agent.id,
      agentName: agent.name,
      displayName: name,
      model,
    });
  return (
    <div
      className={`rounded-xl border p-3 ${member ? "border-primary/50 bg-primary/5" : "border-border"}`}
    >
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          aria-label={name}
          aria-describedby={descriptionId}
          className="mt-0.5 size-4 shrink-0 accent-primary"
          checked={!!member}
          disabled={disabled || (!member && !readiness.selectable)}
          onChange={(e) => (e.target.checked ? choose(null) : onChange(null))}
        />
        <span className="min-w-0 flex-1 break-words text-sm font-medium">{name}</span>
      </label>
      <div id={descriptionId} className="ml-7 space-y-1 text-xs text-muted-foreground">
        {recommendation && <p className="mt-1 text-primary">{recommendation}</p>}
        {agent.description && <p className="mt-1 line-clamp-2 break-words">{agent.description}</p>}
        {readiness.explanation && (
          <p className="mt-1">
            <span className="font-medium">{readiness.explanation.label}. </span>
            {readiness.explanation.description}
            {member &&
              !readiness.selectable &&
              " Remove this collaborator or wait until it is ready before saving this team."}
          </p>
        )}
      </div>
      {member && readiness.selectable && (
        <div className="mt-3 space-y-2">
          <label className="block text-xs text-muted-foreground">
            Model for {name}
            <select
              aria-label={`Model for ${name}`}
              value={member.model ?? ""}
              disabled={disabled}
              onChange={(e) => choose(e.target.value || null)}
              className="mt-1 w-full min-w-0 rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
            >
              <option value="">Agent default</option>
              {member.model && !models.some((m) => m.id === member.model) && (
                <option value={member.model}>{member.model}</option>
              )}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName ?? model.id}
                </option>
              ))}
            </select>
          </label>
          {catalog.isFetching && <p className="text-xs text-muted-foreground">Loading models…</p>}
          {catalog.isError && (
            <p className="text-xs text-muted-foreground">
              Model list unavailable. The agent default is still available.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function AeTeamEditor({
  draft,
  onChange,
  agents,
  host,
  lead,
  disabled = false,
}: {
  draft: AeTeam;
  onChange: (draft: AeTeam) => void;
  agents: AvailableAgent[];
  host: Host | null;
  lead?: AeTeamLead;
  disabled?: boolean;
}) {
  const [showSetup, setShowSetup] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const setupId = useId();
  const otherId = useId();
  const options = aeTeamOptions(agents, host, lead);
  const visible = options.filter(
    ({ agent, readiness, primary }) =>
      (readiness.selectable && primary) || draft.members.some((m) => m.agentId === agent.id),
  );
  const otherConnected = options.filter(
    (option) => option.readiness.selectable && !visible.includes(option),
  );
  const needingSetup = options.filter(
    (option) => !option.readiness.selectable && !visible.includes(option),
  );
  const renderChoice = (option: AeTeamOption) => {
    const member = draft.members.find((m) => m.agentId === option.agent.id);
    return (
      <MemberChoice
        key={option.agent.id}
        option={option}
        host={host}
        member={member}
        disabled={disabled || (!member && draft.members.length >= AE_TEAM_LIMIT)}
        onChange={(next) =>
          onChange({
            ...draft,
            members: next
              ? member
                ? draft.members.map((m) => (m.agentId === option.agent.id ? next : m))
                : [...draft.members, next]
              : draft.members.filter((m) => m.agentId !== option.agent.id),
          })
        }
      />
    );
  };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="Collaboration mode">
        {(["auto", "solo", "team"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-label={mode === "auto" ? "Auto Recommended" : mode === "solo" ? "Solo" : "Team"}
            aria-pressed={draft.mode === mode}
            disabled={disabled}
            onClick={() => onChange({ ...draft, mode })}
            className={`min-w-0 rounded-xl border px-2 py-3 text-center disabled:opacity-50 ${draft.mode === mode ? "border-primary bg-primary/5" : "border-border"}`}
          >
            <span className="block text-sm font-medium">
              {mode === "auto" ? "Auto" : mode === "solo" ? "Solo" : "Team"}
            </span>
            {mode === "auto" && (
              <span className="block text-[10px] text-muted-foreground">Recommended</span>
            )}
          </button>
        ))}
      </div>
      <div className="space-y-2 text-xs text-muted-foreground">
        <p aria-live="polite">
          {draft.mode === "auto"
            ? "The lead chooses useful collaborators from your connected agents as needed."
            : draft.mode === "solo"
              ? "The lead works with its native helpers, without an added cross-agent team."
              : "You choose collaborators. The lead assigns tasks and brings their results together."}
        </p>
        <p>Native subagents remain available in every mode.</p>
      </div>
      {draft.mode === "team" && (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            Collaborators{" "}
            <span className="text-muted-foreground">
              {draft.members.length}/{AE_TEAM_LIMIT}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            Each collaborator uses its configured account and its own context.
          </p>
          {!options.some((option) => option.readiness.selectable) && (
            <p className="text-sm text-muted-foreground">
              No collaborators are ready on this host yet.
            </p>
          )}
          {visible.map(renderChoice)}
          {draft.members
            .filter((m) => !agents.some((a) => a.id === m.agentId))
            .map((member) => (
              <div
                key={member.agentId}
                className="flex items-start justify-between gap-2 rounded-xl border p-3 text-sm"
              >
                <div className="min-w-0 space-y-1 break-words">
                  <p className="font-medium">
                    {aeTeamAgentName({
                      name: member.agentName,
                      display_name: member.displayName,
                      harness: null,
                    })}
                    {" · Unavailable"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    This agent is no longer available. Remove it or choose another collaborator to
                    save this team.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  aria-label={`Remove ${member.displayName}`}
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      ...draft,
                      members: draft.members.filter((m) => m.agentId !== member.agentId),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
          {otherConnected.length > 0 && (
            <div className="space-y-2 pt-1">
              <button
                type="button"
                aria-expanded={showOther}
                aria-controls={otherId}
                onClick={() => setShowOther((show) => !show)}
                className="flex w-full items-center gap-2 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={`size-4 shrink-0 ${showOther ? "rotate-180" : ""}`} />
                Other connected agents
                <span>({otherConnected.length})</span>
              </button>
              <div id={otherId} hidden={!showOther} className="space-y-2">
                {showOther && otherConnected.map(renderChoice)}
              </div>
            </div>
          )}
          {needingSetup.length > 0 && (
            <div className="space-y-2 pt-1">
              <button
                type="button"
                aria-expanded={showSetup}
                aria-controls={setupId}
                onClick={() => setShowSetup((show) => !show)}
                className="flex w-full items-center gap-2 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={`size-4 shrink-0 ${showSetup ? "rotate-180" : ""}`} />
                {showSetup ? "Hide agents needing setup" : "Show agents needing setup"}
                <span>({needingSetup.length})</span>
              </button>
              <div id={setupId} hidden={!showSetup} className="space-y-2">
                {showSetup && needingSetup.map(renderChoice)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Composer-level collaboration preferences; opening the picker never starts work. */
export function AeTeamControl({
  session,
  disabled = false,
  working = false,
}: {
  session: Session;
  disabled?: boolean;
  working?: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [draft, setDraft] = useState<AeTeam>(() => readAeTeam(session.labels));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = readAeTeam(session.labels);
  const {
    data: agents = [],
    isLoading,
    isError,
  } = useAvailableAgents({
    enabled: open,
    pinnedAgentIds: [session.agentId, ...saved.members.map((member) => member.agentId)],
  });
  const { data: hosts = [] } = useHosts({ enabled: open, includeSandbox: true });
  const host = hosts.find((h) => h.host_id === session.hostId) ?? null;
  const invalid =
    draft.mode === "team" &&
    (!draft.members.length ||
      draft.members.some((m) => {
        const agent = agents.find((a) => a.id === m.agentId);
        return !agent || !aeTeamReadiness(agent.harness, host).selectable;
      }));
  function changeOpen(next: boolean) {
    if (saving) return;
    if (next) {
      setDraft(readAeTeam(session.labels));
      setError(null);
    }
    setOpen(next);
  }
  async function save() {
    if (disabled || invalid || saving || working) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await saveAeTeam(session.id, draft);
      queryClient.setQueryData(["session", session.id], updated);
      await queryClient.invalidateQueries({ queryKey: childSessionsQueryKey(session.id) });
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the team. Try again.");
    } finally {
      setSaving(false);
    }
  }
  const team = saved.mode === "team";
  const modeName = saved.mode === "auto" ? "Auto" : saved.mode === "solo" ? "Solo" : "Team";
  return (
    <>
      <button
        type="button"
        aria-label={
          team ? `Team: ${saved.members.length} collaborators` : `Collaboration: ${modeName}`
        }
        title={
          team ? saved.members.map((m) => m.displayName).join(", ") : "Choose Auto, Solo, or Team"
        }
        disabled={disabled}
        onClick={() => changeOpen(true)}
        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
      >
        <UsersRound className="size-4" />
        <span>{team ? `Team · ${saved.members.length}` : modeName}</span>
      </button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          className="flex max-h-[85dvh] flex-col gap-4 sm:max-w-lg"
          data-testid="ae-team-dialog"
        >
          <DialogHeader>
            <DialogTitle>Who works on this?</DialogTitle>
            <DialogDescription>Choose how your lead works with collaborators.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto px-1 pb-1">
            <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 p-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Lead / orchestrator</p>
                <p className="truncate text-sm font-medium">{aeTeamLeadName(session, agents)}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={saving || working || disabled}
                onClick={() => {
                  setOpen(false);
                  setSwitchOpen(true);
                }}
              >
                Change lead
              </Button>
            </div>
            {working && (
              <p className="text-xs text-muted-foreground">
                You can save collaboration changes after this turn finishes.
              </p>
            )}
            {isLoading && <p className="text-sm text-muted-foreground">Loading agents…</p>}
            {isError && (
              <p role="alert" className="text-sm text-destructive">
                Could not load available agents. Close and reopen to retry.
              </p>
            )}
            <AeTeamEditor
              draft={draft}
              onChange={setDraft}
              agents={agents}
              host={host}
              lead={session}
              disabled={saving || disabled}
            />
            <p className="text-xs text-muted-foreground">
              Applies to your next message. Existing work can finish when you change modes.
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" disabled={saving} onClick={() => changeOpen(false)}>
              Cancel
            </Button>
            <Button
              aria-label="Save selection"
              loading={saving}
              disabled={disabled || invalid || saving || working}
              onClick={() => void save()}
            >
              Save selection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SwitchAgentDialog
        sessionId={session.id}
        open={switchOpen && !working && !disabled}
        onOpenChange={setSwitchOpen}
      />
    </>
  );
}
