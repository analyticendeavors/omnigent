// The session rail's "open in every session" setting at the shell level: a
// session whose workspace panel was left open starts with it closed when the
// two do not fit, nothing is saved, and every later open swaps as usual.

import type * as UseTerminalsModule from "@/hooks/useTerminals";
import type * as UseChildSessionsModule from "@/hooks/useChildSessions";
import type * as UseSessionModule from "@/hooks/useSession";
import type * as UseConversationsModule from "@/hooks/useConversations";
import type * as UsePullRequestsModule from "@/hooks/usePullRequests";
import type * as UseWorkspaceChangedFilesModule from "@/hooks/useWorkspaceChangedFiles";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarDataProvider } from "@/hooks/useSidebarData";
import { aeRailForgetRestoredSession, useAeSessionRailStore } from "@/lib/aeSessionRail";
import { readSessionWorkspaceState, writeSessionWorkspaceState } from "@/lib/sessionWorkspaceState";
import {
  readDefaultWorkspacePanelOpen,
  writeWorkspacePanelDefault,
} from "@/lib/workspacePanelPreferences";

vi.mock("@/hooks/useConversations", async (importOriginal) => ({
  ...(await importOriginal<typeof UseConversationsModule>()),
  useConversations: vi.fn(),
  useStopSession: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));
vi.mock("@/hooks/useTerminals", async (importOriginal) => ({
  // Keep the real module; only the network-backed hook is replaced.
  ...(await importOriginal<typeof UseTerminalsModule>()),
  useTerminals: vi.fn(() => ({ terminals: [], isLoading: false, error: null })),
}));
vi.mock("@/hooks/useWorkspaceChangedFiles", async (importOriginal) => ({
  // Keep the real module; only the hooks AppShell reads here are replaced.
  ...(await importOriginal<typeof UseWorkspaceChangedFilesModule>()),
  useWorkspaceServeable: () => true,
  useWorkspaceEnvironment: vi.fn(() => ({
    data: { available: true, root: null },
    isLoading: false,
  })),
  useWorkspaceChangedFiles: vi.fn(() => ({
    data: { data: [] },
    isSuccess: true,
    isLoading: false,
  })),
}));
vi.mock("@/hooks/usePullRequests", async (importOriginal) => ({
  // Keep the real module; only the info hook AppShell reads is replaced.
  ...(await importOriginal<typeof UsePullRequestsModule>()),
  usePullRequestInfo: vi.fn(() => ({ data: undefined, isLoading: true })),
}));
vi.mock("@/hooks/useChildSessions", async (importOriginal) => ({
  ...(await importOriginal<typeof UseChildSessionsModule>()),
  useChildSessions: vi.fn(() => ({ children: [], isLoading: false, error: null })),
}));
vi.mock("@/hooks/useSession", async (importOriginal) => ({
  ...(await importOriginal<typeof UseSessionModule>()),
  useSession: vi.fn(() => ({ session: null, isLoading: false, error: null })),
}));
vi.mock("@/hooks/useAgents", () => ({
  useSessionAgent: vi.fn(() => ({ data: undefined })),
  useCreateMcpServer: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useUpdateMcpServer: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useDeleteMcpServer: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("./Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
  isMobileViewport: vi.fn(() => false),
}));
vi.mock("./PullRequestPanel", () => ({
  PullRequestPanel: () => <div data-testid="github-panel">Pull request details</div>,
}));
vi.mock("./FilesPanel", () => ({
  FilesPanel: () => <div data-testid="files-panel" />,
}));
vi.mock("./FileViewer", () => ({
  FileViewer: () => <div data-testid="file-viewer" />,
}));
vi.mock("./InlineTerminalsSection", () => ({
  InlineTerminalsSection: () => <div data-testid="inline-terminals-section" />,
}));
vi.mock("./FilesPanelDrawer", () => ({
  FilesPanelDrawer: () => <div data-testid="files-panel-drawer" />,
}));
vi.mock("./TerminalsPanel", () => ({
  TerminalsPanel: () => <div data-testid="terminals-panel" />,
}));

vi.mock("@/hooks/useIsMobileViewport", () => ({ useIsMobileViewport: () => false }));
// Small stand-ins for the rail's sections, so the shell is tested alone.
vi.mock("@/components/aeRail/registry", async () => {
  const { AE_RAIL_SECTIONS: ids } = await import("@/lib/aeSessionRail");
  return { AE_RAIL_COMPONENTS: Object.fromEntries(ids.map((id) => [id, () => <p>{id}</p>])) };
});

import { AppShell } from "./AppShell";
import { useOpenGithubTab } from "./FileViewerContext";
import { isMobileViewport } from "./Sidebar";
import { useConversations } from "@/hooks/useConversations";

const matchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  window.matchMedia = matchMedia;
});

beforeEach(() => {
  // A desktop window: the setup's stub matches no media query.
  window.matchMedia = ((query: string) => ({ ...matchMedia(query), matches: true })) as never;
  localStorage.clear();
  sessionStorage.clear();
  writeWorkspacePanelDefault("open");
  writeSessionWorkspaceState("conv_ws", { open: true, rightRailTab: "files" });
  aeRailForgetRestoredSession();
  useAeSessionRailStore.setState({ open: false, closedForPanel: false, openInEverySession: true });
  vi.mocked(isMobileViewport).mockReturnValue(false);
  vi.mocked(useConversations).mockReset();
  vi.mocked(useConversations).mockReturnValue({
    data: {
      pages: [
        {
          data: [
            {
              id: "conv_ws",
              object: "conversation" as const,
              title: null,
              created_at: 0,
              updated_at: 0,
              labels: {},
              permission_level: null,
              host_id: null,
              runner_id: null,
            },
          ],
          first_id: null,
          last_id: null,
          has_more: false,
        },
      ],
      pageParams: [undefined],
    },
  } as never);
});

function AgentOpenProbe() {
  const openGithubTab = useOpenGithubTab();
  return (
    <>
      <button type="button" onClick={() => openGithubTab?.()}>
        Agent opens GitHub
      </button>
      <Link to="/c/conv_other">Another session</Link>
    </>
  );
}

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SidebarDataProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={["/c/conv_ws"]}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="c/:conversationId" element={<AgentOpenProbe />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </SidebarDataProvider>
    </QueryClientProvider>,
  );
}

const railShown = () => screen.queryByTestId("ae-session-rail") !== null;
const panelToggle = () => screen.getByRole("button", { name: /right panel$/ });

describe("AppShell with the rail open in every session", () => {
  it("starts a restored-open panel closed beside the rail and saves nothing", () => {
    renderShell();
    expect(panelToggle()).toHaveAccessibleName("Expand right panel");
    expect(railShown()).toBe(true);
    expect(readSessionWorkspaceState("conv_ws").open).toBe(true);
    expect(readDefaultWorkspacePanelOpen()).toBe(true);
  });

  it("opens the panel from the header toggle by mouse, and the rail makes way", () => {
    renderShell();
    fireEvent.click(panelToggle());
    expect(panelToggle()).toHaveAccessibleName("Collapse right panel");
    expect(useAeSessionRailStore.getState()).toMatchObject({ open: false, closedForPanel: true });
  });

  it("opens the panel from the header toggle by keyboard", async () => {
    const user = userEvent.setup();
    renderShell();
    panelToggle().focus();
    await user.keyboard("{Enter}");
    expect(panelToggle()).toHaveAccessibleName("Collapse right panel");
    expect(railShown()).toBe(false);
  });

  it("lets the agent open a panel mid-session, and brings the rail back at the next switch", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Agent opens GitHub" }));
    expect(panelToggle()).toHaveAccessibleName("Collapse right panel");
    expect(railShown()).toBe(false);
    act(() => {
      fireEvent.click(screen.getByRole("link", { name: "Another session" }));
    });
    expect(railShown()).toBe(true);
  });

  it("off: the restored panel opens and the rail stays closed, as before", () => {
    useAeSessionRailStore.setState({ openInEverySession: false });
    renderShell();
    expect(panelToggle()).toHaveAccessibleName("Collapse right panel");
    expect(railShown()).toBe(false);
  });
});
