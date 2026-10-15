import { useState } from "react";
import { useHostModelOptions, type Host } from "@/hooks/useHosts";
import { harnessUnconfiguredOnHost } from "@/lib/harnessSetup";
import { readHarnessOptions, writeHarnessOption, type HarnessOptions } from "@/lib/modePreferences";
import {
  CLAUDE_NATIVE_EFFORTS,
  PI_NATIVE_EFFORTS,
  nativeModelLabel,
} from "@/components/HarnessConfigControls";
import { CLAUDE_NATIVE_PERMISSION_MODES } from "@/lib/claudePermissionMode";
import { codexCreateApprovalOptions } from "@/lib/codexApprovalOptions";
import { codexEffortLevelsForModel } from "@/lib/codexNativeModels";
import {
  AGY_NATIVE_SKIP_MODES,
  CODEX_NATIVE_APPROVAL_MODES,
  CURSOR_NATIVE_EXEC_MODES,
  DEVIN_NATIVE_PERMISSION_MODES,
} from "@/lib/nativeHarnessModes";

const permissionOptions: Record<
  string,
  readonly { value: string; label: string; description?: string }[]
> = {
  "claude-native": CLAUDE_NATIVE_PERMISSION_MODES,
  "codex-native": codexCreateApprovalOptions(),
  "opencode-native": CODEX_NATIVE_APPROVAL_MODES,
  "cursor-native": CURSOR_NATIVE_EXEC_MODES,
  "antigravity-native": AGY_NATIVE_SKIP_MODES,
  "devin-native": DEVIN_NATIVE_PERMISSION_MODES,
};
const modelHarnesses = new Set(["claude-native", "codex-native", "pi-native", "devin-native"]);

/** Uses the same per-harness browser preferences as New Chat. */
export function SettingsHarnessDefaults({ harness, host }: { harness: string; host: Host }) {
  const [options, setOptions] = useState(() => readHarnessOptions(harness));
  const supportsModels = modelHarnesses.has(harness);
  const canQuery =
    supportsModels && host.status === "online" && !harnessUnconfiguredOnHost(harness, host);
  const {
    data: models = [],
    isLoading,
    isError,
    refetch,
  } = useHostModelOptions(host.host_id, harness, canQuery);
  const modes = permissionOptions[harness] ?? [];
  const efforts =
    harness === "claude-native"
      ? CLAUDE_NATIVE_EFFORTS
      : harness === "pi-native"
        ? PI_NATIVE_EFFORTS
        : codexEffortLevelsForModel(
            models,
            options.model || models.find((model) => model.isDefault)?.id,
          ).map((value) => ({ value, label: value }));
  const save = (patch: HarnessOptions) => {
    writeHarnessOption(harness, patch);
    setOptions(readHarnessOptions(harness));
  };
  if (!supportsModels && !modes.length) return null;
  return (
    <div className="space-y-3 rounded-md border p-4">
      <h3 className="font-medium">Browser defaults</h3>
      <p className="text-sm text-muted-foreground">
        Defaults for new chats in this browser, across all hosts. Project and chat overrides take
        priority. New Chat also remembers changes here. Credentials above belong to the selected
        host.
      </p>
      {supportsModels && (
        <>
          <DefaultSelect
            label="Default model"
            value={options.model ?? ""}
            options={models.map((model) => ({ value: model.id, label: nativeModelLabel(model) }))}
            onChange={(model) => save({ model, effort: "", routing: "off" })}
          />
          {canQuery && isLoading && <p role="status">Loading models…</p>}
          {canQuery && isError && (
            <p role="alert">
              Could not load models.{" "}
              <button type="button" className="underline" onClick={() => void refetch()}>
                Retry models
              </button>
            </p>
          )}
          {!canQuery && (
            <p className="text-sm text-muted-foreground">
              Connect and set up this harness to load its model catalog.
            </p>
          )}
          {canQuery && !isLoading && !isError && !models.length && (
            <p className="text-sm text-muted-foreground">This host returned no model choices.</p>
          )}
          <DefaultSelect
            label="Default effort"
            value={options.effort ?? ""}
            options={efforts}
            onChange={(effort) => save({ effort })}
          />
        </>
      )}
      {!!modes.length && (
        <>
          <DefaultSelect
            label="Default permissions"
            value={options.mode ?? ""}
            options={modes}
            onChange={(mode) => save({ mode })}
          />
          <p className="text-sm text-muted-foreground">
            {modes.find((mode) => mode.value === options.mode)?.description ??
              "Permission choices control when the agent asks before acting. Full access or bypass modes remove approval safeguards."}
          </p>
        </>
      )}
    </div>
  );
}

function DefaultSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-2 text-sm">
      {label}
      <select
        className="min-w-0 w-full rounded-md border bg-background p-2"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Harness default</option>
        {value && !options.some((option) => option.value === value) && (
          <option value={value} disabled>
            {value} (saved; unavailable on this host)
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
