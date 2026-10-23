// "Who works on this?" dialog: the Roles preset row (omnigent-ae, 2026-10-23).
// Chips for "Lead picks" and each preset, a one-line summary of the chosen
// preset's roles, and Customize, which opens the five role rows for this
// session only. A customized table can be saved as a new preset. The dialog's
// Save writes the choice into the session's ae.team label.

import { WandSparklesIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { showToast } from "@/components/ui/toast";
import { useAeRoleModels } from "@/hooks/useAeRoleModels";
import { useAeRoles, useAeRolesSave } from "@/hooks/useAeRoles";
import {
  AE_PRESET_LIMIT,
  AE_PRESET_TITLE_MAX,
  AE_RESERVED_PRESET_ID,
  AE_ROLE_IDS,
  type AeRolePreset,
  type AeRoleTable,
  aeNormalizeOrder,
  aeOneLine,
  aePresetId,
  aeRoleSummary,
  aeSameRoles,
} from "@/lib/aeRoles";
import {
  type AeSessionRoles,
  aeChoiceId,
  aeResolveSessionPreset,
  aeRolesForPick,
} from "@/lib/aeSessionRoles";
import { cn } from "@/lib/utils";
import { AeRolePresetTile } from "@/pages/settings/AeRolesControls";
import { AeRoleRow } from "@/pages/settings/AeRolesEditor";

const chipClass = (on: boolean) =>
  cn(
    "inline-flex min-w-0 items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-xs disabled:opacity-50",
    on ? "border-primary bg-primary/10 font-medium" : "border-border hover:bg-muted",
  );

export function AeSessionPresetRow({
  value,
  onChange,
  disabled = false,
}: {
  value: AeSessionRoles | null;
  onChange: (roles: AeSessionRoles | null) => void;
  disabled?: boolean;
}) {
  const { data: state } = useAeRoles();
  const save = useAeRolesSave();
  const { models } = useAeRoleModels();
  const [customizing, setCustomizing] = useState(!!value?.custom);
  const [naming, setNaming] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!state) return null;
  const choice = aeResolveSessionPreset(value, state);
  const activeId = aeChoiceId(choice);
  const base =
    choice?.kind === "preset" ? state.presets.find((p) => p.id === choice.preset.id) : undefined;
  const shown = choice?.kind === "preset" ? choice.preset : undefined;
  const edited = choice?.kind === "preset" && choice.edited;

  const pick = (id: string) => {
    setNaming(null);
    if (id === AE_RESERVED_PRESET_ID) setCustomizing(false);
    onChange(aeRolesForPick(id, state.default_preset));
  };
  const setRoles = (roles: AeRoleTable) => {
    if (!base || !shown) return;
    const next = { roles, rules: shown.rules };
    onChange(
      aeSameRoles(next, base)
        ? aeRolesForPick(base.id, state.default_preset)
        : { preset: base.id, custom: next },
    );
  };
  const saveAsPreset = async (title: string) => {
    if (!shown || !base || saving) return;
    if (state.presets.length >= AE_PRESET_LIMIT) {
      showToast(`You have ${AE_PRESET_LIMIT} presets, the most there can be. Delete one first.`);
      return;
    }
    const id = aePresetId(
      title,
      state.presets.map((p) => p.id),
    );
    const created: AeRolePreset = {
      id,
      title,
      icon: base.icon,
      color: base.color,
      description: "",
      when_to_use: "",
      pinned: false,
      roles: { ...shown.roles },
      rules: { ...shown.rules },
    };
    setSaving(true);
    try {
      const result = await save(
        aeNormalizeOrder({ ...state, presets: [...state.presets, created] }),
      );
      if (!result.ok) {
        showToast("Your presets changed on another device and were reloaded. Try again.");
        return;
      }
      setNaming(null);
      setCustomizing(false);
      onChange(aeRolesForPick(id, result.saved.default_preset));
      showToast(`Created ${title}. Save the dialog to use it here.`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      showToast(`Could not save the preset: ${reason}. Nothing changed; try again.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="ae-session-preset-row" className="space-y-2 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Roles preset</p>
        <button
          type="button"
          aria-expanded={customizing}
          disabled={disabled || choice?.kind !== "preset"}
          onClick={() => setCustomizing((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          {customizing ? "Hide roles" : "Customize"}
        </button>
      </div>
      <div role="radiogroup" aria-label="Roles preset" className="flex flex-wrap gap-1.5">
        <button
          type="button"
          role="radio"
          aria-checked={activeId === AE_RESERVED_PRESET_ID}
          disabled={disabled}
          onClick={() => pick(AE_RESERVED_PRESET_ID)}
          className={chipClass(activeId === AE_RESERVED_PRESET_ID)}
        >
          <span className="inline-flex size-6 items-center justify-center text-teal-400">
            <WandSparklesIcon className="size-3.5" />
          </span>
          Lead picks
        </button>
        {state.presets.map((preset) => {
          const on = preset.id === activeId;
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => pick(preset.id)}
              className={chipClass(on)}
            >
              <AeRolePresetTile
                icon={preset.icon}
                color={preset.color}
                size="sm"
                dot={preset.id === state.default_preset}
              />
              <span className="truncate">
                {preset.title}
                {on && edited ? ", edited" : ""}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {shown
          ? aeRoleSummary(shown.roles)
          : "The lead chooses a preset per task and says which in one line."}
      </p>
      {customizing && shown && (
        <div role="group" aria-label="Roles for this session" className="border-t pt-1">
          {AE_ROLE_IDS.map((role) => (
            <AeRoleRow
              key={role}
              role={role}
              setting={shown.roles[role]}
              models={models}
              disabled={disabled || saving}
              onChange={(setting) => setRoles({ ...shown.roles, [role]: setting })}
            />
          ))}
          <p className="pt-1 text-xs text-muted-foreground">For this session only.</p>
        </div>
      )}
      {edited && shown && naming === null && (
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || saving}
          onClick={() =>
            setNaming(Array.from(`${shown.title} edited`).slice(0, AE_PRESET_TITLE_MAX).join(""))
          }
        >
          Save as preset
        </Button>
      )}
      {naming !== null && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const title = aeOneLine(naming);
            if (title) void saveAsPreset(title);
          }}
        >
          <input
            aria-label="New preset name"
            value={naming}
            maxLength={AE_PRESET_TITLE_MAX}
            onChange={(e) => setNaming(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
          <Button type="submit" size="sm" loading={saving} disabled={!aeOneLine(naming)}>
            Save
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setNaming(null)}>
            Cancel
          </Button>
        </form>
      )}
    </div>
  );
}
