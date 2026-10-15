import { useState } from "react";
import { useHosts } from "@/hooks/useHosts";
import { useHarnessLabels, isAutoHarness } from "@/lib/agentLabels";
import { NATIVE_CODING_AGENTS } from "@/lib/nativeCodingAgents";
import { SettingsHarnessAccount } from "./SettingsHarnessAccount";

/** Subscription credentials belong to the machine that runs the agent. */
export function SettingsAiAccountsSection() {
  const { data: hosts = [], isLoading, isError, refetch } = useHosts({ refetchOnFocus: true });
  const labels = useHarnessLabels();
  const [harness, setHarness] = useState("claude-native");
  const [hostId, setHostId] = useState("");
  const host = hostId
    ? hosts.find((item) => item.host_id === hostId)
    : (hosts.find((item) => item.status === "online") ?? hosts[0]);
  const harnesses = new Map(
    NATIVE_CODING_AGENTS.map((agent) => [agent.harness as string, agent.displayName as string]),
  );
  for (const id of Object.keys(labels)) {
    if (id in (host?.configured_harnesses ?? {}) && !isAutoHarness(id) && !harnesses.has(id))
      harnesses.set(id, labels[id] ?? id);
  }
  return (
    <section className="min-w-0 space-y-4" data-testid="settings-ai-accounts">
      <h2 className="text-lg font-semibold">AI accounts</h2>
      <p className="text-sm text-muted-foreground">
        Manage provider accounts, API keys, gateway connections, and defaults for new chats.
        Provider credentials are stored on the selected host and are separate from your Omnigent
        sign-in.
      </p>
      {isLoading && <p role="status">Loading hosts…</p>}
      {isError && (
        <p role="alert">
          Could not load hosts.{" "}
          <button type="button" className="underline" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      )}
      {!isLoading && !isError && !hosts.length && <p>Connect a host to manage its AI accounts.</p>}
      {!!hosts.length && (
        <label className="flex min-w-0 flex-col gap-2 text-sm">
          Host
          <select
            className="min-w-0 w-full rounded-md border bg-background p-2"
            value={hostId || host?.host_id || ""}
            onChange={(event) => setHostId(event.target.value)}
          >
            {hostId && !host && <option value={hostId}>Selected host (unavailable)</option>}
            {hosts.map((item) => (
              <option key={item.host_id} value={item.host_id}>
                {item.name}
                {item.status === "offline" ? " (offline)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {hostId && !host && (
        <p>The selected host is unavailable. Select another host to manage its accounts.</p>
      )}
      {host && (
        <>
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            Harness
            <select
              className="min-w-0 w-full rounded-md border bg-background p-2"
              value={harness}
              onChange={(event) => setHarness(event.target.value)}
            >
              {!harnesses.has(harness) && (
                <option value={harness}>{labels[harness] ?? harness}</option>
              )}
              {[...harnesses].map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <SettingsHarnessAccount
            key={`${host.host_id}:${harness}`}
            host={host}
            harness={harness}
            label={harnesses.get(harness) ?? harness}
          />
        </>
      )}
    </section>
  );
}
