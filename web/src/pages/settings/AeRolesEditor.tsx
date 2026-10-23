// Settings > Roles: the editor for the open preset. The role table (A1) gives
// each role Auto, a model and effort, or for the Lead the session's own model;
// below it are the preset's model change rules. Edits stay local until Save.

import { AlertTriangleIcon, CopyIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { aeClaudeCodeDefaultEffort, aeClaudeEffortLabel } from "@/lib/aeEffortDefault";
import {
  AE_AUTO_RAISES_MAX,
  AE_ROLE_EFFORTS,
  AE_ROLE_IDS,
  AE_ROLE_LABELS,
  type AeRaiseMode,
  type AeRoleEffort,
  type AeRoleId,
  type AeRolePreset,
  type AeRoleRules,
  type AeRoleSetting,
  type AeRoleTable,
  aeModelDotClass,
  aeModelLabel,
} from "@/lib/aeRoles";
import { comparableModelId } from "@/lib/codexNativeModels";
import { cn } from "@/lib/utils";
import { AeRolePresetTile, AeSegmented, AeStepper } from "./AeRolesControls";

export interface AeRoleModelChoice {
  /** The catalog id saved in the preset, e.g. `claude-opus-5-5`. */
  value: string;
  label: string;
}

export interface AeRoleDraft {
  roles: AeRoleTable;
  rules: AeRoleRules;
}

const AUTO = "__auto";
const SESSION = "__session";

const RAISE_OPTIONS: { value: AeRaiseMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "tell", label: "Tell me after" },
  { value: "ask", label: "Ask first" },
];

const ON_OFF = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const;

function EffortBar({
  role,
  effort,
  onChange,
  disabled,
}: {
  role: string;
  effort: AeRoleEffort;
  onChange: (effort: AeRoleEffort) => void;
  disabled: boolean;
}) {
  const level = AE_ROLE_EFFORTS.indexOf(effort);
  return (
    <div className="flex items-center gap-2">
      <div
        role="radiogroup"
        aria-label={`${role} effort`}
        className="flex gap-0.5"
        onKeyDown={(e) => {
          const step =
            e.key === "ArrowRight" || e.key === "ArrowUp"
              ? 1
              : e.key === "ArrowLeft" || e.key === "ArrowDown"
                ? -1
                : 0;
          if (!step) return;
          e.preventDefault();
          if (disabled) return;
          const next = Math.max(0, Math.min(AE_ROLE_EFFORTS.length - 1, level + step));
          onChange(AE_ROLE_EFFORTS[next]);
          e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
        }}
      >
        {AE_ROLE_EFFORTS.map((value, i) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={value === effort}
            disabled={disabled}
            aria-label={aeClaudeEffortLabel(value) ?? value}
            tabIndex={value === effort ? 0 : -1}
            onClick={() => onChange(value)}
            className={cn(
              "h-4 w-2 rounded-[2px] focus-visible:outline-2 focus-visible:outline-ring",
              i <= level ? "bg-teal-400" : "bg-muted-foreground/25 hover:bg-muted-foreground/40",
            )}
          />
        ))}
      </div>
      <span className="w-10 text-xs text-muted-foreground">{aeClaudeEffortLabel(effort)}</span>
    </div>
  );
}

function RoleRow({
  role,
  setting,
  models,
  onChange,
  disabled,
}: {
  role: AeRoleId;
  setting: AeRoleSetting;
  models: readonly AeRoleModelChoice[];
  onChange: (setting: AeRoleSetting) => void;
  disabled: boolean;
}) {
  const { label, hint } = AE_ROLE_LABELS[role];
  const fixed = setting.mode === "fixed" ? setting : null;
  const listed = fixed
    ? models.find((m) => comparableModelId(m.value) === comparableModelId(fixed.model))
    : undefined;
  const value = fixed
    ? (listed?.value ?? fixed.model)
    : setting.mode === "session"
      ? SESSION
      : AUTO;
  const choose = (next: string) => {
    if (next === AUTO) onChange({ mode: "auto" });
    else if (next === SESSION) onChange({ mode: "session" });
    else {
      const effort =
        fixed?.effort ?? ((aeClaudeCodeDefaultEffort(next) as AeRoleEffort | null) || "medium");
      onChange({ mode: "fixed", model: next, effort });
    }
  };
  return (
    <div
      data-testid={`ae-role-row-${role}`}
      className="grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-2 border-t border-border py-2.5 sm:grid-cols-[7rem_minmax(0,14rem)_1fr]"
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold">{label}</div>
        <div className="text-xs leading-tight text-muted-foreground">{hint}</div>
      </div>
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
          aria-label={`${label} model`}
          value={value}
          disabled={disabled}
          onChange={(e) => choose(e.target.value)}
          className={cn(
            "w-full min-w-0 rounded-md border border-input bg-background py-1.5 pr-2 text-sm text-foreground",
            fixed ? "pl-6" : "pl-2",
          )}
        >
          <option value={AUTO}>Auto (the lead picks)</option>
          {role === "lead" && <option value={SESSION}>Session model</option>}
          {fixed && !listed && <option value={fixed.model}>{aeModelLabel(fixed.model)}</option>}
          {models.map((model) => (
            <option key={model.value} value={model.value}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <div className="col-start-2 sm:col-start-3">
        {fixed ? (
          <EffortBar
            role={label}
            effort={fixed.effort}
            onChange={(effort) => onChange({ ...fixed, effort })}
            disabled={disabled}
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            {setting.mode === "session" ? "The session's model and effort" : "The lead chooses"}
          </span>
        )}
      </div>
    </div>
  );
}

function RuleRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
      <div className="min-w-0">
        <div className="text-sm">{title}</div>
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
  const setRole = (role: AeRoleId, setting: AeRoleSetting) =>
    onChange({ ...draft, roles: { ...draft.roles, [role]: setting } });
  const setRules = (rules: Partial<AeRoleRules>) =>
    onChange({ ...draft, rules: { ...draft.rules, ...rules } });
  return (
    <div data-testid="ae-roles-editor" className="flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <AeRolePresetTile icon={preset.icon} color={preset.color} size="lg" />
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{preset.title}</h2>
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

      <div role="group" aria-label="Roles">
        {AE_ROLE_IDS.map((role) => (
          <RoleRow
            key={role}
            role={role}
            setting={draft.roles[role]}
            models={models}
            onChange={(setting) => setRole(role, setting)}
            disabled={saving}
          />
        ))}
      </div>
      {catalogNote && <p className="pt-1 text-xs text-muted-foreground">{catalogNote}</p>}

      <div className="mt-3 border-t border-border pt-3">
        <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Model changes in this preset
        </h3>
        <RuleRow title="Raise a stuck child, or lower the lead" hint="Applies to both directions">
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
        <RuleRow title="Automatic raises per child" hint="After this, every raise asks you">
          <AeStepper
            label="Automatic raises per child"
            value={draft.rules.auto_raises}
            min={0}
            max={AE_AUTO_RAISES_MAX}
            onChange={(auto_raises) => setRules({ auto_raises })}
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
