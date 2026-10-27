// Settings > Roles: the editor for the open preset. The role table (A1) gives
// each role Auto, a model and effort, or for the Lead the session's own model;
// below it are the preset's model change rules. Edits stay local until Save.

import { useMemo } from "react";
import { AlertTriangleIcon, CopyIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { AeHint } from "@/components/AeHint";
import { Button } from "@/components/ui/button";
import type { AeSettingHintId } from "@/lib/aeSettingHints";
import type { AeRoleModelChoice } from "@/hooks/useAeRoleModels";
import { useAeCodexCatalog } from "@/hooks/useAeCodexCatalog";
import { useAeModelUpdates } from "@/hooks/useAeModelUpdates";
import { useAeReviewerAgents } from "@/hooks/useAeReviewerAgents";
import {
  AE_AUTO_RAISES_MAX,
  AE_COMING_LATER,
  AE_HELPERS_OPTIONS,
  AE_ROLE_IDS,
  AE_ROLE_LABELS,
  type AeRaiseMode,
  type AeRoleId,
  type AeRolePreset,
  type AeRoleRules,
  type AeWorkerSetting,
  type AeRoleTable,
  aeHelpersOf,
  aeRoleAgents,
} from "@/lib/aeRoles";
import { AeRolePresetTile, AeSegmented, AeStepper } from "./AeRolesControls";
import type { AeReviewerAgents } from "@/hooks/useAeReviewerAgents";
import { aeRoleModelPick } from "./AeRoleModelPicker";
import { AeUpdateBanner, AeUpdateChip } from "./AeModelUpdates";
import { AeReviewerRowsView, AeReviewSettings } from "./AeReviewerRows";

export type { AeRoleModelChoice } from "@/hooks/useAeRoleModels";

export interface AeRoleDraft {
  roles: AeRoleTable;
  rules: AeRoleRules;
}

const RAISE_OPTIONS: { value: AeRaiseMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "tell", label: "Tell me after" },
  { value: "ask", label: "Ask first" },
];

const ON_OFF = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const;

export function AeRoleRow({
  role,
  setting,
  models,
  agents,
  onChange,
  disabled,
  chip = null,
  ownHelpers = false,
}: {
  role: Exclude<AeRoleId, "reviewer">;
  setting: AeWorkerSetting;
  models: readonly AeRoleModelChoice[];
  /** The agents and host the Codex group reads (Settings reads them once for all rows). */
  agents: AeReviewerAgents;
  onChange: (setting: AeWorkerSetting) => void;
  disabled: boolean;
  /** The update chip, on the bar's line. */
  chip?: React.ReactNode;
  /** Helpers is "own subagents only": a Codex session here is skipped by the lead. */
  ownHelpers?: boolean;
}) {
  const { label, hint } = AE_ROLE_LABELS[role];
  const codex = useAeCodexCatalog(agents);
  // The Lead is the session itself (Claude models and the session's own); the helpers it
  // starts can also be Codex sessions. Other agents are for reviewers only.
  const pick = aeRoleModelPick({
    setting,
    groups: role === "lead" ? "claude" : "claude+codex",
    auto: true,
    session: role === "lead",
    ariaLabel: `${label} model`,
    barLabel: label,
    toolTestId: `ae-role-tool-${role}`,
    models,
    options: agents.options,
    codex,
    host: agents.host,
    disabled,
    onChange,
  });
  return (
    <div
      data-testid={`ae-role-row-${role}`}
      className="grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-2 border-t border-border py-2.5 @lg/roles:grid-cols-[7rem_minmax(0,14rem)_1fr]"
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold">
          {label}
          <AeHint id={`roles.${role}`} />
        </div>
        <div className="text-xs leading-tight text-muted-foreground">{hint}</div>
      </div>
      {pick.trigger}
      <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 @lg/roles:col-start-3 @[480px]/roles:flex-nowrap">
        {pick.bar ?? (
          <span className="text-xs text-muted-foreground">
            {setting.mode === "session" ? "The session's model and effort" : "The lead chooses"}
          </span>
        )}
        {chip}
        {ownHelpers && pick.codexSlot && (
          <span data-testid={`ae-role-skipped-${role}`} className="text-xs text-amber-500">
            Skipped: Helpers is Own subagents only
          </span>
        )}
      </div>
    </div>
  );
}

function RuleRow({
  title,
  hint,
  hintId,
  later,
  children,
}: {
  title: string;
  hint?: string;
  hintId?: AeSettingHintId;
  /** Tags a rule nothing acts on yet with a muted "Coming later" note. */
  later?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
      <div className="min-w-0">
        <div className="text-sm">
          {title}
          {hintId && <AeHint id={hintId} />}
          {later && (
            <span
              title={AE_COMING_LATER.hint}
              data-testid="ae-rule-coming-later"
              className="ml-1.5 text-[11px] text-muted-foreground"
            >
              {AE_COMING_LATER.label}
            </span>
          )}
        </div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function AeRolesEditor({
  preset,
  draft,
  isDefault,
  isStarter,
  models,
  catalogNote,
  topTier,
  dirty,
  saving,
  canDelete,
  onChange,
  onRevert,
  onSave,
  onMakeDefault,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  preset: AeRolePreset;
  draft: AeRoleDraft;
  isDefault: boolean;
  isStarter: boolean;
  models: readonly AeRoleModelChoice[];
  catalogNote: string | null;
  topTier: boolean;
  dirty: boolean;
  saving: boolean;
  canDelete: boolean;
  onChange: (draft: AeRoleDraft) => void;
  onRevert: () => void;
  onSave: () => void;
  onMakeDefault: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const setRole = (role: Exclude<AeRoleId, "reviewer">, setting: AeWorkerSetting) =>
    onChange({ ...draft, roles: { ...draft.roles, [role]: setting } });
  const setRules = (rules: Partial<AeRoleRules>) =>
    onChange({ ...draft, rules: { ...draft.rules, ...rules } });
  // The update nudge: a chip per row on an older model, never applied without a click.
  const agents = useAeReviewerAgents(undefined, aeRoleAgents(draft.roles));
  const codex = useAeCodexCatalog(agents);
  const claudeIds = useMemo(() => models.map((m) => m.value), [models]);
  const updates = useAeModelUpdates(preset.id, draft.roles, claudeIds, codex.rows, (roles) =>
    onChange({ ...draft, roles }),
  );
  return (
    <div data-testid="ae-roles-editor" className="flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-3">
        <div className="flex min-w-0 flex-[1_1_18rem] items-center gap-3">
          <AeRolePresetTile icon={preset.icon} color={preset.color} size="lg" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-3">
              <h2 className="truncate text-base font-semibold">{preset.title}</h2>
              <AeUpdateBanner state={updates} disabled={saving} />
            </div>
            <p className="text-xs text-muted-foreground">
              {isStarter ? "Starter" : "Yours"}
              {isDefault ? " · your default" : ""}
              {preset.description ? ` · ${preset.description}` : ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {isDefault ? (
            <span className="rounded-full bg-teal-500/20 px-2 py-0.5 text-xs font-medium text-teal-400">
              Default
            </span>
          ) : (
            <Button variant="outline" size="sm" disabled={saving} onClick={onMakeDefault}>
              Make default
            </Button>
          )}
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={`Edit details of ${preset.title}`}
            title="Edit name, icon and notes"
            disabled={saving}
            onClick={onEdit}
          >
            <PencilIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={`Duplicate ${preset.title}`}
            title="Duplicate"
            disabled={saving}
            onClick={onDuplicate}
          >
            <CopyIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={`Delete ${preset.title}`}
            title={canDelete ? "Delete" : "The last preset cannot be deleted"}
            disabled={saving || !canDelete}
            onClick={onDelete}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>

      <div role="group" aria-label="Roles" className="@container/roles">
        {AE_ROLE_IDS.map((role) =>
          role === "reviewer" ? (
            <AeReviewerRowsView
              key={role}
              setting={draft.roles.reviewer}
              models={models}
              onChange={(reviewer) => onChange({ ...draft, roles: { ...draft.roles, reviewer } })}
              disabled={saving}
              agents={agents}
              updates={updates}
            />
          ) : (
            <AeRoleRow
              key={role}
              role={role}
              setting={draft.roles[role]}
              models={models}
              agents={agents}
              onChange={(setting) => setRole(role, setting)}
              disabled={saving}
              chip={<AeUpdateChip rowKey={role} state={updates} disabled={saving} />}
              ownHelpers={aeHelpersOf(draft.rules) === "own"}
            />
          ),
        )}
      </div>
      {catalogNote && <p className="pt-1 text-xs text-muted-foreground">{catalogNote}</p>}
      <AeReviewSettings
        reviewer={draft.roles.reviewer}
        rules={draft.rules}
        onChange={setRules}
        disabled={saving}
      />

      <div className="mt-3 border-t border-border pt-3">
        <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Model changes in this preset
        </h3>
        <RuleRow
          title="Raise a stuck child, or lower the lead"
          hint="Applies to both directions"
          hintId="rules.raise_or_lower"
        >
          <AeSegmented
            label="Raise a stuck child, or lower the lead"
            value={draft.rules.raise_or_lower}
            options={RAISE_OPTIONS}
            onChange={(raise_or_lower) => setRules({ raise_or_lower })}
            testId="ae-rule-raise"
            disabled={saving}
          />
        </RuleRow>
        <RuleRow
          title="Lead steps down for mechanical work"
          hintId="rules.lead_steps_down"
          hint="Watching CI, applying decided fixes: the Builder's model"
        >
          <AeSegmented
            label="Lead steps down for mechanical work"
            value={draft.rules.lead_steps_down ? "on" : "off"}
            options={ON_OFF}
            onChange={(v) => setRules({ lead_steps_down: v === "on" })}
            testId="ae-rule-step-down"
            disabled={saving}
          />
        </RuleRow>
        <RuleRow
          title="Automatic raises per child"
          hint="After this, every raise asks you"
          hintId="rules.auto_raises"
        >
          <AeStepper
            label="Automatic raises per child"
            value={draft.rules.auto_raises}
            min={0}
            max={AE_AUTO_RAISES_MAX}
            onChange={(auto_raises) => setRules({ auto_raises })}
            disabled={saving}
          />
        </RuleRow>
        <RuleRow
          title="Helpers"
          hint="Who the lead may hand work to besides its own subagents"
          hintId="rules.helpers"
        >
          <AeSegmented
            label="Helpers"
            value={aeHelpersOf(draft.rules)}
            options={AE_HELPERS_OPTIONS}
            onChange={(helpers) => setRules({ helpers })}
            testId="ae-rule-helpers"
            disabled={saving}
          />
        </RuleRow>
      </div>

      {topTier && (
        <div
          role="note"
          data-testid="ae-roles-top-tier"
          className="mt-3 flex gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs"
        >
          <AlertTriangleIcon className="mt-px size-4 shrink-0 text-red-400" aria-hidden="true" />
          <p>
            <b>Top cost tier on every role.</b>{" "}
            <span className="text-muted-foreground">
              A family on {preset.title} uses the most tokens per turn of any preset. Your usage
              limits still apply, and the usage gate still warns you near a limit.
            </span>
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">
          {dirty ? "Unsaved edits to this preset" : "Edits save to this preset"}
        </span>
        <Button variant="outline" size="sm" disabled={!dirty || saving} onClick={onRevert}>
          Revert
        </Button>
        <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
