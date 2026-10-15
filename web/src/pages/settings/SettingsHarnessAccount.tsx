import { useState } from "react";
import type { Host } from "@/hooks/useHosts";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import { useHarnessSetupSteps } from "@/lib/agentLabels";
import { harnessAuthableOnHost, harnessReadinessOnHost } from "@/lib/harnessSetup";
import { isFeatureEnabled } from "@/lib/capabilities";
import { HarnessCredentialForm } from "@/shell/HarnessCredentialForm";
import { HarnessSetupDialog } from "@/shell/HarnessSetupDialog";
import { ClaudeAccounts } from "@/shell/ClaudeAccounts";
import { Button } from "@/components/ui/button";
import { SettingsHarnessDefaults } from "./SettingsHarnessDefaults";

export function SettingsHarnessAccount({
  host,
  harness,
  label,
}: {
  host: Host;
  harness: string;
  label: string;
}) {
  const info = useServerInfo();
  const steps = useHarnessSetupSteps();
  const [setupOpen, setSetupOpen] = useState(false);
  const readiness = harnessReadinessOnHost(harness, host);
  const writable =
    info !== "loading" && isFeatureEnabled(info, "harness_install") && host.status === "online";
  const installed = !["binary-missing", "version-too-low", "unconfigured"].includes(
    readiness.reason,
  );
  const command = steps[harness]?.find((step) => step.kind === "auth")?.command ?? null;
  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-md border p-4">
        <h3 className="font-medium">
          {label} on {host.name}
        </h3>
        <p role="status" className="text-sm">
          {readiness.reason === "ready"
            ? "Ready"
            : (readiness.explanation?.label ?? "Readiness unknown")}
        </p>
        {host.status !== "online" && <p>Reconnect this host to manage its accounts.</p>}
        {info !== "loading" && !isFeatureEnabled(info, "harness_install") && (
          <p className="text-sm text-muted-foreground">
            Credential and installation controls are disabled by this server.
          </p>
        )}
        {writable && (
          <>
            {harness === "claude-native" && <ClaudeAccounts key={host.host_id} host={host} />}
            <Button variant="outline" onClick={() => setSetupOpen(true)}>
              Setup instructions
            </Button>
            {installed && harnessAuthableOnHost(info, harness, host) && (
              <HarnessCredentialForm
                key={`${host.host_id}:${harness}`}
                host={host}
                harness={harness}
                label={label}
                command={harness === "claude-native" ? null : command}
                onDone={() => undefined}
              />
            )}
            <HarnessSetupDialog
              key={`${host.host_id}:${harness}`}
              open={setupOpen}
              onOpenChange={setSetupOpen}
              host={host}
              harness={harness}
              agentName={label}
            />
          </>
        )}
      </div>
      <SettingsHarnessDefaults key={`${host.host_id}:${harness}`} host={host} harness={harness} />
    </div>
  );
}
