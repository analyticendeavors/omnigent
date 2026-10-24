// The agents a reviewer slot can name (omnigent-ae, 2026-10-24): the same
// list and readiness the "Who works on this?" sessions list uses, checked
// against the given host, or in Settings the host the role models come from.

import { useMemo } from "react";
import { useAvailableAgents } from "@/hooks/useAvailableAgents";
import { type Host, useHosts } from "@/hooks/useHosts";
import { type AeTeamOption, aeTeamOptions } from "@/lib/aeTeamOptions";

export interface AeReviewerAgents {
  options: AeTeamOption[];
  host: Host | null;
  loaded: boolean;
}

/**
 * `pinnedAgentIds` are the agents the stored reviewers name: pinned like the lead and
 * members are, so a stored reviewer is never shown "Not found" because the list was deduped.
 */
export function useAeReviewerAgents(
  hostOverride?: Host | null,
  pinnedAgentIds?: string[],
): AeReviewerAgents {
  const agentsQuery = useAvailableAgents({ enabled: true, pinnedAgentIds });
  const hostsQuery = useHosts();
  const hosts = hostsQuery.data ?? [];
  const online = hosts.filter((h) => h.status === "online");
  const host =
    hostOverride !== undefined
      ? hostOverride
      : (online.find((h) => h.configured_harnesses?.["claude-native"] === true) ??
        online[0] ??
        null);
  const agents = agentsQuery.data;
  const options = useMemo(() => aeTeamOptions(agents ?? [], host), [agents, host]);
  return { options, host, loaded: agentsQuery.isSuccess === true && hostsQuery.isSuccess === true };
}
