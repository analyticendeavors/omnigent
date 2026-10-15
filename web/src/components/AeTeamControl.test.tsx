import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailableAgent } from "@/hooks/useAvailableAgents";
import type { Host } from "@/hooks/useHosts";
import { childSessionsQueryKey } from "@/hooks/useChildSessions";
import {
  AE_TEAM_LABEL,
  AE_TEAM_LIMIT,
  saveAeTeam,
  type AeTeam,
  type AeTeamMember,
} from "@/lib/aeTeam";
import type * as AeTeamModule from "@/lib/aeTeam";
import type { Session } from "@/lib/types";
import { AeTeamControl, AeTeamEditor, SessionTeamControl } from "./AeTeamControl";

const mocks = vi.hoisted(() => ({
  agents: vi.fn(),
  hosts: vi.fn(),
  models: vi.fn(),
  session: vi.fn(),
}));
vi.mock("@/hooks/useSession", () => ({ useSession: mocks.session }));
vi.mock("@/lib/aeTeam", async (original) => ({
  ...(await original<typeof AeTeamModule>()),
  saveAeTeam: vi.fn(),
}));
// Change lead opens AppShell's fork dialog; the control renders without AppShell here.
const forkDialog = vi.hoisted(() => ({ canFork: true, openForkDialog: vi.fn() }));
vi.mock("@/shell/ForkDialogContext", () => ({ useForkDialog: () => forkDialog }));
vi.mock("@/hooks/useAvailableAgents", () => ({ useAvailableAgents: mocks.agents }));
vi.mock("@/hooks/useHosts", () => ({ useHosts: mocks.hosts, useHostModelOptions: mocks.models }));

const codex: AvailableAgent = {
  id: "codex",
  name: "codex-native-ui",
  display_name: "Codex",
  harness: "codex-native",
  description: null,
  skills: [],
  builtin: true,
};
const claude: AvailableAgent = {
  ...codex,
  id: "claude",
  name: "claude-native-ui",
  display_name: "Claude Code",
  harness: "claude-native",
};
const unavailable: AvailableAgent = {
  ...codex,
  id: "other",
  name: "other",
  display_name: "Another agent",
  harness: "unavailable",
};
const generic: AvailableAgent = {
  ...codex,
  id: "orchestrator",
  name: "orchestrator",
  display_name: "Orchestrator",
  harness: "claude-sdk",
};
const custom: AvailableAgent = {
  ...generic,
  id: "reviewer",
  name: "product-reviewer",
  display_name: "Product reviewer",
  builtin: false,
};
const agents = [generic, unavailable, codex, claude, custom];
const host: Host = {
  host_id: "host",
  name: "Workstation",
  owner: "test",
  status: "online",
  configured_harnesses: {
    "codex-native": true,
    "claude-native": true,
    "claude-sdk": true,
    unavailable: "needs-auth",
  },
};
const session = {
  id: "parent",
  agentId: "codex",
  agentName: codex.name,
  harness: codex.harness,
  hostId: "host",
  labels: {},
} as Session;
const memberFor = (agent: AvailableAgent, overrides: Partial<AeTeamMember> = {}): AeTeamMember => ({
  agentId: agent.id,
  agentName: agent.name,
  displayName: agent.display_name,
  model: null,
  ...overrides,
});
const sessionWithTeam = (members: AeTeamMember[], overrides: Partial<AeTeam> = {}): Session => ({
  ...session,
  labels: { [AE_TEAM_LABEL]: JSON.stringify({ version: 1, mode: "team", members, ...overrides }) },
});
function mount(props: Partial<Parameters<typeof AeTeamControl>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (next = {}) => (
    <QueryClientProvider client={client}>
      <AeTeamControl session={session} {...props} {...next} />
    </QueryClientProvider>
  );
  const rendered = render(view());
  return {
    client,
    rerender: (next: Partial<Parameters<typeof AeTeamControl>[0]> = {}) =>
      rendered.rerender(view(next)),
  };
}
function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: /^(Collaboration:|Team:)/ }));
}
function chooseTeam() {
  openPicker();
  fireEvent.click(screen.getByRole("button", { name: "Team" }));
}
const saveButton = () => screen.getByRole("button", { name: "Save selection" });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.agents.mockReturnValue({ data: agents, isLoading: false, isError: false });
  mocks.hosts.mockReturnValue({ data: [host] });
  mocks.models.mockReturnValue({ data: [{ id: "test-model", displayName: "Available model" }] });
  vi.mocked(saveAeTeam).mockResolvedValue(session);
});
afterEach(cleanup);

describe("composer team picker", () => {
  it("keeps a loading entry point and lets failed metadata be retried", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    mocks.session.mockReturnValue({ session: null, isLoading: true, error: null });
    const view = () => (
      <QueryClientProvider client={client}>
        <SessionTeamControl sessionId="parent" />
      </QueryClientProvider>
    );
    const rendered = render(view());
    expect(screen.getByRole("button", { name: "Loading team configuration" })).toBeDisabled();
    mocks.session.mockReturnValue({ session: null, isLoading: false, error: new Error("Offline") });
    rendered.rerender(view());
    fireEvent.click(screen.getByRole("button", { name: "Retry team configuration" }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["session", "parent"] });
    mocks.session.mockReturnValue({ session, isLoading: false, error: null });
    rendered.rerender(view());
    openPicker();
    expect(screen.getByText("Lead / orchestrator")).toBeInTheDocument();
  });

  it("defaults to Auto and explains native helpers in every mode without saving", () => {
    mount();
    expect(screen.getByRole("button", { name: "Collaboration: Auto" })).toHaveTextContent("Auto");
    openPicker();
    expect(screen.getByRole("button", { name: "Auto Recommended" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText(/The lead chooses useful collaborators/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Solo" }));
    expect(screen.getByText(/The lead works with its native helpers/)).toBeInTheDocument();
    expect(
      screen.getByText("Native subagents remain available in every mode."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(saveAeTeam).not.toHaveBeenCalled();
  });

  it("retains a draft across modes and discards it on cancel", () => {
    mount();
    chooseTeam();
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Model for Claude Code" }), {
      target: { value: "test-model" },
    });
    for (const mode of ["Solo", "Auto Recommended"]) {
      fireEvent.click(screen.getByRole("button", { name: mode }));
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Team" }));
      expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeChecked();
      expect(screen.getByRole("combobox", { name: "Model for Claude Code" })).toHaveValue(
        "test-model",
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(saveAeTeam).not.toHaveBeenCalled();
    chooseTeam();
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).not.toBeChecked();
    expect(saveButton()).toBeDisabled();
  });

  it("shows native coding and custom agents first, with a different-provider recommendation", () => {
    mount();
    chooseTeam();
    expect(
      screen.getAllByRole("checkbox").map((input) => input.getAttribute("aria-label")),
    ).toEqual(["Claude Code", "Codex", "Product reviewer"]);
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).toHaveAccessibleDescription(
      "Recommended: different provider for independent review.",
    );
    expect(
      screen.getByText("Each collaborator uses its configured account and its own context."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/own account allowance|separate accounts/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Orchestrator" })).not.toBeInTheDocument();
    const disclosure = screen.getByRole("button", { name: /Other connected agents/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(screen.getByRole("checkbox", { name: "Orchestrator" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Orchestrator" }));
    fireEvent.click(screen.getByRole("button", { name: "Solo" }));
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    expect(screen.getByRole("checkbox", { name: "Orchestrator" })).toBeChecked();
  });

  it("keeps agents needing setup hidden until disclosed and then disabled", () => {
    mount();
    chooseTeam();
    expect(screen.queryByRole("checkbox", { name: "Another agent" })).not.toBeInTheDocument();
    const disclosure = screen.getByRole("button", { name: /Show agents needing setup/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(screen.getByRole("checkbox", { name: "Another agent" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Another agent" })).toHaveAccessibleDescription(
      /Authentication required/,
    );
    fireEvent.click(screen.getByRole("button", { name: /Hide agents needing setup/ }));
    expect(screen.queryByRole("checkbox", { name: "Another agent" })).not.toBeInTheDocument();
  });

  it("saves both collaborators and their models without reordering on model edits", async () => {
    const { client } = mount();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    chooseTeam();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Codex" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Model for Codex" }), {
      target: { value: "test-model" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(saveAeTeam).toHaveBeenCalledWith("parent", {
        version: 1,
        mode: "team",
        members: [memberFor(codex, { model: "test-model" }), memberFor(claude)],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.getQueryData(["session", "parent"])).toEqual(session);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: childSessionsQueryKey("parent") });
  });

  it.each(["Auto Recommended", "Solo"])(
    "saves %s without requiring ready collaborators",
    async (mode) => {
      mocks.agents.mockReturnValue({ data: [] });
      mocks.hosts.mockReturnValue({ data: [] });
      mount({ session: sessionWithTeam([memberFor(unavailable)], { routingBeforeTeam: "on" }) });
      openPicker();
      expect(saveButton()).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: mode }));
      expect(saveButton()).toBeEnabled();
      fireEvent.click(saveButton());
      await waitFor(() =>
        expect(saveAeTeam).toHaveBeenCalledWith(
          "parent",
          expect.objectContaining({
            mode: mode === "Solo" ? "solo" : "auto",
            routingBeforeTeam: "on",
          }),
        ),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    },
  );

  it("preserves custom aliases and independent model choices by agent id", async () => {
    const work = { ...codex, id: "work", name: "codex-work", builtin: false };
    const personal = { ...codex, id: "personal", name: "codex-personal", builtin: false };
    mocks.agents.mockReturnValue({ data: [codex, work, personal] });
    mount({ session: { ...session, agentId: work.id, agentName: work.name } });
    chooseTeam();
    fireEvent.click(screen.getByRole("checkbox", { name: "codex-work" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "codex-personal" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Model for codex-work" }), {
      target: { value: "test-model" },
    });
    expect(screen.getByRole("combobox", { name: "Model for codex-personal" })).toHaveValue("");
    expect(mocks.agents).toHaveBeenLastCalledWith({ enabled: true, pinnedAgentIds: ["work"] });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(saveAeTeam).toHaveBeenCalledWith("parent", {
        version: 1,
        mode: "team",
        members: [
          memberFor(work, { displayName: "codex-work", model: "test-model" }),
          memberFor(personal, { displayName: "codex-personal" }),
        ],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps selected setup-required and missing agents visible and removable", async () => {
    const missing = memberFor({
      ...codex,
      id: "deleted",
      name: "former-reviewer",
      display_name: "Former reviewer",
    });
    mount({ session: sessionWithTeam([memberFor(claude), memberFor(unavailable), missing]) });
    openPicker();
    expect(screen.getByRole("checkbox", { name: "Another agent" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Another agent" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Another agent" })).toHaveAccessibleDescription(
      /Remove this collaborator or wait until it is ready/,
    );
    expect(
      screen.queryByRole("combobox", { name: "Model for Another agent" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Former reviewer · Unavailable")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Another agent" }));
    expect(screen.queryByRole("checkbox", { name: "Another agent" })).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Former reviewer" }));
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(saveAeTeam).toHaveBeenCalledWith("parent", {
        version: 1,
        mode: "team",
        members: [memberFor(claude)],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps selected agents removable if the host goes offline", () => {
    const view = mount({ session: sessionWithTeam([memberFor(claude)]) });
    openPicker();
    expect(saveButton()).toBeEnabled();
    mocks.hosts.mockReturnValue({ data: [{ ...host, status: "offline" }] });
    view.rerender();
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeEnabled();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code" }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText("No collaborators are ready on this host yet.")).toBeInTheDocument();
  });

  it.each([undefined, {}])(
    "hides unverified choices with readiness map %j while allowing removal",
    (configured_harnesses) => {
      mocks.hosts.mockReturnValue({ data: [{ ...host, configured_harnesses }] });
      mount({ session: sessionWithTeam([memberFor(claude)]) });
      openPicker();
      expect(screen.getAllByRole("checkbox")).toHaveLength(1);
      expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeEnabled();
      expect(screen.getByRole("checkbox", { name: "Claude Code" })).toHaveAccessibleDescription(
        /Readiness unavailable/,
      );
      expect(
        screen.queryByRole("button", { name: /Other connected agents/ }),
      ).not.toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: /Show agents needing setup/ }));
      expect(screen.getByRole("checkbox", { name: "Codex" })).toBeDisabled();
      expect(screen.getByRole("checkbox", { name: "Codex" })).toHaveAccessibleDescription(
        /Readiness unavailable/,
      );
      fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code" }));
      expect(screen.getByRole("checkbox", { name: "Claude Code" })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeDisabled();
    },
  );

  it("preserves a saved model absent from the catalog and offers the default after a catalog failure", async () => {
    mocks.models.mockReturnValue({ data: [], isError: true });
    mount({ session: sessionWithTeam([memberFor(claude, { model: "previous-model" })]) });
    openPicker();
    const model = screen.getByRole("combobox", { name: "Model for Claude Code" });
    expect(model).toHaveValue("previous-model");
    expect(
      screen.getByText("Model list unavailable. The agent default is still available."),
    ).toBeInTheDocument();
    fireEvent.change(model, { target: { value: "" } });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(saveAeTeam).toHaveBeenCalledWith("parent", {
        version: 1,
        mode: "team",
        members: [memberFor(claude)],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps failed saves visible and retries with the same selection", async () => {
    vi.mocked(saveAeTeam).mockRejectedValueOnce(new Error("Host offline"));
    mount();
    chooseTeam();
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code" }));
    fireEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Host offline");
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeChecked();
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(vi.mocked(saveAeTeam).mock.calls[1]).toEqual(vi.mocked(saveAeTeam).mock.calls[0]);
  });

  it("prevents duplicate saves and editing while a save is pending", async () => {
    let resolveSave!: (updated: Session) => void;
    vi.mocked(saveAeTeam).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    mount();
    chooseTeam();
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code" }));
    fireEvent.click(saveButton());
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Solo" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change lead" })).toBeDisabled();
    fireEvent.click(saveButton());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(saveAeTeam).toHaveBeenCalledTimes(1);
    await act(async () => resolveSave(session));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("allows saving and lead switching only when the current turn has finished", () => {
    const view = mount({ working: true });
    openPicker();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change lead" })).toBeDisabled();
    expect(screen.getByText(/after this turn finishes/)).toBeInTheDocument();
    view.rerender({ working: false });
    expect(saveButton()).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Change lead" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(forkDialog.openForkDialog).toHaveBeenCalledWith({ sourceSessionId: "parent" });
  });

  it("disables a read-only picker", () => {
    mount({ disabled: true });
    expect(screen.getByRole("button", { name: "Collaboration: Auto" })).toBeDisabled();
    openPicker();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reports agent loading failures and keeps an empty Team unsavable", () => {
    mocks.agents.mockReturnValue({ data: [], isError: true });
    mount();
    chooseTeam();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load available agents.");
    expect(saveButton()).toBeDisabled();
  });
});

describe("team editor", () => {
  it("enforces the member limit while still allowing removal and model changes", () => {
    const choices = Array.from({ length: AE_TEAM_LIMIT + 1 }, (_, index) => ({
      ...custom,
      id: `custom-${index}`,
      name: `Custom ${index}`,
      display_name: `Custom ${index}`,
    }));
    function Editor() {
      const [draft, setDraft] = useState<AeTeam>({
        version: 1,
        mode: "team",
        members: choices.slice(0, AE_TEAM_LIMIT).map((agent) => memberFor(agent)),
      });
      return <AeTeamEditor draft={draft} onChange={setDraft} agents={choices} host={host} />;
    }
    render(<Editor />);
    expect(screen.getByText(`${AE_TEAM_LIMIT}/${AE_TEAM_LIMIT}`)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: `Custom ${AE_TEAM_LIMIT}` })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Model for Custom 0" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Custom 0" }));
    expect(screen.getByRole("checkbox", { name: `Custom ${AE_TEAM_LIMIT}` })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: `Custom ${AE_TEAM_LIMIT}` }));
    expect(screen.getByRole("checkbox", { name: "Custom 0" })).toBeDisabled();
  });
});
