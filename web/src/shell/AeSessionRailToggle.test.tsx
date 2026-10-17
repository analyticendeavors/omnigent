import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import { ChatHeader } from "./ChatHeader";

const { isMobileMock } = vi.hoisted(() => ({ isMobileMock: vi.fn(() => false) }));

vi.mock("@/hooks/useIsMobileViewport", () => ({
  useIsMobileViewport: () => isMobileMock(),
}));

const mobileMenu = {
  fileViewerOpen: false,
  panelOpen: false,
  terminalFirst: false,
  executionLogsOpen: false,
  filesPanelOpen: false,
  subagentsPanelOpen: false,
  shellsPanelOpen: false,
  githubPanelOpen: false,
  hideTerminalsTab: false,
  showShellsTab: false,
  terminalsLength: 0,
  debugMode: false,
  changedCount: 0,
  subagentsWorking: 0,
  agentCount: 1,
  onOpenFiles: () => {},
  onOpenChanges: () => {},
  onOpenShells: () => {},
  onOpenSubagents: () => {},
  onOpenGithub: () => {},
  onOpenMainExecutionLog: () => {},
};

function renderHeader({
  conversationId,
  pending = false,
}: {
  conversationId?: string;
  pending?: boolean;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ChatHeader
            sidebarOpen
            onOpenSidebar={() => {}}
            isChildSession={false}
            subAgentName={null}
            conversationId={conversationId}
            conversationTitle={null}
            projectName={null}
            boundAgent={undefined}
            wrapperLabel={null}
            canShare={false}
            canFork={false}
            onShare={() => {}}
            onFork={() => {}}
            hasAgentInfo={false}
            onAgentInfo={() => {}}
            hasHeaderMenu={false}
            showFilesPanel={false}
            hasRailContent={false}
            rightPanelOpen={false}
            onToggleRightPanel={() => {}}
            pending={pending}
            mobileMenu={mobileMenu}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAeSessionRailStore.setState({ open: false, sheetOpen: false });
});

afterEach(() => {
  cleanup();
  isMobileMock.mockReturnValue(false);
});

describe("session rail header toggle", () => {
  it("shows for an open conversation even without workspace rail content, and toggles", () => {
    renderHeader({ conversationId: "conv-1" });
    const toggle = screen.getByRole("button", { name: "Show session rail" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveClass("hidden", "md:inline-flex");
    fireEvent.click(toggle);
    expect(useAeSessionRailStore.getState().open).toBe(true);
    const pressed = screen.getByRole("button", { name: "Hide session rail" });
    expect(pressed).toHaveAttribute("aria-pressed", "true");
  });

  it("is absent with no conversation or while the session is still being created", () => {
    renderHeader({});
    expect(screen.queryByRole("button", { name: "Show session rail" })).toBeNull();
    cleanup();
    renderHeader({ conversationId: "temp:1", pending: true });
    expect(screen.queryByRole("button", { name: "Show session rail" })).toBeNull();
  });

  it("opens the phone sheet from the session menu", () => {
    isMobileMock.mockReturnValue(true);
    renderHeader({ conversationId: "conv-1" });
    fireEvent.pointerDown(screen.getByTestId("session-actions-menu"), { button: 0 });
    fireEvent.click(screen.getByTestId("mobile-session-rail"));
    expect(useAeSessionRailStore.getState().sheetOpen).toBe(true);
  });
});
