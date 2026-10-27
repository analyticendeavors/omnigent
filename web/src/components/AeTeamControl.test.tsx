import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  mobile: vi.fn(() => false),
  agents: vi.fn(),
  hosts: vi.fn(),
  models: vi.fn(),
  session: vi.fn(),
  roles: vi.fn(),
  saveRoles: vi.fn(),
  getSessionSlim: vi.fn(),
  updateSession: vi.fn(),
  switchLead: vi.fn(),
}));
vi.mock("@/lib/aeLeadModelChat", async (original) => ({
  ...(await original<object>()),
  aeSwitchPresetLead: mocks.switchLead,
}));
vi.mock("@/hooks/useAeRoles", () => ({
  AE_ROLES_QUERY_KEY: ["ae", "roles"],
  useAeRoles: mocks.roles,
  useAeRolesSave: () => mocks.saveRoles,
}));
vi.mock("@/lib/sessionsApi", async (original) => ({
  ...(await original<object>()),
  getSessionSlim: mocks.getSessionSlim,
  updateSession: mocks.updateSession,
}));
vi.mock("@/hooks/useSession", () => ({ useSession: mocks.session }));
vi.mock("@/lib/aeTeam", async (original) => ({
  ...(await original<typeof AeTeamModule>()),
  saveAeTeam: vi.fn(),
}));
// Change lead opens AppShell's fork dialog; the control renders without AppShell here.
const forkDialog = vi.hoisted(() => ({ canFork: true, openForkDialog: vi.fn() }));
vi.mock("@/shell/ForkDialogContext", () => ({ useForkDialog: () => forkDialog }));
vi.mock("@/hooks/useIsMobileViewport", () => ({ useIsMobileViewport: () => mocks.mobile() }));
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
type ControlProps = Omit<Parameters<typeof AeTeamControl>[0], "open" | "onOpenChange">;
// The dialog has no trigger of its own (the composer pill opens it); this stands in for the pill.
function Harness(props: Partial<ControlProps>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open picker
      </button>
      <AeTeamControl session={session} {...props} open={open} onOpenChange={setOpen} />
    </>
  );
}
function mount(props: Partial<ControlProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (next = {}) => (
    <QueryClientProvider client={client}>
      <Harness {...props} {...next} />
    </QueryClientProvider>
  );
  const rendered = render(view());
  return {
    client,
    rerender: (next: Partial<ControlProps> = {}) => rendered.rerender(view(next)),
  };
}
function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: "Open picker" }));
}
const preset = (id: string, title: string, helpers?: "any" | "own") => ({
  id,
  title,
  icon: "scale",
  color: "teal" as const,
  description: `${title} card`,
  when_to_use: "",
  pinned: false,
  roles: {
    lead: { mode: "session" as const },
    planner: { mode: "fixed" as const, model: "test-model", effort: "high" as const },
    reviewer: { mode: "auto" as const },
    builder: { mode: "auto" as const },
    helper: { mode: "auto" as const },
  },
  rules: {
    raise_or_lower: "tell" as const,
    lead_steps_down: true,
    auto_raises: 1,
    ...(helpers ? { helpers } : {}),
  },
});
const ROLES = {
  revision: 3,
  default_preset: "balanced",
  apply_start_on: true,
  presets: [
    preset("save-tokens", "Save tokens"),
    preset("balanced", "Balanced"),
    preset("yolo", "YOLO"),
  ],
  starters: [],
};
const saveButton = () => screen.getByRole("button", { name: "Save selection" });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mobile.mockReturnValue(false);
  mocks.agents.mockReturnValue({ data: agents, isLoading: false, isError: false });
  mocks.hosts.mockReturnValue({ data: [host] });
  mocks.models.mockReturnValue({ data: [{ id: "test-model", displayName: "Available model" }] });
  vi.mocked(saveAeTeam).mockResolvedValue(session);
  mocks.roles.mockReturnValue({ data: undefined });
  mocks.switchLead.mockResolvedValue({ kind: "none" });
});
afterEach(cleanup);

/** The model picker's trigger for a role row. */
const modelTrigger = (role: string) =>
  screen.getByRole("button", { name: new RegExp(`^${role} model`) });
/** Opens a role row's picker and picks the option with this name. */
const pickModel = (role: string, name: string) => {
  fireEvent.click(modelTrigger(role));
  fireEvent.click(within(screen.getByRole("tree")).getByRole("treeitem", { name }));
};

describe("composer team picker", () => {
  it("keeps a loading entry point and lets failed metadata be retried", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    mocks.session.mockReturnValue({ session: null, isLoading: true, error: null });
    mocks.roles.mockReturnValue({ data: ROLES });
    const view = () => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SessionTeamControl sessionId="parent" />
        </MemoryRouter>
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
    // No team button any more: the preset pill's menu opens the dialog.
    expect(screen.queryByRole("button", { name: /^(Collaboration:|Team:)/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Roles preset: Balanced" }));
    fireEvent.click(screen.getByRole("button", { name: /Who works on this\?/ }));
    expect(screen.getByText("Lead / orchestrator")).toBeInTheDocument();
  });

  it("shows the sessions list without mode tiles and saves nothing on opening", () => {
    mount();
    openPicker();
    expect(screen.queryByRole("button", { name: "Auto Recommended" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Solo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Team" })).not.toBeInTheDocument();
    expect(screen.getByText("Add sessions")).toBeInTheDocument();
    expect(screen.getByText(`0 of ${AE_TEAM_LIMIT}`)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).not.toBeChecked();
    expect(saveButton()).toBeEnabled();
    expect(saveAeTeam).not.toHaveBeenCalled();
  });

  it("discards a draft on cancel", () => {
    mount();
    openPicker();
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Model for Claude Code" }), {
      target: { value: "test-model" },
    });
    expect(screen.getByText(`1 of ${AE_TEAM_LIMIT}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(saveAeTeam).not.toHaveBeenCalled();
    openPicker();
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).not.toBeChecked();
  });

  it("shows native coding and custom agents first, with a different-provider recommendation", () => {
    mount();
    openPicker();
    expect(
      screen.getAllByRole("checkbox").map((input) => input.getAttribute("aria-label")),
    ).toEqual(["Claude Code", "Codex", "Product reviewer"]);
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).toHaveAccessibleDescription(
      "Recommended: different provider for independent review.",
    );
    expect(
      screen.getByText(
        "The lead hands work to these first. They keep their own context and account.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/own account allowance|separate accounts/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Orchestrator" })).not.toBeInTheDocument();
    const disclosure = screen.getByRole("button", { name: /Other connected agents/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(screen.getByRole("checkbox", { name: "Orchestrator" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Orchestrator" }));
    expect(screen.getByRole("checkbox", { name: "Orchestrator" })).toBeChecked();
  });

  it("keeps agents needing setup hidden until disclosed and then disabled", () => {
    mount();
    openPicker();
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
    openPicker();
    fireEvent.click(screen.getByRole("checkbox", { name: "Codex" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Model for Codex" }), {
      target: { value: "test-model" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(saveAeTeam).toHaveBeenCalledWith("parent", {
        version: 1,
        mode: expect.any(String),
        members: [memberFor(codex, { model: "test-model" }), memberFor(claude)],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.getQueryData(["session", "parent"])).toEqual(session);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: childSessionsQueryKey("parent") });
  });

  it("preserves custom aliases and independent model choices by agent id", async () => {
    const work = { ...codex, id: "work", name: "codex-work", builtin: false };
    const personal = { ...codex, id: "personal", name: "codex-personal", builtin: false };
    mocks.agents.mockReturnValue({ data: [codex, work, personal] });
    mount({ session: { ...session, agentId: work.id, agentName: work.name } });
    openPicker();
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
        mode: expect.any(String),
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
        mode: expect.any(String),
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
        mode: expect.any(String),
        members: [memberFor(claude)],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps failed saves visible and retries with the same selection", async () => {
    vi.mocked(saveAeTeam).mockRejectedValueOnce(new Error("Host offline"));
    mount();
    openPicker();
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
    openPicker();
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code" }));
    fireEvent.click(saveButton());
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change lead" })).toBeDisabled();
    fireEvent.click(saveButton());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(saveAeTeam).toHaveBeenCalledTimes(1));
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
    openPicker();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change lead" })).toBeDisabled();
  });

  it("reports agent loading failures and still saves a chat with no sessions", () => {
    mocks.agents.mockReturnValue({ data: [], isError: true });
    mount();
    openPicker();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load available agents.");
    expect(saveButton()).toBeEnabled();
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
    expect(screen.getByText(`${AE_TEAM_LIMIT} of ${AE_TEAM_LIMIT}`)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: `Custom ${AE_TEAM_LIMIT}` })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Model for Custom 0" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Custom 0" }));
    expect(screen.getByRole("checkbox", { name: `Custom ${AE_TEAM_LIMIT}` })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: `Custom ${AE_TEAM_LIMIT}` }));
    expect(screen.getByRole("checkbox", { name: "Custom 0" })).toBeDisabled();
  });
});

describe("roles preset per session", () => {
  beforeEach(() => {
    mocks.roles.mockReturnValue({ data: ROLES });
  });

  it("pins the reviewer agents a preset names and finds one by its registered name", () => {
    // Stored under an id this install does not have; the live Codex row has another id.
    const reviewerSlot = {
      mode: "agent" as const,
      agent: "seeded-elsewhere",
      agent_name: codex.name,
      name: "Codex",
      model: null,
      effort: null,
    };
    const withReviewers = {
      ...preset("balanced", "Balanced"),
      roles: {
        ...preset("balanced", "Balanced").roles,
        reviewer: {
          mode: "multi" as const,
          reviewers: [
            { mode: "fixed" as const, model: "test-model", effort: "medium" as const },
            reviewerSlot,
          ],
        },
      },
    };
    mocks.roles.mockReturnValue({
      data: { ...ROLES, presets: [withReviewers, ROLES.presets[0], ROLES.presets[2]] },
    });
    mount();
    openPicker();
    const last = mocks.agents.mock.calls.at(-1)?.[0] as { pinnedAgentIds: string[] };
    expect(last.pinnedAgentIds).toContain("seeded-elsewhere");
    expect(screen.queryByTestId("ae-reviewer-tag-2")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Already Reviewer 2 in this preset. A review always starts a fresh session, never this one.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Add it here only/)).not.toBeInTheDocument();
  });

  it("saves the chosen preset into the label and writes nothing for the default", async () => {
    mount();
    openPicker();
    fireEvent.click(screen.getByRole("radio", { name: "YOLO" }));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(saveAeTeam).toHaveBeenCalledWith(
        "parent",
        expect.objectContaining({ roles: { preset: "yolo" } }),
      ),
    );
    vi.mocked(saveAeTeam).mockClear();
    openPicker();
    fireEvent.click(screen.getByRole("radio", { name: "Balanced" }));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(saveAeTeam).toHaveBeenCalledWith("parent", expect.objectContaining({ roles: null })),
    );
  });

  it("leaves the label's roles alone unless the dialog changed the roles row", async () => {
    const withRoles = {
      ...session,
      labels: {
        [AE_TEAM_LABEL]: JSON.stringify({
          version: 1,
          mode: "auto",
          members: [],
          roles: { preset: "yolo" },
        }),
      },
    };
    mount({ session: withRoles });
    openPicker();
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code" }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveAeTeam).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveAeTeam).mock.calls[0][1]).toMatchObject({
      members: [memberFor(claude)],
    });
    expect(vi.mocked(saveAeTeam).mock.calls[0][1]).not.toHaveProperty("roles");
  });

  it("switches the lead model only when the dialog picks a different preset", async () => {
    const onYolo = {
      ...session,
      labels: {
        [AE_TEAM_LABEL]: JSON.stringify({
          version: 1,
          mode: "auto",
          members: [],
          roles: { preset: "yolo" },
        }),
      },
    };
    mount({ session: onYolo });
    openPicker();
    // A non-lead row edit on the same preset: the roles are saved, the model is left alone.
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    pickModel("Planner", "Auto (the lead picks)");
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveAeTeam).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mocks.switchLead).not.toHaveBeenCalled();
    openPicker();
    fireEvent.click(screen.getByRole("radio", { name: "Save tokens" }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.switchLead).toHaveBeenCalledTimes(1));
    expect(mocks.switchLead.mock.calls[0][3]).toMatchObject({ id: "save-tokens" });
  });

  it("runs the dialog's label save and lead switch as one step before a later pick", async () => {
    const { aeLatestWins } = await import("@/lib/aeSessionRoles");
    const order: string[] = [];
    let finishSwitch!: () => void;
    vi.mocked(saveAeTeam).mockImplementation(async () => {
      order.push("save");
      return session;
    });
    mocks.switchLead.mockImplementation(
      () =>
        new Promise((resolve) => {
          order.push("switch");
          finishSwitch = () => resolve({ kind: "none" });
        }),
    );
    mount();
    openPicker();
    fireEvent.click(screen.getByRole("radio", { name: "Save tokens" }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(order).toEqual(["save", "switch"]));
    // A newer pick arriving while the switch runs waits for it; it is never run between
    // the save and the switch, so the older model cannot land on top of it.
    const newer = aeLatestWins("parent", async () => order.push("newer"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(order).toEqual(["save", "switch"]);
    await act(async () => {
      finishSwitch();
      await newer;
    });
    expect(order).toEqual(["save", "switch", "newer"]);
  });

  it("customizes roles for this session and saves them as a new preset", async () => {
    mocks.saveRoles.mockImplementation(async (doc: typeof ROLES) => ({
      ok: true,
      saved: { ...doc, revision: 4, starters: [] },
    }));
    mount();
    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    pickModel("Planner", "Auto (the lead picks)");
    expect(screen.getByRole("radio", { name: "Balanced, edited" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save as preset" }));
    expect(screen.getByLabelText("New preset name")).toHaveValue("Balanced edited");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.saveRoles).toHaveBeenCalled());
    const doc = mocks.saveRoles.mock.calls[0][0] as typeof ROLES;
    expect(doc.revision).toBe(3);
    expect(doc.presets.at(-1)).toMatchObject({
      id: "balanced-edited",
      title: "Balanced edited",
      roles: { planner: { mode: "auto" } },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(saveAeTeam).toHaveBeenCalledWith(
        "parent",
        expect.objectContaining({ roles: { preset: "balanced-edited" } }),
      ),
    );
  });

  it("switches from the composer pill and with Alt+digit in its composer only", async () => {
    mocks.session.mockReturnValue({ session, isLoading: false, error: null });
    mocks.getSessionSlim.mockResolvedValue(session);
    mocks.updateSession.mockResolvedValue(session);
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <div data-composer-card>
            <textarea aria-label="Message" />
            <SessionTeamControl sessionId="parent" />
          </div>
          <textarea aria-label="Elsewhere" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Roles preset: Balanced" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /YOLO/ }));
    await waitFor(() => expect(mocks.updateSession).toHaveBeenCalledTimes(1));
    const label = () => JSON.parse(mocks.updateSession.mock.calls.at(-1)![1].labels[AE_TEAM_LABEL]);
    expect(label()).toEqual({ version: 1, mode: "auto", members: [], roles: { preset: "yolo" } });

    fireEvent.keyDown(screen.getByLabelText("Elsewhere"), { code: "Digit1", altKey: true });
    fireEvent.keyDown(screen.getByLabelText("Message"), {
      code: "Digit1",
      ctrlKey: true,
      altKey: true,
    });
    expect(mocks.updateSession).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText("Message"), { code: "Digit1", altKey: true });
    await waitFor(() => expect(mocks.updateSession).toHaveBeenCalledTimes(2));
    expect(label().roles).toEqual({ preset: "save-tokens" });
    // No preset at position 9: the key is left alone.
    const event = new KeyboardEvent("keydown", {
      code: "Digit9",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    screen.getByLabelText("Message").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  it("greys the sessions list on a preset that keeps work in house and saves no sessions", async () => {
    mocks.roles.mockReturnValue({
      data: { ...ROLES, presets: [...ROLES.presets, preset("solo", "Solo", "own")] },
    });
    const solo = sessionWithTeam([memberFor(claude)], { roles: { preset: "solo" } });
    mount({ session: solo });
    openPicker();
    expect(
      screen.getByText("Solo uses own subagents only. Pick another preset to add sessions."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("ae-team-sessions")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeDisabled();
    expect(saveButton()).toBeEnabled();
    // Nothing changed: no child session, no routing change, no label write.
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(saveAeTeam).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it("saves only the roles from a kept-in-house preset and keeps the stored sessions", async () => {
    mocks.roles.mockReturnValue({
      data: { ...ROLES, presets: [...ROLES.presets, preset("solo", "Solo", "own")] },
    });
    const stored = sessionWithTeam([memberFor(claude, { sessionId: "kid" })]);
    mocks.getSessionSlim.mockResolvedValue(stored);
    mocks.updateSession.mockResolvedValue(stored);
    mount({ session: stored });
    openPicker();
    fireEvent.click(screen.getByRole("radio", { name: "Solo" }));
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeDisabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateSession).toHaveBeenCalledTimes(1));
    expect(saveAeTeam).not.toHaveBeenCalled();
    const patch = mocks.updateSession.mock.calls[0][1];
    expect(patch).not.toHaveProperty("subagentRoutingOverride");
    expect(JSON.parse(patch.labels[AE_TEAM_LABEL])).toMatchObject({
      mode: "team",
      members: [memberFor(claude, { sessionId: "kid" })],
      roles: { preset: "solo" },
    });
  });

  it("queues the dialog's save behind a menu change still saving", async () => {
    const { aeLatestWins } = await import("@/lib/aeSessionRoles");
    let finishMenuWrite!: () => void;
    const menuWrite = aeLatestWins(
      "parent",
      () =>
        new Promise<string>((resolve) => {
          finishMenuWrite = () => resolve("done");
        }),
      { queue: true },
    );
    mount();
    openPicker();
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code" }));
    fireEvent.click(saveButton());
    await act(async () => {
      await Promise.resolve();
    });
    expect(saveAeTeam).not.toHaveBeenCalled();
    await act(async () => {
      finishMenuWrite();
      await menuWrite;
    });
    await waitFor(() => expect(saveAeTeam).toHaveBeenCalledTimes(1));
  });

  it("keeps a chat saved as Solo with Lead picks greyed, and saves nothing until the row changes", async () => {
    const legacy = {
      ...session,
      labels: {
        [AE_TEAM_LABEL]: JSON.stringify({
          version: 1,
          mode: "solo",
          members: [],
          roles: { preset: "lead-picks" },
        }),
      },
    };
    mount({ session: legacy });
    openPicker();
    expect(screen.getByTestId("ae-team-sessions")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "YOLO" }));
    expect(screen.getByTestId("ae-team-sessions")).not.toHaveAttribute("aria-disabled");
  });

  it("does not write a frozen copy of the default for a Solo label when the dialog just opens", async () => {
    const legacy = {
      ...session,
      labels: { [AE_TEAM_LABEL]: JSON.stringify({ version: 1, mode: "solo", members: [] }) },
    };
    mount({ session: legacy });
    openPicker();
    expect(screen.getByTestId("ae-team-sessions")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(saveAeTeam).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it("reads a chat saved as Solo as the Solo preset and writes the new shape on Save", async () => {
    const actual = await vi.importActual<typeof AeTeamModule>("@/lib/aeTeam");
    vi.mocked(saveAeTeam).mockImplementation(actual.saveAeTeam);
    mocks.roles.mockReturnValue({
      data: { ...ROLES, presets: [...ROLES.presets, preset("solo", "Solo", "own")] },
    });
    const legacy = {
      ...session,
      labels: { [AE_TEAM_LABEL]: JSON.stringify({ version: 1, mode: "solo", members: [] }) },
    };
    mocks.getSessionSlim.mockResolvedValue(legacy);
    mocks.updateSession.mockResolvedValue(session);
    mount({ session: legacy });
    openPicker();
    expect(screen.getByRole("radio", { name: "Solo" })).toBeChecked();
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateSession).toHaveBeenCalledTimes(1));
    const label = JSON.parse(mocks.updateSession.mock.calls[0][1].labels[AE_TEAM_LABEL]);
    expect(label).toMatchObject({
      version: 1,
      mode: "auto",
      members: [],
      roles: { preset: "solo" },
    });
  });
});

describe("composer preset pill states", () => {
  function renderPill(props: { working?: boolean } = {}, current: Session = session) {
    mocks.session.mockReturnValue({ session: current, isLoading: false, error: null });
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SessionTeamControl sessionId="parent" {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("keeps a pill-shaped way into the dialog when presets fail to load, and retries them", () => {
    const refetch = vi.fn();
    mocks.roles.mockReturnValue({ data: undefined, isError: true, refetch });
    renderPill();
    const fallback = screen.getByTestId("ae-preset-pill-fallback");
    expect(fallback).toHaveAccessibleName("Retry roles presets");
    fireEvent.click(fallback);
    expect(refetch).toHaveBeenCalledTimes(1);
    // Change lead and the sessions list stay reachable.
    expect(screen.getByRole("button", { name: "Change lead" })).toBeInTheDocument();
    expect(screen.getByText("Add sessions")).toBeInTheDocument();
  });

  it("shows the same fallback while presets load, without a retry", () => {
    const refetch = vi.fn();
    mocks.roles.mockReturnValue({ data: undefined, isLoading: true, refetch });
    renderPill();
    fireEvent.click(screen.getByTestId("ae-preset-pill-fallback"));
    expect(refetch).not.toHaveBeenCalled();
    expect(screen.getByText("Lead / orchestrator")).toBeInTheDocument();
  });

  it("opens the phone sheet on the list, not in the search box", async () => {
    mocks.mobile.mockReturnValue(true);
    mocks.roles.mockReturnValue({ data: ROLES });
    renderPill();
    fireEvent.click(screen.getByRole("button", { name: /Roles preset: / }));
    const menu = await screen.findByTestId("ae-preset-menu");
    const search = screen.getByRole("searchbox", { name: "Search presets" });
    await waitFor(() => expect(menu).toContainElement(document.activeElement as HTMLElement));
    expect(document.activeElement).toBe(menu);
    expect(document.activeElement).not.toBe(search);
    // A tap on the box still focuses it.
    search.focus();
    expect(document.activeElement).toBe(search);
  });

  it("leaves the desktop menu's focus behaviour alone", async () => {
    mocks.roles.mockReturnValue({ data: ROLES });
    renderPill();
    fireEvent.click(screen.getByRole("button", { name: /Roles preset: / }));
    const menu = await screen.findByTestId("ae-preset-menu");
    const search = screen.getByRole("searchbox", { name: "Search presets" });
    await waitFor(() => expect(menu).toContainElement(document.activeElement as HTMLElement));
    expect(document.activeElement).toBe(search);
  });

  describe("menu layout", () => {
    const pins = (...pinned: string[]) => ({
      data: {
        ...ROLES,
        presets: [
          ...ROLES.presets,
          preset("solo", "Solo", "own"),
          preset("quick-fix", "Quick fix"),
        ].map((p) => ({ ...p, pinned: pinned.includes(p.id) })),
      },
    });
    const radios = () => screen.getAllByRole("menuitemradio").map((el) => el.textContent ?? "");
    const open = (name = /^Roles preset: / as RegExp) =>
      fireEvent.click(screen.getByRole("button", { name }));

    it("shows pinned rows and folds the rest behind More with their count", () => {
      mocks.roles.mockReturnValue(pins("save-tokens", "balanced"));
      renderPill();
      open();
      const names = radios();
      expect(names).toHaveLength(3);
      expect(names[1]).toMatch(/^Save tokens/);
      expect(names[2]).toMatch(/^Balanced/);
      expect(screen.getByText("Pinned")).toBeInTheDocument();
      expect(screen.queryByText("Recent")).not.toBeInTheDocument();
      expect(screen.queryByText("All presets")).not.toBeInTheDocument();
      const more = screen.getByRole("button", { name: /More presets/ });
      expect(more).toHaveAttribute("aria-expanded", "false");
      expect(more).toHaveTextContent("3");
      expect(screen.queryByRole("menuitemradio", { name: /YOLO/ })).not.toBeInTheDocument();
    });

    it("expands the hidden rows in place and folds them again when the menu closes", () => {
      mocks.roles.mockReturnValue(pins("save-tokens", "balanced"));
      renderPill();
      open();
      const more = screen.getByRole("button", { name: /More presets/ });
      fireEvent.click(more);
      expect(more).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("menuitemradio", { name: /YOLO/ })).toBeInTheDocument();
      expect(screen.getByRole("menuitemradio", { name: /Quick fix/ })).toBeInTheDocument();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      open();
      expect(screen.getByRole("button", { name: /More presets/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    it("keeps an active unpinned preset in the top group", () => {
      mocks.roles.mockReturnValue(pins("save-tokens"));
      renderPill();
      open(/^Roles preset: Balanced/);
      const names = radios();
      expect(names[1]).toMatch(/^Save tokens/);
      expect(names[2]).toMatch(/^Balanced/);
      expect(screen.getByRole("button", { name: /More presets/ })).toHaveTextContent("3");
    });

    it("shows one flat list and no More row when nothing is pinned", () => {
      mocks.roles.mockReturnValue(pins());
      renderPill();
      open();
      expect(screen.getByText("All presets")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /More presets/ })).not.toBeInTheDocument();
      expect(radios()).toHaveLength(6);
    });

    it("searches every preset, hidden ones included, as one Matches list", () => {
      mocks.roles.mockReturnValue(pins("save-tokens"));
      renderPill();
      open();
      fireEvent.change(screen.getByRole("searchbox", { name: "Search presets" }), {
        target: { value: "quick" },
      });
      expect(screen.getByText("Matches")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /More presets/ })).not.toBeInTheDocument();
      expect(screen.getByRole("menuitemradio", { name: /Quick fix/ })).toBeInTheDocument();
    });

    it("keeps each Alt number tied to the preset's place in the full list", () => {
      mocks.roles.mockReturnValue(pins("save-tokens", "balanced"));
      renderPill();
      open();
      fireEvent.click(screen.getByRole("button", { name: /More presets/ }));
      const alt = (title: RegExp) =>
        screen.getByRole("menuitemradio", { name: title }).querySelector("kbd")?.textContent;
      expect(alt(/Save tokens/)).toBe("Alt 1");
      expect(alt(/YOLO/)).toBe("Alt 3");
      expect(alt(/Solo/)).toBe("Alt 4");
      expect(alt(/Quick fix/)).toBe("Alt 5");
    });
  });

  it.each([
    ["phone", true],
    ["desktop", false],
  ])("styles the %s pill like the model picker: no ring, bare icon, chevron", (_, mobile) => {
    mocks.mobile.mockReturnValue(mobile);
    mocks.roles.mockReturnValue({ data: ROLES });
    renderPill();
    const pill = screen.getByTestId("ae-preset-pill");
    expect(pill.className).not.toMatch(/(^|\s)border(\s|$)/);
    expect(pill.className).not.toContain("rounded-full");
    expect(pill.className).toContain("rounded-lg");
    expect(within(pill).getByTestId("ae-role-preset-tile").className).toContain("bg-transparent");
    expect(pill.querySelector("svg.lucide-chevron-down")).not.toBeNull();
  });

  it("disables adding and removing sessions in the menu while a turn runs", () => {
    mocks.roles.mockReturnValue({ data: ROLES });
    renderPill({ working: true }, sessionWithTeam([memberFor(claude, { sessionId: "kid" })]));
    fireEvent.click(screen.getByRole("button", { name: /^Roles preset: Balanced/ }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Claude Code" })).toBeDisabled();
    expect(
      screen.getByText("You can save collaboration changes after this turn finishes."),
    ).toBeInTheDocument();
    // Switching the preset only writes the label and stays available.
    expect(screen.getAllByRole("menuitemradio", { name: /YOLO/ })[0]).toBeEnabled();
  });

  it("holds the dialog back while a menu change is still saving, then opens it", async () => {
    mocks.roles.mockReturnValue({ data: ROLES });
    const stored = sessionWithTeam([memberFor(claude, { sessionId: "kid" })]);
    let release!: (value: Session) => void;
    mocks.getSessionSlim.mockReturnValue(
      new Promise<Session>((resolve) => {
        release = resolve;
      }),
    );
    vi.mocked(saveAeTeam).mockResolvedValue(session);
    renderPill({}, stored);
    fireEvent.click(screen.getByRole("button", { name: /^Roles preset: Balanced/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Claude Code" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Who works on this\?/ })).toBeDisabled(),
    );
    await act(async () => release(stored));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Who works on this\?/ })).toBeEnabled(),
    );
  });
});
