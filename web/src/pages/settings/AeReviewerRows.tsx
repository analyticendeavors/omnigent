// Settings > Roles: the Reviewer row with one to three reviewers (omnigent-ae,
// 2026-10-24, concept A). Slot 1 sits on the role row; slots 2 and 3 stack
// under it, numbered. Every slot is one model dropdown and one effort bar: a
// Claude model (a subagent), a Codex model (a child session, tagged Codex; the
// bar has the steps that model offers) or another agent. The two review
// settings show with 2 or more.

import { useId, useState } from "react";
import { AeHint } from "@/components/AeHint";
import { aeWhenChipClass } from "@/lib/aeWhenChip";
import { AeFoldPicker } from "./AeFoldPicker";
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
import {
  type AePersonaEntry,
  aeEffectiveSlot,
  aePersonaBarredFromFirst,
  aePersonaOf,
} from "@/lib/aePersonas";
import { AE_ROLE_LABELS, type AeRoleEffort, type AeRoleRules, aeHelpersOf } from "@/lib/aeRoles";
import type { AeTeamOption } from "@/lib/aeTeamOptions";
import { codexEffortLevelsForModel, comparableModelId } from "@/lib/codexNativeModels";
import type { NativeModelOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AeUpdateChip } from "./AeModelUpdates";
import { AeSegmented } from "./AeRolesControls";
import { aeRoleModelPick } from "./AeRoleModelPicker";

// Grid rows of the narrow layout (literal class names, so Tailwind sees them).
const NARROW_ROW = ["", "", "row-start-2", "row-start-3", "row-start-4"] as const;

const NO_PERSONAS: readonly AePersonaEntry[] = [];

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

// Reviewer personas (2026-11-01): the slot's persona, in the same picker as the model next to
// it (2026-11-01, patch 0282). Reviewer 1 takes the fix checks, so it always runs and the
// personas that run only when the diff is risky are not offered there. The slot's own model
// and effort override the persona's.
function PersonaSelect({
  slot,
  index,
  label,
  personas,
  disabled,
  noteId,
  onChange,
}: {
  slot: AeReviewerSlot;
  index: number;
  label: string;
  personas: readonly AePersonaEntry[];
  disabled: boolean;
  /** Id of the "persona is gone" note under the header, when the slot names a missing one. */
  noteId: string;
  onChange: (persona: string) => void;
}) {
  if (slot.mode === "auto") return <div />;
  const current = slot.persona ?? "";
  const known = personas.some((p) => p.id === current);
  const barred = (p: AePersonaEntry) => index === 0 && aePersonaBarredFromFirst(p);
  const option = (p: AePersonaEntry) => ({
    value: p.id,
    label: p.name,
    ...(barred(p) && p.id !== current ? { note: "runs only if risky", disabled: true } : {}),
  });
  const mine = personas.filter((p) => !p.builtin);
  return (
    <div className="min-w-0">
      <AeFoldPicker
        ariaLabel={`${label} persona`}
        describedBy={current && !known ? noteId : undefined}
        value={current}
        disabled={disabled}
        top={[
          { value: "", label: "No persona" },
          ...(current && !known ? [{ value: current, label: `${current} (not found)` }] : []),
        ]}
        groups={[
          {
            id: "builtin",
            label: "Built-in",
            options: personas.filter((p) => p.builtin).map(option),
            older: [],
          },
          { id: "yours", label: "Yours", options: mine.map(option), older: [] },
        ]}
        triggerClassName="px-2"
        onPick={onChange}
      />
    </div>
  );
}

/** `next` (a model pick) with the persona of the slot it replaces; Auto cannot hold one. */
function withPersona(next: AeReviewerSlot, previous: AeReviewerSlot): AeReviewerSlot {
  const persona = previous.mode === "auto" ? undefined : previous.persona;
  return persona && next.mode !== "auto" ? { ...next, persona } : next;
}

/**
 * The slot after the persona select picks `persona` ("" for none). Picking keeps the
 * slot's own model and effort as overrides; dropping the persona writes the model the slot
 * was showing, so the slot never ends up with neither.
 */
function withChosenPersona(
  slot: AeReviewerSlot,
  shown: AeReviewerSlot,
  persona: string,
): AeReviewerSlot {
  if (slot.mode === "auto") return slot;
  if (persona) return { ...slot, persona };
  const { persona: _dropped, ...rest } = { ...slot, ...(shown.mode === "auto" ? {} : shown) };
  // A persona with no model of its own leaves nothing to keep, so a plain slot needs one.
  return (
    rest.mode === "fixed" && !(rest.model && rest.effort)
      ? { mode: "fixed", model: "claude-sonnet-5-5", effort: "medium" }
      : rest
  ) as AeReviewerSlot;
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
  personas,
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
  personas: readonly AePersonaEntry[];
  onChange: (slot: AeReviewerSlot) => void;
  onRemove: (() => void) | null;
}) {
  const slot = slots[index];
  // What the pickers show: a persona-only slot takes the persona's model and effort.
  const shown = aeEffectiveSlot(slot, personas);
  const label = `Reviewer ${index + 1}`;
  const usedBy = (model: string) => {
    const at = slots.findIndex((s, i) => {
      const other = aeEffectiveSlot(s, personas);
      return (
        i !== index &&
        other.mode === "fixed" &&
        comparableModelId(other.model ?? "") === comparableModelId(model)
      );
    });
    return at < 0 ? "" : `used by Reviewer ${at + 1}`;
  };
  const pick = aeRoleModelPick({
    setting: shown as Parameters<typeof aeRoleModelPick>[0]["setting"],
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
    // Picking a model keeps the slot's persona and writes the pick as its override.
    onChange: (next) => onChange(withPersona(next as AeReviewerSlot, slot)),
  });
  const { agentSlot, agentState, trigger, bar } = pick;
  const agentOption = agentState?.option ?? null;
  const { hint } = AE_ROLE_LABELS.reviewer;
  const noteId = useId();
  const persona = slot.mode === "auto" ? undefined : aePersonaOf(slot, personas);
  const missing = slot.mode !== "auto" && !!slot.persona && !persona;
  // A persona with a model supplies it when the slot has none of its own.
  const fromPersona = slot.mode === "fixed" && !slot.model && !!persona?.model;
  const risky = persona?.when === "risky";
  const unready =
    agentSlot && loaded && agentState && agentState.status !== "ready" ? agentState : null;
  return (
    <div
      data-testid={`ae-reviewer-slot-${index + 1}`}
      className={cn(
        "grid grid-cols-1 gap-y-1.5 @lg/roles:grid-cols-[7rem_minmax(0,1fr)] @lg/roles:items-center @lg/roles:gap-x-3",
        index > 0 && "pt-2",
      )}
    >
      {index === 0 ? (
        <div className="min-w-0 @lg/roles:self-start">
          <div className="text-sm font-semibold">
            {rowLabel}
            <AeHint id="roles.reviewer" />
          </div>
          <div className="text-xs leading-tight text-muted-foreground">{hint}</div>
        </div>
      ) : (
        <div className="hidden @lg/roles:block" />
      )}
      {/* Narrow: a header line (number, persona, when), then note, model, effort and Remove.
          From 40rem: one line. The DOM order is the focus order in both; the grid places it. */}
      <div className="grid min-w-0 grid-cols-[1.5rem_minmax(9rem,auto)_1fr_auto] items-center gap-x-2 gap-y-2 @[40rem]/roles:grid-cols-[1.25rem_7.5rem_minmax(0,1fr)_7rem_3rem_1.5rem] @[40rem]/roles:gap-x-1.5">
        <span
          aria-hidden="true"
          className="col-start-1 row-start-1 grid size-5 place-items-center rounded-full border border-border bg-muted text-[11px] text-muted-foreground"
        >
          {index + 1}
        </span>
        <div className="col-start-2 row-start-1 min-w-0">
          <PersonaSelect
            slot={slot}
            index={index}
            label={label}
            personas={personas}
            disabled={disabled}
            noteId={noteId}
            onChange={(next) => onChange(withChosenPersona(slot, shown, next))}
          />
        </div>
        <div
          className={cn(
            "col-span-full flex min-w-0 items-center gap-2 @[40rem]/roles:col-[3] @[40rem]/roles:row-start-1",
            NARROW_ROW[missing ? 3 : 2],
          )}
        >
          <div className="min-w-0 flex-1">{trigger}</div>
          {fromPersona && (
            <span className="shrink-0 text-[11px] text-muted-foreground @[40rem]/roles:hidden">
              from persona
            </span>
          )}
        </div>
        <div
          className={cn(
            "col-[1/4] flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 @[40rem]/roles:col-[4] @[40rem]/roles:row-start-1",
            NARROW_ROW[missing ? 4 : 3],
          )}
        >
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
        </div>
        <span
          data-testid={`ae-reviewer-when-${index + 1}`}
          className={cn(
            aeWhenChipClass(risky ? "risky" : "always"),
            "col-start-3 row-start-1 justify-self-start @[40rem]/roles:col-[5]",
          )}
        >
          {risky ? (
            <>
              risky<span className="@[40rem]/roles:hidden"> diffs</span>
            </>
          ) : (
            "always"
          )}
        </span>
        {onRemove && (
          <button
            type="button"
            aria-label={`Remove ${label}`}
            title={`Remove ${label}`}
            disabled={disabled}
            onClick={onRemove}
            className={cn(
              "col-start-4 shrink-0 justify-self-end rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 @[40rem]/roles:col-[6] @[40rem]/roles:row-start-1",
              NARROW_ROW[missing ? 4 : 3],
            )}
          >
            <XIcon className="size-3.5" />
          </button>
        )}
        {missing && (
          <span
            id={noteId}
            data-testid={`ae-reviewer-persona-missing-${index + 1}`}
            className="col-span-full row-start-2 text-[11px] text-amber-700 @[40rem]/roles:col-[2/-1] dark:text-amber-500"
          >
            That persona is gone, so this reviewer runs as a plain review.
          </span>
        )}
        {fromPersona && (
          <span className="col-span-full hidden text-[11px] text-muted-foreground @[40rem]/roles:col-[2/-1] @[40rem]/roles:row-start-2 @[40rem]/roles:block">
            Model and effort from the persona
          </span>
        )}
        <div className="col-span-full row-start-6 flex flex-wrap items-center gap-x-3 gap-y-1 empty:hidden @[40rem]/roles:col-[2/-1] @[40rem]/roles:row-start-3">
          {chip}
          {unready && (
            <span data-testid={`ae-reviewer-tag-${index + 1}`} className="flex items-center gap-1">
              <Tag tone="amber">
                {unready.status === "setup"
                  ? "Needs setup"
                  : unready.status === "missing"
                    ? "Not found"
                    : "Offline"}
              </Tag>
              {unready.status === "setup" && (
                <a
                  href={aeAgentSetupHref(unready.option?.agent.harness)}
                  className="text-xs text-primary hover:underline"
                >
                  Set up
                </a>
              )}
            </span>
          )}
        </div>
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
  /** The personas a slot can name, built-in first (Settings > Roles passes them). */
  personas?: readonly AePersonaEntry[];
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
  personas = NO_PERSONAS,
}: ReviewerRowsProps & { agents: AeReviewerAgents }) {
  const { options, host, loaded } = agents;
  const codex = useAeCodexCatalog(agents);
  const slots = aeReviewerList(setting);
  // Said when removing reviewer 1 moved a persona that runs only if risky up into its place.
  const [promoted, setPromoted] = useState<string | null>(null);
  const write = (next: AeReviewerSlot[]) => {
    setPromoted(null);
    onChange(aeWriteReviewers(next));
  };
  // Removing a reviewer moves the next one up. Reviewer 1 always runs (it takes the fix
  // checks), so a persona that runs only if risky is dropped from the slot that lands there;
  // the slot keeps the model and effort it was showing (review fix, patch 0278).
  const remove = (index: number) => {
    const next = slots.filter((__, i) => i !== index);
    const first = next[0];
    const barred =
      index === 0 && first && first.mode !== "auto" && first.persona
        ? personas.find((p) => p.id === first.persona && aePersonaBarredFromFirst(p))
        : undefined;
    if (!first || !barred) return write(next);
    next[0] = withChosenPersona(first, aeEffectiveSlot(first, personas), "");
    write(next);
    setPromoted(
      `${barred.name} runs only when the diff is risky, and reviewer 1 always runs, so it is now a plain reviewer with the same model and effort.`,
    );
  };
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
          personas={personas}
          chip={
            updates ? (
              <AeUpdateChip rowKey={`reviewer:${index}`} state={updates} disabled={disabled} />
            ) : null
          }
          onChange={(slot) => write(slots.map((s, i) => (i === index ? slot : s)))}
          onRemove={slots.length >= 2 ? () => remove(index) : null}
        />
      ))}
      {promoted && (
        <p
          role="status"
          data-testid="ae-reviewer-promoted-note"
          className="pt-2 text-xs text-amber-600 dark:text-amber-400"
        >
          {promoted}
        </p>
      )}
      <div className="grid grid-cols-1 pt-2 @lg/roles:grid-cols-[7rem_minmax(0,1fr)] @lg/roles:gap-x-3">
        <div className="flex items-center @lg/roles:col-start-2">
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
              {AE_REVIEWERS_MAX} of {AE_REVIEWERS_MAX} reviewers. Remove one to add another.
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
