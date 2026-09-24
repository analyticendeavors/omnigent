// Tests for the AE layer's sidebar affordances (omnigent-ae Phase 2, P1):
//   1. `AeConversationStatusIcon` renders the `ae.status` label as a named
//      image before the row's title, with blocked derived from a pending
//      approval on a working session, and nothing for a session without one.
//   2. A leading legacy title glyph (🟡 🔴 ✅ 📌 🗂️) is stripped for display;
//      the stored title is untouched.
//   3. `AeSlotsPill` sits in the primary navigation beside the extension
//      slot, counts the working rows in the `["conversations"]` cache, and
//      turns red at the limit.
//   4. The row's kebab and right-click menus carry the Status submenu
//      (`AeStatusMenu`, patch P4) for the owner, and not for a shared row.
// The mock scaffold is the one `Sidebar.rowActions.test.tsx` uses, so the
// sidebar renders with the same stubs.

import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Since upstream v0.15.0 the sidebar reads its rows through
// `SidebarDataProvider`, whose scope cache is swapped for the
// `useConversations`-backed stub every upstream Sidebar suite uses.
vi.mock("@/hooks/useScopeCache", () => import("@/test/mockScopeCache"));
import { SidebarDataProvider } from "@/hooks/useSidebarData";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import type * as IdentityModule from "@/lib/identity";

// Controllable rename mutation so the double-click test can assert the
// committed title was forwarded to the PATCH. `isMobile` toggles the mocked
// `useIsMobileViewport` so a test can render the row on a mobile viewport (the
// project flyout is disabled there). Declared via vi.hoisted so the vi.mock
// factories (hoisted above imports) can reference them.
const mocks = vi.hoisted(() => {
  // Tiny reactive store for the server-authoritative pinned set, so a quick-pin
  // click re-renders the sidebar (mirrors the real query's refetch). Holds ids;
  // the mocked hook maps them onto the loaded conversations.
  const pinnedListeners = new Set<() => void>();
  const pinnedStore = {
    ids: [] as string[],
    subscribe(cb: () => void) {
      pinnedListeners.add(cb);
      return () => pinnedListeners.delete(cb);
    },
    set(ids: string[]) {
      pinnedStore.ids = ids;
      pinnedListeners.forEach((cb) => cb());
    },
    toggle(id: string, pinned: boolean) {
      pinnedStore.set(
        pinned
          ? [id, ...pinnedStore.ids.filter((x) => x !== id)]
          : pinnedStore.ids.filter((x) => x !== id),
      );
    },
  };
  return {
    // `isSuccess`/`isError` drive the row's hold-the-committed-name logic:
    // it keeps showing the new title until the PATCH settles.
    rename: { mutate: vi.fn(), isSuccess: false, isError: false },
    isMobile: false,
    // Projects surfaced by the picker + the move-to-project mutation, so the
    // mobile in-place project view test can assert both the list and the pick.
    projects: [] as string[],
    projectIcons: {} as Record<string, string | null | undefined>,
    moveToProject: { mutate: vi.fn() },
    leave: { mutate: vi.fn(), isPending: false },
    // The signed-in viewer. Rows with no `owner` read as owned by them; a row
    // owned by someone else is the shared case Leave applies to.
    viewerId: "viewer@example.com" as string | null,
    conversations: [] as unknown[],
    pinnedStore,
  };
});

// Mock the mobile-viewport hook — jsdom doesn't evaluate media queries, so
// drive it explicitly. Defaults to desktop (false); the mobile flyout test
// flips `mocks.isMobile` for the duration of that case.
vi.mock("@/hooks/useIsMobileViewport", () => ({
  useIsMobileViewport: () => mocks.isMobile,
}));

vi.mock("@/hooks/useConversations", () => ({
  useConversations: vi.fn(),
  useConnectedConversations: () => [],
  useStopAndDeleteConversation: () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    variables: undefined,
  }),
  // Reactive server pinned set: subscribes to the hoisted store so a toggle
  // re-renders, mapping pinned ids onto the loaded conversations.
  usePinnedConversations: () => {
    const ids = useSyncExternalStore(mocks.pinnedStore.subscribe, () => mocks.pinnedStore.ids);
    const idSet = new Set(ids);
    return {
      data: {
        conversations: (mocks.conversations as { id: string }[]).filter((c) => idSet.has(c.id)),
        filterHonored: true,
      },
      isSuccess: true,
    };
  },
  useTogglePinnedConversation: () => ({
    mutate: ({ id, pinned }: { id: string; pinned: boolean }) =>
      mocks.pinnedStore.toggle(id, pinned),
  }),
  setConversationPinned: vi.fn(() => Promise.resolve({})),
  PINNED_CONVERSATIONS_KEY: ["pinned-conversations"],
  useRenameConversation: () => mocks.rename,
  useLeaveSession: () => mocks.leave,
  useArchiveConversation: () => ({ mutate: vi.fn() }),
  useBulkArchiveConversations: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useBulkDeleteConversations: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useBulkMoveToProject: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useBulkStopSessions: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useStopSession: () => ({ mutate: vi.fn() }),
  useProjects: () => ({
    data: mocks.projects.map((name: string) => ({
      id: `p_${name}`,
      name,
      icon: mocks.projectIcons[name],
    })),
  }),
  // A non-empty `useProjects` renders a project folder, which queries its
  // sessions — return the collapsed (disabled) shape so the folder is inert
  // (this suite keeps its test row unfiled; the picker only needs the name).
  useProjectSessions: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
  useMoveToProject: () => mocks.moveToProject,
  useDeleteProject: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useRenameProject: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useCreateProject: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useProjectConfig: () => ({ data: undefined, isLoading: false }),
  useUpdateProjectConfig: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  fetchProjectSessionIds: () => Promise.resolve([]),
  PROJECT_LABEL_KEY: "omni_project",
}));

// Heavy sibling widgets pull their own hooks/providers; stub them so this
// test stays scoped to the conversation row.
vi.mock("./AgentTypeFilter", () => ({ AgentTypeFilter: () => null }));
vi.mock("./ReportIssueButton", () => ({ ReportIssueButton: () => null }));
vi.mock("@/components/PermissionsModal", () => ({ PermissionsModal: () => null }));
vi.mock("./ForkSessionDialog", () => ({
  ForkSessionDialog: ({ open, sourceSessionId }: { open: boolean; sourceSessionId: string }) =>
    open ? (
      <div data-testid="fork-session-dialog" data-source-session-id={sourceSessionId} />
    ) : null,
}));
// Force a multi-user (non-local) server so the "Shared with me" tab renders —
// jsdom's default loopback origin would otherwise read as single-user and hide
// the tabs the shared-session row actions rely on.
vi.mock("@/lib/serverOrigin", () => ({ isCurrentServerLocal: () => false }));
// Pin "who am I": ownership (and therefore Leave, which revokes the viewer's
// own grant) is derived from this id. Unmocked it resolves to null in jsdom,
// which reads as "not the owner" for shared rows but leaves Leave with no id
// to revoke.
vi.mock("@/lib/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof IdentityModule>()),
  getCurrentUserId: () => mocks.viewerId,
  resolveIdentity: () => Promise.resolve(mocks.viewerId),
}));

import { type Conversation, useConversations } from "@/hooks/useConversations";
import { resetReadStateForTests } from "@/hooks/useUnseenConversations";
import { Sidebar } from "./Sidebar";

const useConvMock = vi.mocked(useConversations);

const CONV: Conversation = {
  id: "conv_1",
  object: "conversation",
  title: "My Session",
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  labels: {},
  permission_level: null,
  // owner absent → the viewer owns it (rename/share/pin all enabled)
  status: "idle",
};

function mockConversations(conversations: Conversation[]) {
  const dataResult = {
    data: {
      pages: [
        {
          data: conversations,
          first_id: conversations[0]?.id ?? null,
          last_id: conversations.at(-1)?.id ?? null,
          has_more: false,
        },
      ],
      pageParams: [undefined],
    },
    isLoading: false,
    isError: false,
    error: null,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  } as unknown as ReturnType<typeof useConversations>;
  useConvMock.mockImplementation(() => dataResult);
  // The pinned mock maps its ids onto these loaded conversations.
  mocks.conversations = conversations;
}

// Renders at `/` (no row active) under the CapabilitiesContext default
// ("loading", sharing treated as on), like the row-actions suite. `cached`
// seeds the `["conversations"]` query the slots pill reads.
function renderSidebar(cached: Conversation[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // `useConversations` is mocked, so the slots pill reads the cache seeded
  // here, under the key and shape the sidebar's scope cache writes for the
  // viewer's own sessions (`useScopeCache`, upstream v0.15.0).
  if (cached.length > 0) {
    qc.setQueryData(["conversations", "", false, null, "mine"], {
      pages: [
        { data: cached, first_id: cached[0].id, last_id: cached.at(-1)!.id, has_more: false },
      ],
      pageParams: [undefined],
    });
  }
  // Build a FRESH element tree per render: re-rendering the identical element
  // reference lets React bail out without re-invoking the sidebar, which
  // would swallow a `mockConversations` swap applied mid-test.
  const makeUi = () => {
    return (
      <QueryClientProvider client={qc}>
        <SidebarDataProvider>
          <TooltipProvider>
            <MemoryRouter initialEntries={["/"]}>
              <Sidebar open={true} onClose={vi.fn()} />
            </MemoryRouter>
          </TooltipProvider>
        </SidebarDataProvider>
      </QueryClientProvider>
    );
  };
  const view = render(makeUi());
  // Re-render so a test can apply a new `mockConversations` list mid-flight
  // (e.g. simulating a reorder pushed between user clicks).
  return Object.assign(view, { rerenderSidebar: () => view.rerender(makeUi()) });
}

beforeEach(() => {
  mocks.rename.mutate.mockReset();
  mocks.rename.isSuccess = false;
  mocks.rename.isError = false;
  mocks.moveToProject.mutate.mockReset();
  mocks.leave.mutate.mockReset();
  mocks.projects = [];
  mocks.projectIcons = {};
  // Default every test to the desktop viewport; the mobile flyout test opts in.
  mocks.isMobile = false;
  useConvMock.mockReset();
  localStorage.clear();
  // Reset the server pinned set between tests.
  mocks.pinnedStore.set([]);
  // The read-state mirror is module-level (in-memory), so reset it between
  // tests to avoid a mark-unread leaking into later rows.
  resetReadStateForTests();
  mockConversations([CONV]);
});

afterEach(cleanup);

function conv(id: string, extra: Partial<Conversation> = {}): Conversation {
  return { ...CONV, id, title: `Session ${id}`, ...extra };
}

describe("ae.status icon on session rows", () => {
  it("renders the status word as an image before the title", () => {
    mockConversations([conv("w", { labels: { "ae.status": "working" } })]);
    renderSidebar();
    const row = screen.getByRole("link", { name: /Session w/ });
    const icon = within(row).getByRole("img", { name: "Working" });
    expect(icon).toHaveAttribute("data-status", "working");
    // Icon first, then the title: the flex row keeps the icon from wrapping
    // and the title span truncates.
    const title = within(row).getByText("Session w");
    expect(icon.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title).toHaveClass("truncate", "min-w-0");
  });

  it("shows every stored status with its own glyph", () => {
    mockConversations([
      conv("b", { labels: { "ae.status": "blocked" } }),
      conv("r", { labels: { "ae.status": "review" } }),
      conv("p", { labels: { "ae.status": "parked" } }),
      conv("f", { labels: { "ae.status": "reference" } }),
    ]);
    renderSidebar();
    for (const [id, word] of [
      ["b", "Blocked"],
      ["r", "Review"],
      ["p", "Parked"],
      ["f", "Reference"],
    ] as const) {
      const row = screen.getByRole("link", { name: new RegExp(`Session ${id}`) });
      expect(within(row).getByRole("img", { name: word })).toBeInTheDocument();
    }
  });

  it("derives blocked from a working session with an approval prompt outstanding", () => {
    mockConversations([
      conv("w", { labels: { "ae.status": "working" }, pending_elicitations_count: 1 }),
    ]);
    renderSidebar();
    const row = screen.getByRole("link", { name: /Session w/ });
    expect(within(row).getByRole("img", { name: "Blocked" })).toHaveAttribute(
      "data-status",
      "blocked",
    );
    expect(within(row).queryByRole("img", { name: "Working" })).toBeNull();
  });

  it("renders no icon for a session without ae.status", () => {
    mockConversations([conv("n"), conv("e", { labels: { "ae.status": "" } })]);
    renderSidebar();
    expect(screen.queryByTestId("ae-status-icon")).toBeNull();
  });

  it("strips a leading legacy glyph from the title for display only", () => {
    mockConversations([
      conv("g", { title: "🟡 Fix the build", labels: { "ae.status": "working" } }),
    ]);
    renderSidebar();
    const row = screen.getByRole("link", { name: /Fix the build/ });
    expect(within(row).getByText("Fix the build")).toBeInTheDocument();
    expect(within(row).queryByText(/🟡/)).toBeNull();
    // The rename seed is the stored title, glyph and all, so a rename that
    // keeps the name keeps the glyph; nothing here writes one back either way.
    fireEvent.doubleClick(row);
    expect(screen.getByDisplayValue("🟡 Fix the build")).toBeInTheDocument();
  });
});

describe("slots pill", () => {
  it("sits in the primary navigation and links to the Parking Lot page", () => {
    renderSidebar();
    const nav = screen.getByTestId("sidebar-primary-nav");
    // `asChild` merges the test id onto the anchor itself.
    const pill = within(nav).getByTestId("ae-slots-pill");
    expect(pill.tagName).toBe("A");
    expect(pill).toHaveAccessibleName("Slots 0/3");
    expect(pill).toHaveAttribute("href", "/extensions/analyticendeavors.parking-lot/lot");
    expect(within(pill).getByTestId("ae-slots-count")).toHaveAttribute("data-full", "false");
  });

  it("counts the working rows in the conversations cache", () => {
    renderSidebar([
      conv("a", { labels: { "ae.status": "working" } }),
      conv("b", { labels: { "ae.status": "working" } }),
      conv("c", { labels: { "ae.status": "parked" } }),
      conv("sub", { labels: { "ae.status": "working" }, parent_session_id: "a" }),
      conv("old", { labels: { "ae.status": "working" }, archived: true }),
    ]);
    expect(screen.getByRole("link", { name: "Slots 2/3" })).toBeInTheDocument();
    expect(screen.getByTestId("ae-slots-count")).not.toHaveClass("text-destructive");
  });

  it("turns red at three working sessions", () => {
    renderSidebar([
      conv("a", { labels: { "ae.status": "working" } }),
      conv("b", { labels: { "ae.status": "working" } }),
      conv("c", { labels: { "ae.status": "working" } }),
    ]);
    expect(screen.getByRole("link", { name: "Slots 3/3" })).toBeInTheDocument();
    const count = screen.getByTestId("ae-slots-count");
    expect(count).toHaveAttribute("data-full", "true");
    expect(count).toHaveClass("text-destructive");
  });

  it("renders in the mobile drawer too, beside the row icons", () => {
    mocks.isMobile = true;
    mockConversations([conv("w", { labels: { "ae.status": "working" } })]);
    renderSidebar([conv("w", { labels: { "ae.status": "working" } })]);
    expect(screen.getByRole("link", { name: "Slots 1/3" })).toBeInTheDocument();
    const row = screen.getByRole("link", { name: /Session w/ });
    expect(within(row).getByRole("img", { name: "Working" })).toBeInTheDocument();
  });
});

describe("Status submenu in the row menus", () => {
  it("sits in the owner's kebab before the lifecycle actions", () => {
    mockConversations([conv("w", { labels: { "ae.status": "working" } })]);
    renderSidebar();
    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    const trigger = screen.getByTestId("ae-status-menu");
    expect(trigger).toHaveTextContent("Status");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    const archive = screen.getByTestId("archive-conversation");
    expect(
      trigger.compareDocumentPosition(archive) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("sits in the right-click menu too", () => {
    mockConversations([conv("w", { labels: { "ae.status": "working" } })]);
    renderSidebar();
    fireEvent.contextMenu(screen.getByRole("link", { name: /Session w/ }));
    expect(screen.getByTestId("ae-status-menu")).toBeInTheDocument();
  });

  it("lists the five values inline with the stored one checked on mobile", () => {
    mocks.isMobile = true;
    mockConversations([conv("p", { labels: { "ae.status": "parked" } })]);
    renderSidebar();
    fireEvent.pointerDown(screen.getByTestId("conversation-actions"), { button: 0 });
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      "Working",
      "Blocked",
      "Review",
      "Parked",
      "Reference",
    ]);
    expect(screen.getByRole("menuitemradio", { name: /Parked/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("is not offered on a session shared with the viewer", () => {
    mockConversations([conv("s", { owner: "other@example.com" })]);
    renderSidebar();
    fireEvent.pointerDown(screen.getByTestId("session-filter"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByTestId("session-filter-shared"));
    fireEvent.contextMenu(screen.getByRole("link", { name: /Session s/ }));
    expect(screen.getByTestId("fork-conversation")).toBeInTheDocument();
    expect(screen.queryByTestId("ae-status-menu")).toBeNull();
  });
});
