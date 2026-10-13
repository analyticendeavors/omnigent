import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AeTeamControl } from "./AeTeamControl";
import { saveAeTeam } from "@/lib/aeTeam";
import type * as AeTeamModule from "@/lib/aeTeam";
import type { Session } from "@/lib/types";

vi.mock("@/lib/aeTeam", async (original) => ({
  ...(await original<typeof AeTeamModule>()),
  saveAeTeam: vi.fn(),
}));
vi.mock("@/shell/SwitchAgentDialog", () => ({
  SwitchAgentDialog: ({ open }: { open: boolean }) => (open ? <div>Choose a new lead</div> : null),
}));
vi.mock("@/hooks/useAvailableAgents", () => ({
  useAvailableAgents: () => ({
    data: [
      { id: "codex", name: "codex", display_name: "Codex", harness: "codex-native", skills: [] },
      {
        id: "claude",
        name: "claude",
        display_name: "Claude",
        harness: "claude-native",
        skills: [],
      },
      {
        id: "other",
        name: "other",
        display_name: "Other agent",
        harness: "unavailable",
        skills: [],
      },
    ],
  }),
}));
vi.mock("@/hooks/useHosts", () => ({
  useHosts: () => ({
    data: [
      {
        host_id: "host",
        status: "online",
        configured_harnesses: {
          "codex-native": true,
          "claude-native": true,
          unavailable: "needs-auth",
        },
      },
    ],
  }),
  useHostModelOptions: () => ({ data: [{ id: "test-model", displayName: "Available model" }] }),
}));

const session = { id: "parent", agentName: "Codex", hostId: "host", labels: {} } as Session;
function mount(props: Partial<Parameters<typeof AeTeamControl>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AeTeamControl session={session} {...props} />
    </QueryClientProvider>,
  );
}
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("composer team picker", () => {
  it("opens and cancels without creating or saving a team", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Collaboration: Solo" }));
    fireEvent.click(screen.getByRole("button", { name: /A lead with collaborators/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(saveAeTeam).not.toHaveBeenCalled();
  });

  it("saves both collaborators with their selected models", async () => {
    vi.mocked(saveAeTeam).mockResolvedValue(session);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Collaboration: Solo" }));
    fireEvent.click(screen.getByRole("button", { name: /A lead with collaborators/ }));
    expect(screen.getByRole("button", { name: "Save selection" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Codex" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Model for Codex" }), {
      target: { value: "test-model" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude" }));
    expect(screen.getByRole("checkbox", { name: /Other agent/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save selection" }));
    await waitFor(() =>
      expect(saveAeTeam).toHaveBeenCalledWith("parent", {
        version: 1,
        mode: "team",
        members: [
          expect.objectContaining({ agentId: "codex", model: "test-model" }),
          expect.objectContaining({ agentId: "claude", model: null }),
        ],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps failed saves visible and preserves the selection for retry", async () => {
    vi.mocked(saveAeTeam).mockRejectedValue(new Error("Host offline"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Collaboration: Solo" }));
    fireEvent.click(screen.getByRole("button", { name: /A lead with collaborators/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Save selection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Host offline");
    expect(screen.getByRole("checkbox", { name: "Claude" })).toBeChecked();
  });

  it("allows lead switching only when the turn has finished", () => {
    mount({ working: true });
    fireEvent.click(screen.getByRole("button", { name: "Collaboration: Solo" }));
    expect(screen.getByRole("button", { name: "Change lead" })).toBeDisabled();
  });

  it("opens the existing history-preserving lead switcher", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Collaboration: Solo" }));
    fireEvent.click(screen.getByRole("button", { name: "Change lead" }));
    expect(screen.getByText("Choose a new lead")).toBeInTheDocument();
  });
});
