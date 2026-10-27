import { useId, useMemo, useState } from "react";
import { ChevronDown, UsersRound } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAvailableAgents, type AvailableAgent } from "@/hooks/useAvailableAgents";
import { useHostModelOptions, useHosts, type Host } from "@/hooks/useHosts";
import { childSessionsQueryKey } from "@/hooks/useChildSessions";
import { useSession } from "@/hooks/useSession";
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
import { useForkDialog } from "@/shell/ForkDialogContext";
import { useAeRoles } from "@/hooks/useAeRoles";
import {
  AE_SUPERSEDED,
  aeLatestWins,
  aeResolveSessionPreset,
  aeChoiceId,
  aeRecordPresetSwitch,
  saveAeSessionRoles,
} from "@/lib/aeSessionRoles";
import {
  AE_SOLO_PRESET_ID,
  AE_WORKING_HINT,
  aeIsLegacySolo,
  aeMigratedSessionRoles,
  aeSessionsLocked,
  aeSessionsLockedHint,
} from "@/lib/aeTeamPresets";
import { aeAnnouncePresetLead, aeSwitchPresetLead } from "@/lib/aeLeadModelChat";
import { aeRoleAgents } from "@/lib/aeRoles";
import { aeReviewerMemberNote, aeReviewerNumberOf, aeReviewerNumbers } from "@/lib/aeReviewers";
import { AeSessionPresetRow } from "./AeSessionPresetRow";
import { AeSessionPresetPill } from "./composer/AeSessionPresetPill";
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
  reviewerNote = null,
}: {
  option: AeTeamOption;
  host: Host | null;
  member: AeTeamMember | undefined;
  disabled: boolean;
  onChange: (member: AeTeamMember | null) => void;
  reviewerNote?: string | null;
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
        {reviewerNote && <p className="mt-1 text-primary">{reviewerNote}</p>}
        {recommendation && !reviewerNote && <p className="mt-1 text-primary">{recommendation}</p>}
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
  options: givenOptions,
  disabled: disabledProp = false,
  lockedHint = null,
  reviewerNumbers,
}: {
  draft: AeTeam;
  onChange: (draft: AeTeam) => void;
  agents: AvailableAgent[];
  host: Host | null;
  lead?: AeTeamLead;
  /** The options for `agents`, when the caller already computed them for its own lists. */
  options?: AeTeamOption[];
  disabled?: boolean;
  /** Set when the preset keeps work in house: the list greys out with this line. */
  lockedHint?: string | null;
  /** Agent id to its reviewer number in the chosen preset, for the "Already Reviewer n" note. */
  reviewerNumbers?: ReadonlyMap<string, number>;
}) {
  const disabled = disabledProp || !!lockedHint;
  const [showSetup, setShowSetup] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const setupId = useId();
  const otherId = useId();
  const options = givenOptions ?? aeTeamOptions(agents, host, lead);
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
        reviewerNote={aeReviewerMemberNote(aeReviewerNumberOf(reviewerNumbers, option.agent))}
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
      <div
        className={`space-y-2 ${lockedHint ? "opacity-60" : ""}`}
        data-testid="ae-team-sessions"
        aria-disabled={disabled || undefined}
      >
        <p className="text-sm font-medium">
          Add sessions{" "}
          <span className="text-muted-foreground">
            {draft.members.length} of {AE_TEAM_LIMIT}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          {lockedHint ??
            "The lead hands work to these first. They keep their own context and account."}
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
    </div>
  );
}

/** Keep the configuration entry point visible while session metadata recovers. */
export function SessionTeamControl({
  sessionId,
  disabled = false,
  working = false,
}: {
  sessionId: string;
  disabled?: boolean;
  working?: boolean;
}) {
  const { session, error, isLoading } = useSession(sessionId);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  if (session) {
    return (
      <>
        <AeSessionPresetPill
          sessionId={sessionId}
          disabled={disabled}
          working={working}
          onOpenTeam={() => setOpen(true)}
        />
        <AeTeamControl
          session={session}
          disabled={disabled}
          working={working}
          open={open}
          onOpenChange={setOpen}
        />
      </>
    );
  }
  return (
    <button
      type="button"
      aria-label={error ? "Retry team configuration" : "Loading team configuration"}
      title={
        error
          ? "Could not load team and lead settings. Click to retry."
          : "Loading team and lead settings…"
      }
      disabled={disabled || isLoading || !error}
      onClick={() => void queryClient.invalidateQueries({ queryKey: ["session", sessionId] })}
      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
    >
      <UsersRound className="size-4" />
      <span>{error ? "Retry" : "Roles…"}</span>
    </button>
  );
}

/**
 * The "Who works on this?" dialog: lead, roles preset (with Helpers) and the
 * chat's sessions. Opened from the composer's preset pill; opening it never
 * starts work.
 */
export function AeTeamControl({
  session,
  disabled = false,
  working = false,
  open,
  onOpenChange,
}: {
  session: Session;
  disabled?: boolean;
  working?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data: rolesState } = useAeRoles();
  // A new lead forks the session; in-place agent switching is not available.
  const forkDialog = useForkDialog();
  const [draft, setDraft] = useState<AeTeam>(() => readAeTeam(session.labels));
  // Roles go to saveAeTeam only when this dialog changed them, so a stale
  // value from when it opened never overwrites a newer pick (pill, Alt digit).
  const [rolesTouched, setRolesTouched] = useState(false);
  // The preset in force when the dialog opened: only a different pick switches the lead model.
  const [openedPresetId, setOpenedPresetId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = readAeTeam(session.labels);
  const choice = rolesState ? aeResolveSessionPreset(draft.roles ?? null, rolesState) : null;
  const {
    data: agents = [],
    isLoading,
    isError,
  } = useAvailableAgents({
    enabled: open,
    pinnedAgentIds: [
      session.agentId,
      ...saved.members.map((member) => member.agentId),
      // The agents the shown preset's reviewers name, so none reads "Not found" when deduped.
      ...(choice?.kind === "preset" ? aeRoleAgents(choice.preset.roles) : []),
    ],
  });
  const { data: hosts = [], isSuccess: hostsLoaded } = useHosts({
    enabled: open,
    includeSandbox: true,
  });
  const host = hosts.find((h) => h.host_id === session.hostId) ?? null;
  // One options list for the reviewer rows and the sessions list below.
  const options = useMemo(() => aeTeamOptions(agents, host, session), [agents, host, session]);
  // A label still saved as Solo stays locked until the user picks something else here.
  const locked = aeSessionsLocked(choice, aeIsLegacySolo(session.labels) && !rolesTouched);
  // Sessions kept while the preset keeps work in house are not checked for readiness.
  const invalid =
    !locked &&
    draft.members.some((m) => {
      const agent = agents.find((a) => a.id === m.agentId);
      return !agent || !aeTeamReadiness(agent.harness, host).selectable;
    });
  // Each opening starts from the saved label, a Solo-era label read the new way.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const stored = readAeTeam(session.labels);
      const migrated = rolesState
        ? aeMigratedSessionRoles(session.labels, stored.roles ?? null, rolesState)
        : (stored.roles ?? null);
      const legacy = aeIsLegacySolo(session.labels) && !!rolesState;
      // The migrated roles are for display; they are written only when the user
      // changes the roles row, or when they are a plain reference to the Solo
      // preset (no frozen copy of a preset is ever written just for opening).
      const opened = legacy ? migrated : (stored.roles ?? null);
      setDraft(legacy ? { ...stored, roles: migrated } : stored);
      const openedChoice = rolesState ? aeResolveSessionPreset(opened, rolesState) : null;
      setOpenedPresetId(openedChoice?.kind === "preset" ? openedChoice.preset.id : null);
      setRolesTouched(
        legacy && !stored.roles && migrated?.preset === AE_SOLO_PRESET_ID && !migrated.custom,
      );
      setError(null);
    }
  }
  function changeOpen(next: boolean) {
    if (saving) return;
    onOpenChange(next);
  }
  async function save() {
    if (disabled || invalid || saving || working) return;
    setSaving(true);
    setError(null);
    try {
      const { roles: _staleRoles, ...withoutRoles } = draft;
      // Through the same per-session line the pill's menu writes use, so a
      // menu change still saving lands first and is never overwritten.
      // A newly chosen preset with a fixed lead also switches the model; a Helpers
      // toggle or a non-lead row edit on the same preset leaves the model alone.
      const switchPreset =
        rolesTouched && choice?.kind === "preset" && choice.preset.id !== openedPresetId
          ? choice.preset
          : null;
      // The label save and the lead switch share one callback, so a later pick
      // supersedes both and an older switch never overwrites a newer model.
      const done = await aeLatestWins(
        session.id,
        async () => {
          const updated = locked
            ? // Own subagents only: the stored sessions stay as they are (no child
              // sessions, no routing change); only the roles choice can be saved.
              rolesTouched
              ? await saveAeSessionRoles(session.id, draft.roles ?? null)
              : null
            : await saveAeTeam(session.id, rolesTouched ? draft : withoutRoles);
          if (updated) queryClient.setQueryData(["session", session.id], updated);
          const lead = switchPreset
            ? await aeSwitchPresetLead(queryClient, session.id, session.hostId, switchPreset)
            : null;
          return { lead };
        },
        { queue: true },
      );
      const chosenId = aeChoiceId(choice);
      if (done !== AE_SUPERSEDED && rolesTouched && chosenId && chosenId !== openedPresetId) {
        aeRecordPresetSwitch(session.id, chosenId);
      }
      if (done !== AE_SUPERSEDED && switchPreset && done.lead) {
        aeAnnouncePresetLead(queryClient, session.id, switchPreset.title, done.lead);
      }
      await queryClient.invalidateQueries({ queryKey: childSessionsQueryKey(session.id) });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the team. Try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        className="flex max-h-[85dvh] flex-col gap-4 sm:max-w-lg"
        data-testid="ae-team-dialog"
      >
        <DialogHeader>
          <DialogTitle>Who works on this?</DialogTitle>
          <DialogDescription>
            Pick a preset, and any sessions the lead should hand work to.
          </DialogDescription>
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
              disabled={saving || working || disabled || !forkDialog?.canFork}
              title={forkDialog?.disabledReason}
              onClick={() => {
                onOpenChange(false);
                forkDialog?.openForkDialog({ sourceSessionId: session.id });
              }}
            >
              Change lead
            </Button>
          </div>
          <AeSessionPresetRow
            reviewerAgents={{
              options,
              host,
              loaded: !isLoading && !isError && hostsLoaded,
            }}
            value={draft.roles ?? null}
            onChange={(roles) => {
              setRolesTouched(true);
              setDraft((d) => ({ ...d, roles }));
            }}
            disabled={saving || disabled}
          />
          {working && <p className="text-xs text-muted-foreground">{AE_WORKING_HINT}</p>}
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
            options={options}
            host={host}
            lead={session}
            disabled={saving || disabled}
            lockedHint={locked ? aeSessionsLockedHint(choice) : null}
            reviewerNumbers={aeReviewerNumbers(choice)}
          />
          <p className="text-xs text-muted-foreground">
            Applies to your next message. Work already running can finish.
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
  );
}
