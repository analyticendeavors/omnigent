// The one model picker every role row shares (omnigent-ae, 2026-10-26). It was the
// Reviewer slot's picker (2026-10-24, folded 2026-10-26); the Lead, Planner, Builder
// and Helper rows now use it too. Top options (Auto, and for the Lead the Session
// model), then "Run through Claude, as a subagent" and, where the row allows it,
// "Run through Codex, as a child session" (each: latest on top, older ones in a
// fold) and "Other agents" (Reviewer rows only). `aeRoleModelPick` returns the
// trigger and the effort bar as two nodes so each row lays them out its own way.

import type { ReactNode } from "react";
import { AeHint } from "@/components/AeHint";
import type { AeRoleModelChoice } from "@/hooks/useAeRoleModels";
import type { AeCodexCatalog } from "@/hooks/useAeCodexCatalog";
import type { Host } from "@/hooks/useHosts";
import { aeCodexDefaultEffort, aeCodexEfforts, aeCodexLabel } from "@/lib/aeCodexModels";
import { aeClaudeFoldSplit, aeCodexFoldSplit } from "@/lib/aeModelFold";
import { aeClaudeCodeDefaultEffort } from "@/lib/aeEffortDefault";
import {
  AE_AGENT_NAME_MAX,
  AE_CODEX_AGENT_ID,
  AE_CODEX_AGENT_NAME,
  type AeReviewerAgentSlot,
  aeAgentEfforts,
  aeAgentNameOf,
  aeIsCodexSlot,
  aeReviewerAgentStatus,
} from "@/lib/aeReviewers";
import { AE_ROLE_EFFORTS, type AeRoleEffort, aeModelDotClass, aeModelLabel } from "@/lib/aeRoles";
import type { AeAgentEffort } from "@/lib/aeRoleBase";
import type { AeTeamOption } from "@/lib/aeTeamOptions";
import { comparableModelId, findNativeModelOption } from "@/lib/codexNativeModels";
import type { NativeModelOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AeEffortBar } from "./AeRolesControls";
import { AeFoldPicker, type AeFoldGroup, type AeFoldOption } from "./AeFoldPicker";

const AUTO = "__auto";
const SESSION = "__session";
const AGENT = "agent:";
const CODEX = "codex:";

/** What a row stores: Auto, the session's model (Lead), a Claude model, or an agent slot. */
export type AePickSetting =
  | { mode: "auto" }
  | { mode: "session" }
  | { mode: "fixed"; model: string; effort: AeRoleEffort }
  | AeReviewerAgentSlot;

/** Which groups a row offers under the top options. */
export type AePickGroups = "claude" | "claude+codex" | "all";

/** The dropdown's value for a Codex model, and the one for "no model named". */
const rowValue = (row: NativeModelOption) => row.model ?? row.id;

export interface AeRolePickInput {
  setting: AePickSetting;
  groups: AePickGroups;
  /** Offer "Auto (the lead picks)" on top. */
  auto: boolean;
  /** Offer "Session model" on top (the Lead only). */
  session?: boolean;
  /** The trigger's name without the model, e.g. "Planner model". */
  ariaLabel: string;
  /** The effort bar's name, e.g. "Planner". */
  barLabel: string;
  /** Test id of the "Codex" tag drawn over the trigger. */
  toolTestId?: string;
  models: readonly AeRoleModelChoice[];
  options: readonly AeTeamOption[];
  codex: AeCodexCatalog;
  host: Host | null;
  disabled: boolean;
  /** Says which other row already uses a model ("used by Reviewer 2"). */
  usedBy?: (model: string) => string;
  onChange: (setting: AePickSetting) => void;
}

export interface AeRolePick {
  trigger: ReactNode;
  /** The effort bar, or null when the setting has none (Auto, Session, another agent). */
  bar: ReactNode | null;
  fixed: Extract<AePickSetting, { mode: "fixed" }> | null;
  agentSlot: AeReviewerAgentSlot | null;
  codexSlot: AeReviewerAgentSlot | null;
  agentState: ReturnType<typeof aeReviewerAgentStatus> | null;
}

export function aeRoleModelPick(input: AeRolePickInput): AeRolePick {
  const { setting, groups, models, options, codex, host, disabled, onChange } = input;
  const fixed = setting.mode === "fixed" ? setting : null;
  const agentSlot = setting.mode === "agent" ? setting : null;
  const listed = fixed
    ? models.find((m) => comparableModelId(m.value) === comparableModelId(fixed.model))
    : undefined;
  const agentState = agentSlot ? aeReviewerAgentStatus(agentSlot, options, host) : null;
  const agentOption = agentState?.option ?? null;
  // The live id when the slot was stored under another one (matched by registered name).
  const agentId = agentSlot ? (agentOption?.agent.id ?? agentSlot.agent) : "";
  // A Codex slot shows its model in the one dropdown, like a Claude row; its
  // models come from the host (the stored one, else the host's default).
  const codexSlot = agentSlot && aeIsCodexSlot(agentSlot, agentOption) ? agentSlot : null;
  const defaultRow = codex.rows.find((row) => row.isDefault) ?? null;
  const codexRow = codexSlot
    ? codexSlot.model
      ? findNativeModelOption(codex.rows, codexSlot.model)
      : defaultRow
    : null;
  const codexValue = codexSlot
    ? `${CODEX}${codexRow ? rowValue(codexRow) : (codexSlot.model ?? "")}`
    : "";
  // Everything the host lists, when Codex is ready to pick from (latest on top, the rest in the fold).
  const pickable = codex.ready ? codex.rows : [];
  // The saved value always has its own option, whatever the agent's state or the list's.
  const codexOffered = codexSlot && !pickable.some((row) => row === codexRow);
  const value = fixed
    ? (listed?.value ?? fixed.model)
    : codexSlot
      ? codexValue
      : agentSlot
        ? `${AGENT}${agentId}`
        : setting.mode === "session"
          ? SESSION
          : AUTO;
  const rest = options.filter((o) => !(codex.ready && o.agent.id === codex.option?.agent.id));
  const ready = rest.filter((o) => o.readiness.selectable && o.primary);
  const needSetup = rest.filter((o) => !o.readiness.selectable);
  const choose = (next: string) => {
    if (next === AUTO) return onChange({ mode: "auto" });
    if (next === SESSION) return onChange({ mode: "session" });
    if (next.startsWith(CODEX)) {
      const model = next.slice(CODEX.length);
      const named = codexSlot ?? codex.option;
      if (!model || !named) return;
      const target = findNativeModelOption(codex.rows, model);
      const offered = aeCodexEfforts(target);
      const current = codexSlot?.effort ?? fixed?.effort ?? null;
      const effort =
        current && (offered.length === 0 || offered.includes(current))
          ? current
          : aeCodexDefaultEffort(target);
      // A worker row stores the built-in Codex agent, the only one the server accepts there.
      const builtIn = groups !== "all";
      const identity = builtIn ? { agent: AE_CODEX_AGENT_ID, agent_name: AE_CODEX_AGENT_NAME } : {};
      if (codexSlot) return onChange({ ...codexSlot, ...identity, model, effort });
      const option = codex.option as AeTeamOption;
      return onChange({
        mode: "agent",
        agent: builtIn ? AE_CODEX_AGENT_ID : option.agent.id,
        agent_name: builtIn ? AE_CODEX_AGENT_NAME : aeAgentNameOf(option.agent.name),
        name: Array.from(option.name).slice(0, AE_AGENT_NAME_MAX).join("") || "Agent",
        model,
        effort,
      });
    }
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
    const carried = fixed?.effort ?? (agentSlot?.effort === "ultra" ? "max" : agentSlot?.effort);
    const effort =
      carried ?? ((aeClaudeCodeDefaultEffort(next) as AeRoleEffort | null) || "medium");
    onChange({ mode: "fixed", model: next, effort });
  };
  // The bar offers the levels this row's model offers: all five for Claude, the model's own for Codex.
  const codexLevels = aeCodexEfforts(codexRow);
  const resolved = codexLevels.length > 0;
  const baseLevels: readonly AeAgentEffort[] = codexSlot
    ? resolved
      ? codexLevels
      : aeAgentEfforts(agentOption?.agent.harness)
    : AE_ROLE_EFFORTS;
  const storedEffort = codexSlot?.effort ?? null;
  // A stored effort the model no longer offers is shown as it is, as an extra step marked unavailable.
  const stray = storedEffort && !baseLevels.includes(storedEffort) ? storedEffort : null;
  const barLevels: readonly AeAgentEffort[] = stray ? [...baseLevels, stray] : baseLevels;
  const barEffort: AeAgentEffort | null =
    storedEffort ?? (codexRow ? aeCodexDefaultEffort(codexRow) : null);
  const barUnavailable = resolved ? stray : null;
  // A stored model the catalog lacks is sorted like any other: older than its family's newest goes
  // under Older models (which then opens), newer goes on top.
  const strayModel =
    fixed && !listed ? { value: fixed.model, label: aeModelLabel(fixed.model) } : null;
  const claudeSplit = aeClaudeFoldSplit(strayModel ? [...models, strayModel] : models);
  const strayFirst = (list: readonly AeRoleModelChoice[]) =>
    strayModel
      ? [...list.filter((m) => m === strayModel), ...list.filter((m) => m !== strayModel)]
      : list;
  const codexSplit = aeCodexFoldSplit(codex.ready ? codex.rows : []);
  const codexOption = (row: NativeModelOption): AeFoldOption => ({
    value: `${CODEX}${rowValue(row)}`,
    label: aeCodexLabel(row),
    id: row.id,
  });
  const claudeOption = (model: AeRoleModelChoice): AeFoldOption => ({
    value: model.value,
    label: model.label,
    note: input.usedBy?.(model.value) || undefined,
  });
  const top: AeFoldOption[] = [
    ...(input.auto ? [{ value: AUTO, label: "Auto (the lead picks)" }] : []),
    ...(input.session ? [{ value: SESSION, label: "Session model" }] : []),
  ];
  const pickerGroups: AeFoldGroup[] = [
    {
      id: "claude",
      label: groups === "claude" ? "Claude models" : "Run through Claude, as a subagent",
      options: [...strayFirst(claudeSplit.latest).map(claudeOption)],
      older: claudeSplit.older.map(claudeOption),
    },
    ...(groups !== "claude" && (codex.ready || codexSlot)
      ? [
          {
            id: "codex",
            label: "Run through Codex, as a child session",
            options: [
              ...(codexOffered
                ? [
                    {
                      value: codexValue,
                      label: codexRow
                        ? aeCodexLabel(codexRow)
                        : codexSlot?.model || "Codex, default model",
                    },
                  ]
                : []),
              ...codexSplit.latest.map(codexOption),
              ...(codex.ready && codex.loading
                ? [{ value: "__codex_loading", label: "Loading Codex models", disabled: true }]
                : []),
              ...(codex.ready && codex.failed
                ? [{ value: "__codex_failed", label: "Codex models unavailable", disabled: true }]
                : []),
            ],
            older: codexSplit.older.map(codexOption),
          },
        ]
      : []),
    ...(groups === "all"
      ? [
          {
            id: "agents",
            label: "Other agents",
            options: [
              ...(agentSlot && !codexSlot && !ready.some((o) => o.agent.id === agentId)
                ? [{ value, label: agentSlot.name }]
                : []),
              ...ready.map((o) => ({ value: `${AGENT}${o.agent.id}`, label: o.name })),
              ...needSetup
                .filter((o) => o.agent.id !== agentId)
                .map((o) => ({
                  value: `${AGENT}${o.agent.id}`,
                  label: o.name,
                  note: "needs setup",
                  disabled: true,
                })),
            ],
            older: [],
          },
        ]
      : []),
  ];
  const dotModel = fixed ? fixed.model : codexRow ? rowValue(codexRow) : (codexSlot?.model ?? "");
  const trigger = (
    <div className="relative flex min-w-0 items-center">
      {(fixed || codexSlot) && (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute left-2.5 size-2 rounded-full",
            aeModelDotClass(dotModel),
          )}
        />
      )}
      {codexSlot && (
        <span
          aria-hidden="true"
          data-testid={input.toolTestId}
          className="pointer-events-none absolute right-7 rounded-full bg-muted px-1.5 py-px text-[11px] font-medium text-foreground"
        >
          Codex
        </span>
      )}
      <AeFoldPicker
        ariaLabel={input.ariaLabel}
        nameSuffix={codexSlot ? ", runs through Codex" : ""}
        value={value}
        disabled={disabled}
        top={top}
        groups={pickerGroups}
        headingHint={<AeHint id="reviewer.older" />}
        onPick={choose}
        triggerClassName={cn("pr-2", fixed || codexSlot ? "pl-6" : "pl-2")}
        nameClassName={codexSlot ? "mr-[4.25rem]" : undefined}
      />
    </div>
  );
  const bar =
    fixed || codexSlot ? (
      <AeEffortBar
        role={input.barLabel}
        effort={fixed ? fixed.effort : barEffort}
        levels={fixed ? AE_ROLE_EFFORTS : barLevels}
        unavailable={fixed ? null : barUnavailable}
        onChange={(effort) =>
          onChange(
            fixed
              ? { ...fixed, effort: effort as AeRoleEffort }
              : codexSlot
                ? { ...codexSlot, effort }
                : setting,
          )
        }
        disabled={disabled}
      />
    ) : null;
  return { trigger, bar, fixed, agentSlot, codexSlot, agentState };
}
