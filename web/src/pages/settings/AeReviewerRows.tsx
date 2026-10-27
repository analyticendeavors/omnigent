// Settings > Roles: the Reviewer row with one to three reviewers (omnigent-ae,
// 2026-10-24, concept A). Slot 1 sits on the role row; slots 2 and 3 stack
// under it, numbered. Every slot is one model dropdown and one effort bar: a
// Claude model (a subagent), a Codex model (a child session, tagged Codex; the
// bar has the steps that model offers) or another agent. The two review
// settings show with 2 or more.

import { AeHint } from "@/components/AeHint";
import { PlusIcon, XIcon } from "lucide-react";
import { type AeReviewerAgents, useAeReviewerAgents } from "@/hooks/useAeReviewerAgents";
import type { AeRoleModelChoice } from "@/hooks/useAeRoleModels";
import { type AeCodexCatalog, useAeCodexCatalog } from "@/hooks/useAeCodexCatalog";
import type { AeModelUpdatesState } from "@/hooks/useAeModelUpdates";
import { type Host, useHostModelOptions } from "@/hooks/useHosts";
import { aeCodexDefaultEffort, aeNewCodexReviewerModel } from "@/lib/aeCodexModels";
import { aeClaudeEffortLabel } from "@/lib/aeEffortDefault";
import {
  AE_REVIEW_MERGE_OPTIONS,
  AE_REVIEWER_UNAVAILABLE_OPTIONS,
  AE_REVIEWERS_MAX,
  type AeReviewerAgentSlot,
  type AeReviewerSetting,
  type AeReviewerSlot,
  type AeReviewerUnavailable,
  type AeReviewMerge,
  AE_AGENT_NAME_MAX,
  aeAgentEfforts,
  aeAgentNameOf,
  aeAgentSetupHref,
  aeIsCodexAgent,
  aeReviewerAgentOption,
  aeReviewerAgents,
  aeReviewerList,
  aeReviewerRowLabel,
  aeReviewerUnavailableOf,
  aeReviewMergeOf,
  aeWriteReviewers,
} from "@/lib/aeReviewers";
import { AE_ROLE_LABELS, type AeRoleEffort, type AeRoleRules, aeHelpersOf } from "@/lib/aeRoles";
import type { AeTeamOption } from "@/lib/aeTeamOptions";
import { codexEffortLevelsForModel, comparableModelId } from "@/lib/codexNativeModels";
import type { NativeModelOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AeUpdateChip } from "./AeModelUpdates";
import { AeSegmented } from "./AeRolesControls";
import { aeRoleModelPick } from "./AeRoleModelPicker";

const GRID =
  "grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-2 @lg/roles:grid-cols-[7rem_minmax(0,14rem)_1fr]";

function Tag({ tone, children }: { tone: "amber" | "muted"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-px text-[11px] font-medium",
        tone === "amber" ? "bg-amber-500/15 text-amber-500" : "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

// Another agent (not Codex) picks its model and effort in two small dropdowns, as before.
function AgentDetails({
  slot,
  label,
  option,
  host,
  disabled,
  onChange,
}: {
  slot: AeReviewerAgentSlot;
  label: string;
  option: AeTeamOption | null;
  host: Host | null;
  disabled: boolean;
  onChange: (slot: AeReviewerAgentSlot) => void;
}) {
  const ready = !!option?.readiness.selectable;
  const catalog = useHostModelOptions(host?.host_id ?? null, option?.agent.harness ?? "", ready, {
    poll: false,
  });
  const models = catalog.data ?? [];
  // Only the efforts this agent's harness takes (and, where the harness lists them per model, the chosen model's).
  const efforts = aeAgentEfforts(
    option?.agent.harness,
    slot.model ? codexEffortLevelsForModel(models, slot.model) : [],
  );
  const effortOf = (model: string | null) =>
    slot.effort &&
    !aeAgentEfforts(
      option?.agent.harness,
      model ? codexEffortLevelsForModel(models, model) : [],
    ).includes(slot.effort)
      ? null
      : slot.effort;
  const selectClass =
    "min-w-0 rounded-md border border-input bg-background px-1.5 py-1 text-xs text-foreground";
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {models.length > 0 || slot.model ? (
        <select
          aria-label={`${label} model`}
          value={slot.model ?? ""}
          disabled={disabled}
          onChange={(e) => {
            const model = e.target.value || null;
            onChange({ ...slot, model, effort: effortOf(model) });
          }}
          className={selectClass}
        >
          <option value="">Agent default model</option>
          {slot.model && !models.some((m) => m.id === slot.model) && (
            <option value={slot.model}>{slot.model}</option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName ?? m.id}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-xs text-muted-foreground">Agent default model</span>
      )}
      <select
        aria-label={`${label} effort`}
        value={slot.effort ?? ""}
        disabled={disabled}
        onChange={(e) =>
          onChange({ ...slot, effort: (e.target.value || null) as AeRoleEffort | null })
        }
        className={selectClass}
      >
        <option value="">Default effort</option>
        {slot.effort && !efforts.includes(slot.effort) && (
          <option value={slot.effort}>{aeClaudeEffortLabel(slot.effort)}</option>
        )}
        {efforts.map((effort) => (
          <option key={effort} value={effort}>
            {aeClaudeEffortLabel(effort)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The dropdown's value for a Codex model, and the one for "no model named". */
const rowValue = (row: NativeModelOption) => row.model ?? row.id;

function SlotRow({
  index,
  slots,
  rowLabel,
  models,
  options,
  codex,
  host,
  loaded,
  disabled,
  chip,
  onChange,
  onRemove,
}: {
  index: number;
  slots: readonly AeReviewerSlot[];
  rowLabel: string;
  models: readonly AeRoleModelChoice[];
  options: readonly AeTeamOption[];
  codex: AeCodexCatalog;
  host: Host | null;
  loaded: boolean;
  disabled: boolean;
  chip: React.ReactNode;
  onChange: (slot: AeReviewerSlot) => void;
  onRemove: (() => void) | null;
}) {
  const slot = slots[index];
  const label = `Reviewer ${index + 1}`;
  const usedBy = (model: string) => {
    const at = slots.findIndex(
      (s, i) =>
        i !== index &&
        s.mode === "fixed" &&
        comparableModelId(s.model) === comparableModelId(model),
    );
    return at < 0 ? "" : `used by Reviewer ${at + 1}`;
  };
  const pick = aeRoleModelPick({
    setting: slot,
    groups: "all",
    auto: index === 0,
    ariaLabel: index === 0 ? "Reviewer model" : `${label} model`,
    barLabel: index === 0 ? "Reviewer" : label,
    toolTestId: `ae-reviewer-tool-${index + 1}`,
    models,
    options,
    codex,
    host,
    disabled,
    usedBy,
    // A reviewer slot never offers the session model, so the pick is always a slot.
    onChange: (next) => onChange(next as AeReviewerSlot),
  });
  const { agentSlot, agentState, trigger, bar } = pick;
  const agentOption = agentState?.option ?? null;
  const { hint } = AE_ROLE_LABELS.reviewer;
  return (
    <div data-testid={`ae-reviewer-slot-${index + 1}`} className={cn(GRID, index > 0 && "pt-2")}>
      {index === 0 ? (
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {rowLabel}
            <AeHint id="roles.reviewer" />
          </div>
          <div className="text-xs leading-tight text-muted-foreground">{hint}</div>
        </div>
      ) : (
        <div className="pr-1 text-right text-xs font-medium text-muted-foreground">{index + 1}</div>
      )}
      {trigger}
      <div className="col-start-2 flex min-w-0 items-center justify-between gap-2 @lg/roles:col-start-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 @[480px]/roles:flex-nowrap">
          {bar ? (
            bar
          ) : agentSlot ? (
            <AgentDetails
              slot={agentSlot}
              label={label}
              option={agentOption}
              host={host}
              disabled={disabled}
              onChange={onChange}
            />
          ) : (
            <span className="text-xs text-muted-foreground">The lead chooses</span>
          )}
          {chip}
          {agentSlot && loaded && agentState && agentState.status !== "ready" && (
            <span data-testid={`ae-reviewer-tag-${index + 1}`} className="flex items-center gap-1">
              <Tag tone="amber">
                {agentState.status === "setup"
                  ? "Needs setup"
                  : agentState.status === "missing"
                    ? "Not found"
                    : "Offline"}
              </Tag>
              {agentState.status === "setup" && (
                <a
                  href={aeAgentSetupHref(agentState.option?.agent.harness)}
                  className="text-xs text-primary hover:underline"
                >
                  Set up
                </a>
              )}
            </span>
          )}
        </div>
        {onRemove && (
          <button
            type="button"
            aria-label={`Remove ${label}`}
            title={`Remove ${label}`}
            disabled={disabled}
            onClick={onRemove}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A new slot that differs from the others: a ready agent first (another
 * provider), else an unused model. A new Codex reviewer opens on Sol of the
 * newest generation with that model's default effort.
 */
function nextSlot(
  slots: readonly AeReviewerSlot[],
  models: readonly AeRoleModelChoice[],
  options: readonly AeTeamOption[],
  codexRows: readonly NativeModelOption[],
): AeReviewerSlot | null {
  const agentSlots = slots.flatMap((s) => (s.mode === "agent" ? [s] : []));
  const free = options.filter(
    (o) =>
      o.readiness.selectable &&
      o.primary &&
      !agentSlots.some((s) => aeReviewerAgentOption(s, [o]) !== null),
  );
  // Another provider first: the team list's recommendation, or Codex where nothing is recommended (Settings has no lead).
  const preferred = free.find((o) => o.recommendation) ?? free.find((o) => aeIsCodexAgent(o.agent));
  const agent = preferred ?? free[0];
  const agentSlot = (): AeReviewerSlot | null => {
    const codexAgent = aeIsCodexAgent(agent.agent);
    // A new Codex pick starts on a named model; with no list yet there is nothing to start on.
    if (codexAgent && codexRows.length === 0) return null;
    const start = codexAgent ? aeNewCodexReviewerModel(codexRows) : null;
    return {
      mode: "agent",
      agent: agent.agent.id,
      agent_name: aeAgentNameOf(agent.agent.name),
      name: Array.from(agent.name).slice(0, AE_AGENT_NAME_MAX).join(""),
      model: start ? rowValue(start) : null,
      effort: start ? aeCodexDefaultEffort(start) : null,
    };
  };
  if (preferred) return agentSlot();
  const usedModels = new Set(
    slots.flatMap((s) => (s.mode === "fixed" ? [comparableModelId(s.model)] : [])),
  );
  const model =
    models.find((m) => !usedModels.has(comparableModelId(m.value))) ??
    models[0] ??
    (() => {
      const first = slots.find((s) => s.mode === "fixed");
      return first?.mode === "fixed" ? { value: first.model } : undefined;
    })();
  if (model) return { mode: "fixed", model: model.value, effort: "medium" };
  return agent ? agentSlot() : null;
}

interface ReviewerRowsProps {
  setting: AeReviewerSetting;
  models: readonly AeRoleModelChoice[];
  onChange: (setting: AeReviewerSetting) => void;
  disabled: boolean;
  /** The update nudge's state (Settings > Roles only): a chip on each slot with a newer model. */
  updates?: AeModelUpdatesState;
}

/** Settings > Roles: reads the agents and host itself. */
export function AeReviewerRows(props: ReviewerRowsProps) {
  const pinned = aeReviewerAgents(props.setting).map((r) => r.slot.agent);
  return <AeReviewerRowsView {...props} agents={useAeReviewerAgents(undefined, pinned)} />;
}

/** The rows with the agents list given (the per-session dialog passes its own). */
export function AeReviewerRowsView({
  setting,
  models,
  onChange,
  disabled,
  updates,
  agents,
}: ReviewerRowsProps & { agents: AeReviewerAgents }) {
  const { options, host, loaded } = agents;
  const codex = useAeCodexCatalog(agents);
  const slots = aeReviewerList(setting);
  const write = (next: AeReviewerSlot[]) => onChange(aeWriteReviewers(next));
  const candidate =
    slots.length < AE_REVIEWERS_MAX ? nextSlot(slots, models, options, codex.rows) : null;
  // Codex is the next pick but cannot give a model yet: wait rather than save a slot with no model.
  const codexNext = options.some(
    (o) => aeIsCodexAgent(o.agent) && o.readiness.selectable && o.primary,
  );
  const waitReason =
    !candidate && slots.length < AE_REVIEWERS_MAX && codexNext && codex.rows.length === 0
      ? host?.status !== "online"
        ? "Codex host is offline"
        : codex.failed
          ? "Codex model list unavailable"
          : "Waiting for the Codex model list"
      : !candidate && slots.length < AE_REVIEWERS_MAX
        ? "No other agent or model to add"
        : null;
  return (
    <div
      data-testid="ae-role-row-reviewer"
      role="group"
      aria-label="Reviewers"
      className="border-t border-border py-2.5"
    >
      {slots.map((_, index) => (
        <SlotRow
          // Slots have no id of their own; their place is their identity.
          // eslint-disable-next-line react/no-array-index-key -- rows hold no local state, so the index is a safe key
          key={index}
          index={index}
          slots={slots}
          rowLabel={aeReviewerRowLabel(setting)}
          models={models}
          options={options}
          codex={codex}
          host={host}
          loaded={loaded}
          disabled={disabled}
          chip={
            updates ? (
              <AeUpdateChip rowKey={`reviewer:${index}`} state={updates} disabled={disabled} />
            ) : null
          }
          onChange={(slot) => write(slots.map((s, i) => (i === index ? slot : s)))}
          onRemove={slots.length >= 2 ? () => write(slots.filter((__, i) => i !== index)) : null}
        />
      ))}
      <div className={cn(GRID, "pt-2")}>
        <div className="col-start-2 flex items-center">
          {slots.length < AE_REVIEWERS_MAX ? (
            <button
              type="button"
              disabled={disabled || !candidate}
              title={waitReason ?? undefined}
              onClick={() => candidate && write([...slots, candidate])}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-40"
            >
              <PlusIcon className="size-3.5" aria-hidden="true" />
              Add reviewer
              <span className="text-muted-foreground">
                ({slots.length} of {AE_REVIEWERS_MAX})
                {waitReason && `, ${waitReason.toLowerCase()}`}
              </span>
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">
              {AE_REVIEWERS_MAX} of {AE_REVIEWERS_MAX}. Remove one to add another.
            </span>
          )}
          <AeHint id="reviewer.add" />
        </div>
      </div>
    </div>
  );
}

/** "Reviews in this preset": the merge and unavailable rules, only with 2 or more reviewers. */
export function AeReviewSettings({
  reviewer,
  rules,
  onChange,
  disabled,
  title = "Reviews in this preset",
}: {
  reviewer: AeReviewerSetting;
  rules: AeRoleRules;
  onChange: (rules: {
    review_merge?: AeReviewMerge;
    reviewer_unavailable?: AeReviewerUnavailable;
  }) => void;
  disabled: boolean;
  title?: string;
}) {
  const slots = aeReviewerList(reviewer);
  // Own subagents only: an agent reviewer is a child session, so the lead skips it.
  const skipped =
    aeHelpersOf(rules) === "own"
      ? slots.flatMap((slot) => (slot.mode === "agent" ? [slot.name] : []))
      : [];
  const note = skipped.length ? (
    <p data-testid="ae-review-own-note" className="text-xs text-amber-600 dark:text-amber-400">
      Helpers is set to own subagents only, so {skipped.join(" and ")}{" "}
      {skipped.length > 1 ? "do" : "does"} not run. Allow any agent or session to use{" "}
      {skipped.length > 1 ? "them" : "it"}.
    </p>
  ) : null;
  if (slots.length < 2) return note ? <div className="mt-2">{note}</div> : null;
  const row = "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2";
  return (
    <div data-testid="ae-review-settings" className="mt-3 border-t border-border pt-3">
      <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {note}
      <div className={row}>
        <div className="min-w-0">
          <div className="text-sm">
            With more than one reviewer
            <AeHint id="rules.review_merge" />
          </div>
          <div className="text-xs text-muted-foreground">
            Each reviewer works alone on the same diff either way
          </div>
        </div>
        <AeSegmented
          label="With more than one reviewer"
          value={aeReviewMergeOf(rules)}
          options={AE_REVIEW_MERGE_OPTIONS}
          onChange={(review_merge) => onChange({ review_merge })}
          testId="ae-rule-review-merge"
          disabled={disabled}
        />
      </div>
      <div className={row}>
        <div className="min-w-0">
          <div className="text-sm">
            A reviewer is offline or not set up
            <AeHint id="rules.reviewer_unavailable" />
          </div>
          <div className="text-xs text-muted-foreground">Checked when the review starts</div>
        </div>
        <AeSegmented
          label="A reviewer is offline or not set up"
          value={aeReviewerUnavailableOf(rules)}
          options={AE_REVIEWER_UNAVAILABLE_OPTIONS}
          onChange={(reviewer_unavailable) => onChange({ reviewer_unavailable })}
          testId="ae-rule-reviewer-unavailable"
          disabled={disabled}
        />
      </div>
    </div>
  );
}
