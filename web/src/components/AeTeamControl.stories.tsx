import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AvailableAgent } from "@/hooks/useAvailableAgents";
import type { Host } from "@/hooks/useHosts";
import type { AeTeam } from "@/lib/aeTeam";
import { AeTeamEditor } from "./AeTeamControl";

const agents: AvailableAgent[] = [
  {
    id: "codex",
    name: "codex",
    display_name: "Codex",
    description: null,
    harness: "codex-native",
    skills: [],
  },
  {
    id: "claude",
    name: "claude",
    display_name: "Claude",
    description: null,
    harness: "claude-native",
    skills: [],
  },
  {
    id: "other",
    name: "other",
    display_name: "Another agent",
    description: null,
    harness: "other",
    skills: [],
  },
];
const host: Host = {
  host_id: "demo",
  name: "Workstation",
  owner: "demo",
  status: "online",
  configured_harnesses: { "codex-native": true, "claude-native": true, other: "needs-auth" },
};
function TeamDemo() {
  const [client] = useState(() => {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const agent of agents)
      query.setQueryData(
        ["host-model-options", "demo", agent.harness],
        [{ id: "example-model", displayName: "Available model", isDefault: true }],
      );
    return query;
  });
  const [draft, setDraft] = useState<AeTeam>({
    version: 1,
    mode: "team",
    members: agents
      .slice(0, 2)
      .map((a) => ({ agentId: a.id, agentName: a.name, displayName: a.display_name, model: null })),
  });
  return (
    <QueryClientProvider client={client}>
      <div className="w-full max-w-md space-y-4 rounded-xl border bg-popover p-4 text-popover-foreground shadow-md">
        <h2 className="text-lg font-semibold">Who works on this?</h2>
        <div className="rounded-xl bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">Lead / orchestrator</p>
          <p className="text-sm font-medium">Codex</p>
        </div>
        <AeTeamEditor draft={draft} onChange={setDraft} agents={agents} host={host} />
        <p className="text-xs text-muted-foreground">Applies to your next message.</p>
      </div>
    </QueryClientProvider>
  );
}
export default { title: "Components/AeTeamControl", component: TeamDemo } satisfies Meta<
  typeof TeamDemo
>;
type Story = StoryObj<typeof TeamDemo>;
export const MixedTeam: Story = {};
