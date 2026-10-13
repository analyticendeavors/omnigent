import type { AvailableAgent } from "@/hooks/useAvailableAgents";
import type { Host } from "@/hooks/useHosts";
import { agentRootName } from "./forkHarness";
import { harnessReadinessOnHost, type HarnessReadiness } from "./harnessSetup";
import {
  nativeCodingAgentForAgentName,
  nativeCodingAgentForAvailableAgent,
  nativeCodingAgentForHarness,
  nativeCodingAgentForSession,
} from "./nativeCodingAgents";
import type { Session } from "./types";

export type AeTeamLead = Pick<Session, "agentId" | "agentName" | "harness" | "labels">;

/** Keep configured agent aliases even when discovery supplies a vendor display name. */
export function aeTeamAgentName(
  agent: Pick<AvailableAgent, "name" | "display_name" | "harness" | "builtin">,
) {
  const native = nativeCodingAgentForAvailableAgent(agent);
  if (!native) return agent.display_name || agent.name;
  const name = agentRootName(agent.name);
  const standardNames = [native.agentName, native.harness, native.key];
  if (
    agent.display_name === native.displayName &&
    (agent.builtin === false || !standardNames.includes(name))
  )
    return name;
  if (!agent.display_name || standardNames.includes(agent.display_name)) {
    return standardNames.includes(name) ? native.displayName : name;
  }
  return agent.display_name;
}

export function aeTeamLeadName(lead: AeTeamLead, agents: AvailableAgent[]) {
  const agent = agents.find((a) =>
    lead.agentId ? a.id === lead.agentId : a.name === lead.agentName,
  );
  if (agent) return aeTeamAgentName(agent);
  const name = lead.agentName ? agentRootName(lead.agentName) : null;
  return (
    nativeCodingAgentForAgentName(name)?.displayName ??
    name ??
    nativeCodingAgentForSession(lead)?.displayName ??
    "Current agent"
  );
}

/** Only verified readiness qualifies an agent as connected in the team picker. */
export function aeTeamReadiness(harness: string | null, host: Host | null): HarnessReadiness {
  const canonical = nativeCodingAgentForHarness(harness)?.harness;
  const resolvedHarness =
    harness &&
    host?.configured_harnesses?.[harness] === undefined &&
    canonical &&
    host?.configured_harnesses?.[canonical] !== undefined
      ? canonical
      : harness;
  const readiness = harnessReadinessOnHost(resolvedHarness, host);
  if (readiness.reason === "readiness-unknown") {
    return {
      ...readiness,
      state: "unavailable",
      selectable: false,
      explanation: {
        label: "Readiness unavailable",
        description:
          "This host has not reported whether this agent is ready. Wait for readiness to update before adding it to your team.",
      },
    };
  }
  if (readiness.reason === "needs-auth") {
    return { ...readiness, state: "setup-required", selectable: false };
  }
  return readiness;
}

export interface AeTeamOption {
  agent: AvailableAgent;
  name: string;
  readiness: HarnessReadiness;
  recommendation: string | null;
  primary: boolean;
}

// Multi-provider harnesses do not establish a different provider by themselves.
function codingProvider(harness: string | null | undefined): string | null {
  const key = nativeCodingAgentForHarness(harness)?.key;
  if (
    key === "claude" ||
    harness === "claude" ||
    harness === "claude-sdk" ||
    harness === "claude_sdk"
  )
    return "anthropic";
  if (key === "codex" || harness === "codex") return "openai";
  return null;
}

export function aeTeamOptions(
  agents: AvailableAgent[],
  host: Host | null,
  lead?: AeTeamLead,
): AeTeamOption[] {
  const options: AeTeamOption[] = agents.map((agent) => ({
    agent,
    name: aeTeamAgentName(agent),
    readiness: aeTeamReadiness(agent.harness, host),
    recommendation: null,
    primary: !!nativeCodingAgentForAvailableAgent(agent) || agent.builtin === false,
  }));
  const rank = (option: AeTeamOption) => {
    if (!option.readiness.selectable) return 3;
    if (nativeCodingAgentForAvailableAgent(option.agent)) return 0;
    return option.primary ? 1 : 2;
  };
  options.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const leadAgent = lead
    ? agents.find((a) => (lead.agentId ? a.id === lead.agentId : a.name === lead.agentName))
    : undefined;
  const leadProvider = codingProvider(
    nativeCodingAgentForSession(lead)?.harness ??
      lead?.harness ??
      leadAgent?.harness ??
      nativeCodingAgentForAgentName(lead?.agentName ? agentRootName(lead.agentName) : null)
        ?.harness,
  );
  const suggested = options.find((option) => {
    const provider = codingProvider(option.agent.harness);
    return (
      leadProvider &&
      provider &&
      provider !== leadProvider &&
      option.agent.id !== lead?.agentId &&
      nativeCodingAgentForAvailableAgent(option.agent) &&
      option.readiness.reason === "ready"
    );
  });
  if (suggested) {
    suggested.recommendation = "Recommended: different provider for independent review.";
    options.splice(options.indexOf(suggested), 1);
    options.unshift(suggested);
  }
  return options;
}
