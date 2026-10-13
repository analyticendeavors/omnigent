import { useState } from "react";
import { UsersRound } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAvailableAgents, type AvailableAgent } from "@/hooks/useAvailableAgents";
import { useHostModelOptions, useHosts, type Host } from "@/hooks/useHosts";
import { childSessionsQueryKey } from "@/hooks/useChildSessions";
import { harnessReadinessOnHost } from "@/lib/harnessSetup";
import {
  readAeTeam,
  saveAeTeam,
  AE_TEAM_LIMIT,
  type AeTeam,
  type AeTeamMember,
} from "@/lib/aeTeam";
import type { Session } from "@/lib/types";
import { useForkDialog } from "@/shell/ForkDialogContext";
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
  agent,
  host,
  member,
  disabled,
  onChange,
}: {
  agent: AvailableAgent;
  host: Host | null;
  member: AeTeamMember | undefined;
  disabled: boolean;
  onChange: (member: AeTeamMember | null) => void;
}) {
  const readiness = harnessReadinessOnHost(agent.harness, host);
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
      displayName: agent.display_name,
      model,
    });
  return (
    <div
      className={`rounded-xl border p-3 ${member ? "border-primary/50 bg-primary/5" : "border-border"}`}
    >
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={!!member}
          disabled={disabled || (!member && !readiness.selectable)}
          onChange={(e) => (e.target.checked ? choose(null) : onChange(null))}
        />
        <span className="min-w-0 flex-1 text-sm font-medium">{agent.display_name}</span>
        {readiness.explanation && (
          <span className="text-xs text-muted-foreground">{readiness.explanation.label}</span>
        )}
      </label>
      {member && (
        <div className="mt-3 space-y-2">
          <label className="block text-xs text-muted-foreground">
            Model for {agent.display_name}
            <select
              aria-label={`Model for ${agent.display_name}`}
              value={member.model ?? ""}
              disabled={disabled}
              onChange={(e) => choose(e.target.value || null)}
              className="mt-1 w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
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
          {readiness.explanation && (
            <p className="text-xs text-muted-foreground">{readiness.explanation.description}</p>
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
  disabled = false,
}: {
  draft: AeTeam;
  onChange: (draft: AeTeam) => void;
  agents: AvailableAgent[];
  host: Host | null;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Collaboration mode">
        {(["solo", "team"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={draft.mode === mode}
            disabled={disabled}
            onClick={() => onChange({ ...draft, mode })}
            className={`rounded-xl border px-3 py-3 text-left ${draft.mode === mode ? "border-primary bg-primary/5" : "border-border"}`}
          >
            <span className="block text-sm font-medium">{mode === "solo" ? "Solo" : "Team"}</span>
            <span className="text-xs text-muted-foreground">
              {mode === "solo" ? "One agent handles the work" : "A lead with collaborators"}
            </span>
          </button>
        ))}
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
            The lead assigns tasks and brings their results together. Each collaborator uses its own
            context and account allowance.
          </p>
          {agents.length === 0 && (
            <p className="text-sm text-muted-foreground">No agents available yet.</p>
          )}
          {agents.map((agent) => {
            const member = draft.members.find((m) => m.agentId === agent.id);
            return (
              <MemberChoice
                key={agent.id}
                agent={agent}
                host={host}
                member={member}
                disabled={disabled || (!member && draft.members.length >= AE_TEAM_LIMIT)}
                onChange={(next) =>
                  onChange({
                    ...draft,
                    members: [
                      ...draft.members.filter((m) => m.agentId !== agent.id),
                      ...(next ? [next] : []),
                    ],
                  })
                }
              />
            );
          })}
          {draft.members
            .filter((m) => !agents.some((a) => a.id === m.agentId))
            .map((member) => (
              <div
                key={member.agentId}
                className="flex items-center justify-between gap-2 rounded-md border p-3 text-sm"
              >
                <span>{member.displayName} · Unavailable</span>
                <Button
                  variant="ghost"
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
  // A new lead forks the session; in-place agent switching is not available.
  const forkDialog = useForkDialog();
  const [draft, setDraft] = useState<AeTeam>(() => readAeTeam(session.labels));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = readAeTeam(session.labels);
  const { data: agents = [], isLoading, isError } = useAvailableAgents({ enabled: open });
  const { data: hosts = [] } = useHosts({ enabled: open, includeSandbox: true });
  const host = hosts.find((h) => h.host_id === session.hostId) ?? null;
  const invalid =
    draft.mode === "team" &&
    (!draft.members.length ||
      draft.members.some((m) => {
        const agent = agents.find((a) => a.id === m.agentId);
        return !agent || !harnessReadinessOnHost(agent.harness, host).selectable;
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
  return (
    <>
      <button
        type="button"
        aria-label={team ? `Team: ${saved.members.length} collaborators` : "Collaboration: Solo"}
        title={team ? saved.members.map((m) => m.displayName).join(", ") : "Choose solo or a team"}
        disabled={disabled}
        onClick={() => changeOpen(true)}
        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
      >
        <UsersRound className="size-4" />
        <span>{team ? `Team · ${saved.members.length}` : "Solo"}</span>
      </button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          className="flex max-h-[85dvh] flex-col gap-4 sm:max-w-lg"
          data-testid="ae-team-dialog"
        >
          <DialogHeader>
            <DialogTitle>Who works on this?</DialogTitle>
            <DialogDescription>
              Choose a lead and the collaborators you want involved.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto px-1 pb-1">
            <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 p-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Lead / orchestrator</p>
                <p className="truncate text-sm font-medium">
                  {session.agentName ?? session.harness ?? "Current agent"}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={saving || working || disabled || !forkDialog?.canFork}
                title={forkDialog?.disabledReason}
                onClick={() => {
                  setOpen(false);
                  forkDialog?.openForkDialog({ sourceSessionId: session.id });
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
              disabled={saving || disabled}
            />
            {draft.mode === "team" && (
              <p className="text-xs text-muted-foreground">
                Team uses your selected agents and models. Automatic collaborator routing will be
                turned off.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Applies to your next message. Existing work can finish when you switch to Solo.
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
              loading={saving}
              disabled={disabled || invalid || saving || working}
              onClick={() => void save()}
            >
              Save selection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
