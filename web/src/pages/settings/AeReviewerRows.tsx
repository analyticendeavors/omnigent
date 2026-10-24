// Settings > Roles: the Reviewer row with one to three reviewers (omnigent-ae,
// 2026-10-24, concept A). Slot 1 sits on the role row; slots 2 and 3 stack
// under it, numbered. Each slot picks a Claude model (a subagent, with the
// same effort bars as the other roles) or another agent (a child session,
// with its model and effort). The two review settings show with 2 or more.

import { PlusIcon, XIcon } from "lucide-react";
import { type AeReviewerAgents, useAeReviewerAgents } from "@/hooks/useAeReviewerAgents";
import type { AeRoleModelChoice } from "@/hooks/useAeRoleModels";
import { type Host, useHostModelOptions } from "@/hooks/useHosts";
import { aeClaudeCodeDefaultEffort, aeClaudeEffortLabel } from "@/lib/aeEffortDefault";
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
  AE_CODEX_AGENT_ID,
  AE_CODEX_AGENT_NAME,
  aeAgentEfforts,
  aeAgentNameOf,
  aeAgentSetupHref,
  aeReviewerAgentOption,
  aeReviewerAgents,
  aeReviewerAgentStatus,
  aeReviewerList,
  aeReviewerRowLabel,
  aeReviewerUnavailableOf,
  aeReviewMergeOf,
  aeWriteReviewers,
} from "@/lib/aeReviewers";
import {
  AE_ROLE_LABELS,
  type AeRoleEffort,
  type AeRoleRules,
  aeHelpersOf,
  aeModelDotClass,
  aeModelLabel,
} from "@/lib/aeRoles";
import type { AeTeamOption } from "@/lib/aeTeamOptions";
import { codexEffortLevelsForModel, comparableModelId } from "@/lib/codexNativeModels";
import { cn } from "@/lib/utils";
import { AeEffortBar, AeSegmented } from "./AeRolesControls";

const AUTO = "__auto";
const AGENT = "agent:";

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

function SlotRow({
  index,
  slots,
  rowLabel,
  models,
  options,
  host,
  loaded,
  disabled,
  onChange,
  onRemove,
}: {
  index: number;
  slots: readonly AeReviewerSlot[];
  rowLabel: string;
  models: readonly AeRoleModelChoice[];
  options: readonly AeTeamOption[];
  host: Host | null;
  loaded: boolean;
  disabled: boolean;
  onChange: (slot: AeReviewerSlot) => void;
  onRemove: (() => void) | null;
}) {
  const slot = slots[index];
  const label = `Reviewer ${index + 1}`;
  const fixed = slot.mode === "fixed" ? slot : null;
  const agentSlot = slot.mode === "agent" ? slot : null;
  const listed = fixed
    ? models.find((m) => comparableModelId(m.value) === comparableModelId(fixed.model))
    : undefined;
  const agentState = agentSlot ? aeReviewerAgentStatus(agentSlot, options, host) : null;
  // The live id when the slot was stored under another one (matched by registered name).
  const agentId = agentSlot ? (agentState?.option?.agent.id ?? agentSlot.agent) : "";
  const value = fixed ? (listed?.value ?? fixed.model) : agentSlot ? `${AGENT}${agentId}` : AUTO;
  const ready = options.filter((o) => o.readiness.selectable && o.primary);
  const needSetup = options.filter((o) => !o.readiness.selectable);
  const usedBy = (model: string) => {
    const at = slots.findIndex(
      (s, i) =>
        i !== index &&
        s.mode === "fixed" &&
        comparableModelId(s.model) === comparableModelId(model),
    );
    return at < 0 ? "" : `, used by Reviewer ${at + 1}`;
  };
  const choose = (next: string) => {
    if (next === AUTO) return onChange({ mode: "auto" });
    if (next.startsWith(AGENT)) {
      const id = next.slice(AGENT.length);
      const option = options.find((o) => o.agent.id === id);
      if (!option) return;
      return onChange({
        mode: "agent",
        agent: id,
        agent_name: aeAgentNameOf(option.agent.name),
        name: Array.from(option.name).slice(0, AE_AGENT_NAME_MAX).join("") || "Agent",
        model: null,
        effort: null,
      });
    }
    const effort =
      fixed?.effort ?? ((aeClaudeCodeDefaultEffort(next) as AeRoleEffort | null) || "medium");
    onChange({ mode: "fixed", model: next, effort });
  };
  const { hint } = AE_ROLE_LABELS.reviewer;
  return (
    <div data-testid={`ae-reviewer-slot-${index + 1}`} className={cn(GRID, index > 0 && "pt-2")}>
      {index === 0 ? (
        <div className="min-w-0">
          <div className="text-sm font-semibold">{rowLabel}</div>
          <div className="text-xs leading-tight text-muted-foreground">{hint}</div>
        </div>
      ) : (
        <div className="pr-1 text-right text-xs font-medium text-muted-foreground">{index + 1}</div>
      )}
      <label className="relative flex min-w-0 items-center">
        <span className="sr-only">{`${label} model`}</span>
        {fixed && (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute left-2.5 size-2 rounded-full",
              aeModelDotClass(fixed.model),
            )}
          />
        )}
        <select
          aria-label={index === 0 ? "Reviewer model" : `${label} model`}
          value={value}
          disabled={disabled}
          onChange={(e) => choose(e.target.value)}
          className={cn(
            "w-full min-w-0 rounded-md border border-input bg-background py-1.5 pr-2 text-sm text-foreground",
            fixed ? "pl-6" : "pl-2",
          )}
        >
          {index === 0 && <option value={AUTO}>Auto (the lead picks)</option>}
          <optgroup label="Claude, as a subagent">
            {fixed && !listed && <option value={fixed.model}>{aeModelLabel(fixed.model)}</option>}
            {models.map((model) => (
              <option key={model.value} value={model.value}>
                {model.label}
                {usedBy(model.value)}
              </option>
            ))}
          </optgroup>
          <optgroup label="Other agents, as a child session">
            {agentSlot && !ready.some((o) => o.agent.id === agentId) && (
              <option value={value}>{agentSlot.name}</option>
            )}
            {ready.map((o) => (
              <option key={o.agent.id} value={`${AGENT}${o.agent.id}`}>
                {o.name}
              </option>
            ))}
            {needSetup
              .filter((o) => o.agent.id !== agentId)
              .map((o) => (
                <option key={o.agent.id} value={`${AGENT}${o.agent.id}`} disabled>
                  {`${o.name} (needs setup)`}
                </option>
              ))}
          </optgroup>
        </select>
      </label>
      <div className="col-start-2 flex min-w-0 items-center justify-between gap-2 @lg/roles:col-start-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {fixed ? (
            <AeEffortBar
              role={index === 0 ? "Reviewer" : label}
              effort={fixed.effort}
              onChange={(effort) => onChange({ ...fixed, effort })}
              disabled={disabled}
            />
          ) : agentSlot ? (
            <AgentDetails
              slot={agentSlot}
              label={label}
              option={agentState?.option ?? null}
              host={host}
              disabled={disabled}
              onChange={onChange}
            />
          ) : (
            <span className="text-xs text-muted-foreground">The lead chooses</span>
          )}
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

/** A new slot that differs from the others: a ready agent first (another provider), else an unused model. */
function nextSlot(
  slots: readonly AeReviewerSlot[],
  models: readonly AeRoleModelChoice[],
  options: readonly AeTeamOption[],
): AeReviewerSlot | null {
  const agentSlots = slots.flatMap((s) => (s.mode === "agent" ? [s] : []));
  const free = options.filter(
    (o) =>
      o.readiness.selectable &&
      o.primary &&
      !agentSlots.some((s) => aeReviewerAgentOption(s, [o]) !== null),
  );
  // Another provider first: the team list's recommendation, or Codex where nothing is recommended (Settings has no lead).
  const preferred =
    free.find((o) => o.recommendation) ??
    free.find((o) => o.agent.id === AE_CODEX_AGENT_ID || o.agent.name === AE_CODEX_AGENT_NAME);
  const agent = preferred ?? free[0];
  if (preferred) {
    return {
      mode: "agent",
      agent: agent.agent.id,
      agent_name: aeAgentNameOf(agent.agent.name),
      name: Array.from(agent.name).slice(0, AE_AGENT_NAME_MAX).join(""),
      model: null,
      effort: null,
    };
  }
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
  if (agent) {
    return {
      mode: "agent",
      agent: agent.agent.id,
      agent_name: aeAgentNameOf(agent.agent.name),
      name: Array.from(agent.name).slice(0, AE_AGENT_NAME_MAX).join(""),
      model: null,
      effort: null,
    };
  }
  return null;
}

interface ReviewerRowsProps {
  setting: AeReviewerSetting;
  models: readonly AeRoleModelChoice[];
  onChange: (setting: AeReviewerSetting) => void;
  disabled: boolean;
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
  agents: { options, host, loaded },
}: ReviewerRowsProps & { agents: AeReviewerAgents }) {
  const slots = aeReviewerList(setting);
  const write = (next: AeReviewerSlot[]) => onChange(aeWriteReviewers(next));
  const candidate = slots.length < AE_REVIEWERS_MAX ? nextSlot(slots, models, options) : null;
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
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          index={index}
          slots={slots}
          rowLabel={aeReviewerRowLabel(setting)}
          models={models}
          options={options}
          host={host}
          loaded={loaded}
          disabled={disabled}
          onChange={(slot) => write(slots.map((s, i) => (i === index ? slot : s)))}
          onRemove={slots.length >= 2 ? () => write(slots.filter((__, i) => i !== index)) : null}
        />
      ))}
      <div className={cn(GRID, "pt-2")}>
        <div className="col-start-2">
          {slots.length < AE_REVIEWERS_MAX ? (
            <button
              type="button"
              disabled={disabled || !candidate}
              onClick={() => candidate && write([...slots, candidate])}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-40"
            >
              <PlusIcon className="size-3.5" aria-hidden="true" />
              Add reviewer
              <span className="text-muted-foreground">
                ({slots.length} of {AE_REVIEWERS_MAX})
              </span>
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">
              {AE_REVIEWERS_MAX} of {AE_REVIEWERS_MAX}. Remove one to add another.
            </span>
          )}
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
          <div className="text-sm">With more than one reviewer</div>
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
          <div className="text-sm">A reviewer is offline or not set up</div>
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
