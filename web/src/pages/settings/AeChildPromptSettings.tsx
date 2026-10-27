// Settings > General > Sessions: the two family settings (omnigent-ae, 2026-10-27). Both are
// saved with the user's roles on the server (`child_prompts` and `child_relay`, top level, not
// per preset), because the server mirrors the prompts and the relay tool checks the second.
// An unset value reads as on. Each row's one hint line is also the phone tooltip's text.

import { QueryClientContext } from "@tanstack/react-query";
import { useContext, useId, useState } from "react";
import { SettingsLabel } from "@/components/SettingsLabel";
import { Switch } from "@/components/ui/switch";
import { showToast } from "@/components/ui/toast";
import { useAeRoles, useAeRolesSave } from "@/hooks/useAeRoles";
import { aeRolesDoc } from "@/lib/aeRoles";
import { AE_SETTING_HINTS, type AeSettingHintId } from "@/lib/aeSettingHints";

type Field = "child_prompts" | "child_relay";

const ROWS: { field: Field; hint: AeSettingHintId; testId: string }[] = [
  { field: "child_prompts", hint: "family.child_prompts", testId: "ae-child-prompts" },
  { field: "child_relay", hint: "family.relay", testId: "ae-child-relay" },
];

const CONFLICT = "Your settings changed on another device, so they were reloaded.";

function Row({ field, hint, testId }: (typeof ROWS)[number]) {
  const roles = useAeRoles();
  const save = useAeRolesSave();
  const [saving, setSaving] = useState(false);
  const labelId = useId();
  const descriptionId = useId();
  const state = roles.data;
  const { label, hint: text } = AE_SETTING_HINTS[hint];
  const change = async (next: boolean) => {
    if (!state || saving) return;
    setSaving(true);
    try {
      const result = await save(aeRolesDoc({ ...state, [field]: next }));
      if (!result.ok) showToast(CONFLICT);
    } catch (error) {
      showToast(`Could not save: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex items-start justify-between gap-6" data-testid={testId}>
      <SettingsLabel
        label={label}
        labelId={labelId}
        descriptionId={descriptionId}
        className="flex-1"
        description={text}
        descriptionClassName="text-ui"
      />
      <Switch
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        checked={state?.[field] !== false}
        disabled={!state || saving}
        onCheckedChange={(next) => void change(next)}
        data-testid={`${testId}-toggle`}
        className="mt-0.5 shrink-0"
        componentId={`settings.general.${field}`}
      />
    </div>
  );
}

/** The two rows; nothing outside a query client (the settings page's tests render without one). */
export function AeChildPromptSettings() {
  if (!useContext(QueryClientContext)) return null;
  return (
    <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4">
      {ROWS.map((row) => (
        <Row key={row.field} {...row} />
      ))}
    </div>
  );
}
