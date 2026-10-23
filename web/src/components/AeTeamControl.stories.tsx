import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AvailableAgent } from "@/hooks/useAvailableAgents";
import type { Host } from "@/hooks/useHosts";
import type { AeTeam } from "@/lib/aeTeam";
import { aeTeamLeadName, type AeTeamLead } from "@/lib/aeTeamOptions";
import { AeTeamEditor } from "./AeTeamControl";

const agents: AvailableAgent[] = [
  {
    id: "codex",
    name: "codex",
    display_name: "Codex",
    description: null,
    harness: "codex-native",
    skills: [],
    builtin: true,
  },
  {
    id: "claude",
    name: "claude",
    display_name: "Claude",
    description: null,
    harness: "claude-native",
    skills: [],
    builtin: true,
  },
  {
    id: "other",
    name: "other",
    display_name: "Another agent",
    description: null,
    harness: "other",
    skills: [],
    builtin: true,
  },
  {
    id: "orchestrator",
    name: "orchestrator",
    display_name: "Orchestrator",
    description: "A general planning agent.",
    harness: "claude-sdk",
    skills: [],
    builtin: true,
  },
];
const host: Host = {
  host_id: "demo",
  name: "Workstation",
  owner: "demo",
  status: "online",
  configured_harnesses: {
    "codex-native": true,
    "claude-native": true,
    "claude-sdk": true,
    other: "needs-auth",
  },
};
const lead: AeTeamLead = {
  agentId: "codex",
  agentName: "codex",
  harness: "codex-native",
  labels: {},
};
const memberFor = (agent: AvailableAgent) => ({
  agentId: agent.id,
  agentName: agent.name,
  displayName: agent.display_name,
  model: null,
});
const mixedTeam: AeTeam = { version: 1, mode: "team", members: agents.slice(0, 2).map(memberFor) };
const automatic: AeTeam = { version: 1, mode: "auto", members: [] };
const aliases: AvailableAgent[] = [
  ...agents,
  {
    ...agents[0],
    id: "work",
    name: "codex-work",
    description: "A configured agent for implementation.",
    builtin: false,
  },
  {
    ...agents[0],
    id: "review",
    name: "codex-review",
    description: "A configured agent for review.",
    builtin: false,
  },
  {
    ...agents[3],
    id: "custom",
    name: "product-reviewer",
    display_name: "Product reviewer",
    builtin: false,
  },
];
function TeamDemo({
  initialDraft = automatic,
  availableAgents = agents,
  selectedHost = host,
  selectedLead = lead,
}: {
  initialDraft?: AeTeam;
  availableAgents?: AvailableAgent[];
  selectedHost?: Host;
  selectedLead?: AeTeamLead;
}) {
  const [client] = useState(() => {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const agent of availableAgents)
      query.setQueryData(
        ["host-model-options", selectedHost.host_id, agent.harness],
        [{ id: "example-model", displayName: "Available model", isDefault: true }],
      );
    return query;
  });
  const [draft, setDraft] = useState(initialDraft);
  return (
    <QueryClientProvider client={client}>
      <div className="w-full max-w-md space-y-4 rounded-xl border bg-popover p-4 text-popover-foreground shadow-md">
        <h2 className="text-lg font-semibold">Who works on this?</h2>
        <div className="rounded-xl bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">Lead / orchestrator</p>
          <p className="break-words text-sm font-medium">
            {aeTeamLeadName(selectedLead, availableAgents)}
          </p>
        </div>
        <AeTeamEditor
          draft={draft}
          onChange={setDraft}
          agents={availableAgents}
          host={selectedHost}
          lead={selectedLead}
        />
        <p className="text-xs text-muted-foreground">Applies to your next message.</p>
      </div>
    </QueryClientProvider>
  );
}
export default { title: "Components/AeTeamControl", component: TeamDemo } satisfies Meta<
  typeof TeamDemo
>;
type Story = StoryObj<typeof TeamDemo>;
export const Auto: Story = {};
export const MixedTeam: Story = { args: { initialDraft: mixedTeam } };
export const CustomAgentAliases: Story = {
  args: {
    availableAgents: aliases,
    initialDraft: { version: 1, mode: "team", members: aliases.slice(4, 6).map(memberFor) },
    selectedLead: { ...lead, agentId: "work", agentName: "codex-work" },
  },
};
export const SelectedUnavailable: Story = {
  args: {
    initialDraft: {
      version: 1,
      mode: "team",
      members: [
        memberFor(agents[1]),
        memberFor(agents[2]),
        {
          agentId: "removed",
          agentName: "former-reviewer",
          displayName: "Former reviewer",
          model: null,
        },
      ],
    },
  },
};
export const ReadinessUnavailable: Story = {
  args: { initialDraft: mixedTeam, selectedHost: { ...host, configured_harnesses: {} } },
};
