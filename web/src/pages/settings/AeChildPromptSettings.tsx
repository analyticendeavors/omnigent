// Settings > General > Sessions: the two family settings (omnigent-ae, 2026-10-27). Both are
// saved with the user's roles on the server (`child_prompts` and `child_relay`, top level, not
// per preset), because the server mirrors the prompts and the relay tool checks the second.
// An unset value reads as on. Each row's one hint line is also the phone tooltip's text.
// The third row (2026-10-29) is "Suggest compacting at": the context size, in thousands of tokens,
// past which a top-level chat shows a Compact card (`lead_handoff_tokens`, 0 is off).

import { QueryClientContext } from "@tanstack/react-query";
import { useContext, useId, useState } from "react";
import { SettingsLabel } from "@/components/SettingsLabel";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { showToast } from "@/components/ui/toast";
import { useAeRoles, useAeRolesSave } from "@/hooks/useAeRoles";
import { AE_HANDOFF_DEFAULT_TOKENS, aeRolesDoc } from "@/lib/aeRoles";
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

const HANDOFF_MIN_K = 50;
const HANDOFF_MAX_K = 5000;

/** "Suggest compacting at": an on/off switch and the size in thousands of tokens. */
function HandoffRow() {
  const roles = useAeRoles();
  const save = useAeRolesSave();
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const labelId = useId();
  const descriptionId = useId();
  const state = roles.data;
  const { label, hint: text } = AE_SETTING_HINTS["family.handoff"];
  const tokens = state?.lead_handoff_tokens ?? AE_HANDOFF_DEFAULT_TOKENS;
  const on = tokens !== 0;
  const write = async (next: number | null) => {
    if (!state || saving) return;
    setSaving(true);
    try {
      const result = await save(aeRolesDoc({ ...state, lead_handoff_tokens: next }));
      if (!result.ok) showToast(CONFLICT);
    } catch (error) {
      showToast(`Could not save: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
      setDraft(null);
    }
  };
  const commit = () => {
    if (draft === null) return;
    const thousands = Math.round(Number(draft));
    if (!Number.isFinite(thousands) || thousands < HANDOFF_MIN_K || thousands > HANDOFF_MAX_K) {
      setDraft(null);
      return;
    }
    if (thousands * 1000 !== tokens) void write(thousands * 1000);
    else setDraft(null);
  };
  return (
    <div className="flex items-start justify-between gap-6" data-testid="ae-handoff">
      <SettingsLabel
        label={label}
        labelId={labelId}
        descriptionId={descriptionId}
        className="flex-1"
        description={text}
        descriptionClassName="text-ui"
      />
      <div className="mt-0.5 flex shrink-0 items-center gap-2">
        {on && (
          <Input
            type="number"
            inputMode="numeric"
            min={HANDOFF_MIN_K}
            max={HANDOFF_MAX_K}
            step={50}
            aria-label="Suggest compacting at, in thousands of tokens"
            aria-describedby={descriptionId}
            value={draft ?? String(tokens / 1000)}
            disabled={!state || saving}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
            }}
            data-testid="ae-handoff-tokens"
            className="h-6 w-16 px-1.5 py-0"
          />
        )}
        <Switch
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          checked={on}
          disabled={!state || saving}
          onCheckedChange={(next) => void write(next ? null : 0)}
          data-testid="ae-handoff-toggle"
          componentId="settings.general.lead_handoff_tokens"
        />
      </div>
    </div>
  );
}

/** The three rows; nothing outside a query client (the settings page's tests render without one). */
export function AeChildPromptSettings() {
  if (!useContext(QueryClientContext)) return null;
  return (
    <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4">
      {ROWS.map((row) => (
        <Row key={row.field} {...row} />
      ))}
      <HandoffRow />
    </div>
  );
}
