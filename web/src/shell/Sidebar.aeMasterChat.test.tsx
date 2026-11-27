// The master chat is hidden from the sidebar's ordinary lists (omnigent-ae, 2026-11-27): it has
// its own row at the top, so it must not also be a row in the Default or Families grouping.
// A pinned ordinary row stays. The id comes from GET /v1/ae/master-chat, never from a label.


import type * as IdentityModule from "@/lib/identity";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useScopeCache", () => import("@/test/mockScopeCache"));

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  archived: vi.fn(),
  archiveOne: vi.fn(),
  archiveMany: vi.fn(),
  pinned: [] as unknown[],
}));

vi.mock("@/hooks/useIsMobileViewport", () => ({ useIsMobileViewport: () => false }));
vi.mock("@/lib/serverOrigin", () => ({ isCurrentServerLocal: () => false }));
vi.mock("@/lib/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof IdentityModule>()),
  authenticatedFetch: mocks.fetch,
  getCurrentUserId: () => "viewer@example.com",
  resolveIdentity: () => Promise.resolve("viewer@example.com"),
}));
vi.mock("@/hooks/useConversations", async () => {
  const { conversationHooksMock } = await import("@/test/sidebarMockHelpers");
  return {
    ...conversationHooksMock(),
    fetchConversationsPage: mocks.archived,
    usePinnedConversations: () => ({
      data: { conversations: mocks.pinned, filterHonored: true },
      isSuccess: true,
    }),
    useProjects: () => ({ data: [] }),
    useMoveToProject: () => ({ mutate: vi.fn() }),
    useTogglePinnedConversation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
    useArchiveConversation: () => ({ mutate: mocks.archiveOne }),
    useBulkArchiveConversations: () => ({
      mutate: mocks.archiveMany,
      mutateAsync: mocks.archiveMany,
      isPending: false,
      isError: false,
    }),
  };
});
vi.mock("@/components/PermissionsModal", () => ({ PermissionsModal: () => null }));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type Conversation, useConversations } from "@/hooks/useConversations";
import { SidebarDataProvider } from "@/hooks/useSidebarData";
import { CapabilitiesProvider } from "@/lib/CapabilitiesContext";
import { resetAeFamilyClosedCache } from "@/lib/aeFamilyClosed";
import { resetAeFamilyFoldsCache } from "@/lib/aeFamilyTree";
import { FALLBACK_SERVER_INFO } from "@/lib/capabilities";
import { conversation, conversationPage } from "@/test/sidebarMockHelpers";
import { Sidebar } from "./Sidebar";

const useConvMock = vi.mocked(useConversations);

function sid(name: string): string {
  return Buffer.from(name).toString("hex").padStart(32, "0");
}

function row(name: string, updated: number, labels: Record<string, string> = {}): Conversation {
  return conversation(sid(name), { title: name, updated_at: updated, created_at: updated, labels });
}

function renderSidebar(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = () => (
    <QueryClientProvider client={qc}>
      <SidebarDataProvider>
        <TooltipProvider>
          <MemoryRouter initialEntries={["/"]}>
            <CapabilitiesProvider
              info={{
                ...FALLBACK_SERVER_INFO,
                features: { ...FALLBACK_SERVER_INFO.features, sidebar_grouping_ui: true },
              }}
            >
              <Sidebar open={true} onClose={onClose} />
            </CapabilitiesProvider>
          </MemoryRouter>
        </TooltipProvider>
      </SidebarDataProvider>
    </QueryClientProvider>
  );
  const view = render(ui());
  return Object.assign(view, { rerenderSidebar: () => view.rerender(ui()) });
}


const MASTER = sid("Master chat");
const PINNED = row("Pinned one", 30, { "omnigent.pinned": "1" });
const ROWS = [
  row("Master chat", 70, { "ae.status": "review" }),
  row("Plain", 50),
  PINNED,
  row("Lead", 20),
  row("Child", 10, { "ae.orch": sid("Lead") }),
];

function setView(view: Record<string, unknown>) {
  localStorage.setItem(
    "omnigent:sidebar-view",
    JSON.stringify({ grouping: "default", ordering: "updated", show: [], ...view }),
  );
}

const listed = () =>
  [...document.querySelectorAll("li[data-sidebar-session-id]")].map((li) =>
    li.getAttribute("data-sidebar-session-id"),
  );

beforeEach(() => {
  localStorage.clear();
  resetAeFamilyFoldsCache();
  resetAeFamilyClosedCache();
  mocks.archived.mockReset();
  mocks.archived.mockResolvedValue({ data: [] });
  mocks.pinned = [PINNED];
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation((url: string) =>
    String(url).includes("/v1/ae/master-chat")
      ? Promise.resolve(
          new Response(JSON.stringify({ session_id: MASTER, waiting: 0 }), { status: 200 }),
        )
      : Promise.resolve(new Response("{}", { status: 404 })),
  );
  useConvMock.mockImplementation(() => conversationPage(ROWS));
});

afterEach(() => {
  cleanup();
  useConvMock.mockReset();
});

describe.each(["default", "family"])("master chat hidden in the %s grouping", (grouping) => {
  it("drops its row from the lists, and keeps the pinned and ordinary rows", async () => {
    setView({ grouping });
    renderSidebar();
    await waitFor(() =>
      expect(screen.getByTestId("ae-master-chat-row").getAttribute("href")).toBe(`/c/${MASTER}`),
    );
    await waitFor(() => expect(listed()).toContain(sid("Plain")));
    expect(listed()).toContain(PINNED.id);
    expect(listed()).not.toContain(MASTER);
  });

  it("lists it as an ordinary row while no master id is known", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 404 }));
    setView({ grouping });
    renderSidebar();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(listed()).toContain(MASTER);
  });
});
