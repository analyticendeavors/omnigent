import { useState } from "react";
import { useHosts } from "@/hooks/useHosts";
import { ClaudeAccounts } from "@/shell/ClaudeAccounts";

/** Subscription credentials belong to the machine that runs the agent. */
export function SettingsAiAccountsSection() {
  const { data: hosts = [], isLoading, isError, refetch } = useHosts({ refetchOnFocus: true });
  const [hostId, setHostId] = useState("");
  const host =
    hosts.find((item) => item.host_id === hostId) ??
    hosts.find((item) => item.status === "online") ??
    hosts[0];
  return (
    <section className="min-w-0 space-y-4" data-testid="settings-ai-accounts">
      <h2 className="text-lg font-semibold">AI accounts</h2>
      <p className="text-sm text-muted-foreground">
        Manage the Claude subscription used for new chats and team members on each host. These
        accounts are separate from your Omnigent sign-in. Model, effort, and team configuration stay
        with each chat; gateway connections use their own credentials.
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
            value={host?.host_id ?? ""}
            onChange={(event) => setHostId(event.target.value)}
          >
            {hosts.map((item) => (
              <option key={item.host_id} value={item.host_id}>
                {item.name}
                {item.status === "offline" ? " (offline)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {host?.status === "offline" ? (
        <p>Reconnect this host to manage its accounts.</p>
      ) : (
        host && <ClaudeAccounts key={host.host_id} host={host} />
      )}
    </section>
  );
}
