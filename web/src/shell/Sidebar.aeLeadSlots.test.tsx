// A family lead's fixed right-hand slots, rendered (omnigent-ae, 2026-10-26): the
// chevron never moves, the actions wrapper takes no clicks and is desktop-only,
// a wide marker or the shared icon never lands on the spinner, the spinner takes
// the time's place when nothing else is there (no room held for it when idle), and
// the fade follows hover, focus inside the actions and an open menu.

import type * as ActivityHooksModule from "@/hooks/aeSessionActivityHooks";
import type * as IdentityModule from "@/lib/identity";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useScopeCache", () => import("@/test/mockScopeCache"));

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  archived: vi.fn(),
  archiveOne: vi.fn(),
  archiveMany: vi.fn(),
  states: new Map<string, unknown>(),
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
      data: { conversations: [], filterHonored: true },
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
vi.mock("@/hooks/aeSessionActivityHooks", async (importOriginal) => ({
  ...(await importOriginal<typeof ActivityHooksModule>()),
  useAeSessionRowState: (c: { id: string }) => ({
    state: mocks.states.get(c.id) ?? null,
    scheduled: null,
  }),
}));
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

// Newest first, as the list pages them.
const ROWS = [
  row("Lead", 50, {}),
  row("Child A", 40, { "ae.orch": sid("Lead") }),
  row("Child B", 30, { "ae.orch": sid("Lead") }),
];

function setView(view: Record<string, unknown>) {
  localStorage.setItem(
    "omnigent:sidebar-view",
    JSON.stringify({ grouping: "family", ordering: "updated", show: [], ...view }),
  );
}

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
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
              <Sidebar open={true} onClose={vi.fn()} />
            </CapabilitiesProvider>
          </MemoryRouter>
        </TooltipProvider>
      </SidebarDataProvider>
    </QueryClientProvider>,
  );
}

function lead(): HTMLElement {
  return document.querySelector<HTMLElement>(`li[data-sidebar-session-id="${sid("Lead")}"]`)!;
}
const link = () => lead().querySelector<HTMLElement>(`a[href="/c/${sid("Lead")}"]`)!;
const chevron = () => within(lead()).getByTestId("ae-family-fold");

function useRows(rows: Conversation[]) {
  useConvMock.mockImplementation(() => conversationPage(rows));
}

beforeEach(() => {
  localStorage.clear();
  resetAeFamilyFoldsCache();
  resetAeFamilyClosedCache();
  mocks.archived.mockReset();
  mocks.archived.mockResolvedValue({ data: [] });
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValue(new Response("{}", { status: 404 }));
  mocks.states.clear();
  useRows(ROWS);
  setView({});
});

afterEach(() => {
  cleanup();
  useConvMock.mockReset();
});

describe("lead row slots", () => {
  it("renders the actions wrapper with no pointer events, desktop only, buttons clickable", () => {
    renderSidebar();
    const wrapper = within(lead()).getByTestId("conversation-actions").parentElement!;
    expect(wrapper.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["pointer-events-none", "hidden", "md:flex"]),
    );
    for (const id of [
      "quick-pin-conversation",
      "quick-archive-conversation",
      "conversation-actions",
    ]) {
      const btn = within(wrapper).getByTestId(id);
      expect(btn.className.split(/\s+/)).toContain("pointer-events-auto");
      expect(btn.className.split(/\s+/)).toContain("hidden");
    }
  });

  it("keeps the chevron's classes and position the same idle, thinking and folded", () => {
    renderSidebar();
    const idle = chevron().className;
    expect(idle.split(/\s+/)).toContain("right-1");
    expect(chevron().getAttribute("style")).toBeNull();
    cleanup();
    useRows(
      [row("Lead", 50, {}), ...ROWS.slice(1)].map((c) =>
        c.id === sid("Lead") ? { ...c, status: "running" as const } : c,
      ),
    );
    mocks.states.set(sid("Lead"), { kind: "running" });
    renderSidebar();
    expect(chevron().className).toBe(idle);
    fireEvent.click(chevron());
    expect(
      chevron().className.replace(
        "bg-foreground/10 text-foreground",
        "bg-foreground/[0.06] text-muted-foreground",
      ),
    ).toBe(idle);
  });

  it("keeps no room for a spinner on an idle lead, so the title runs to the time", () => {
    renderSidebar();
    expect(within(lead()).queryByTestId("ae-lead-spinner")).toBeNull();
    expect(link().style.paddingRight).toBe("70px");
  });

  it("puts a thinking lead's spinner in the time slot, in place of the time", () => {
    mocks.states.set(sid("Lead"), { kind: "running" });
    renderSidebar();
    const spinner = within(lead()).getByTestId("ae-lead-spinner");
    expect(spinner.style.right).toBe("28px");
    expect(spinner.getAttribute("data-in-time")).toBe("true");
    expect(within(lead()).queryByTestId("ae-lead-time")).toBeNull();
    expect(within(lead()).queryByTestId("session-row-updated")).toBeNull();
    // Same reserve as idle: the title does not move when thinking starts.
    expect(link().style.paddingRight).toBe("70px");
  });

  it("shows the folded-running spinner in the time slot", () => {
    useRows(ROWS.map((c) => (c.id === sid("Child A") ? { ...c, status: "running" as const } : c)));
    renderSidebar();
    fireEvent.click(chevron());
    expect(within(lead()).getByTestId("ae-lead-spinner").style.right).toBe("28px");
    expect(within(lead()).queryByTestId("ae-family-fold-running")).toBeNull();
  });

  it("reserves a wide pill's width for a shared lead and puts the icon clear of it", () => {
    useRows(ROWS.map((c) => (c.id === sid("Lead") ? { ...c, owner: "other@example.com" } : c)));
    mocks.states.set(sid("Lead"), { kind: "awaiting", count: 1 });
    renderSidebar();
    expect(link().style.paddingRight).toBe("168px");
    expect(within(lead()).getByRole("img", { name: "Shared session" }).style.right).toBe("136px");
  });

  it("puts the folded-running spinner left of a wide marker in the time slot", () => {
    mocks.states.set(sid("Lead"), { kind: "awaiting", count: 1 });
    useRows(ROWS.map((c) => (c.id === sid("Child A") ? { ...c, status: "running" as const } : c)));
    renderSidebar();
    fireEvent.click(chevron());
    const pill = within(lead()).getByTestId("ae-lead-time");
    expect(pill.style.right).toBe("28px");
    expect(within(lead()).getByTestId("ae-lead-spinner").style.right).toBe("136px");
    expect(link().style.paddingRight).toBe("160px");
  });

  it("lets focus on the chevron leave the time and spinner alone, but not focus in the actions", () => {
    mocks.states.set(sid("Lead"), { kind: "awaiting", count: 1 });
    renderSidebar();
    const hide = within(lead()).getByTestId("ae-lead-time").className;
    expect(hide).toContain(
      "group-has-[:focus-visible:not([data-testid=ae-family-fold])]:opacity-0",
    );
    expect(hide).not.toContain("group-has-[:focus-visible]:");
    const actions = within(lead()).getByTestId("conversation-actions");
    expect(actions.className).toContain(
      "group-has-[:focus-visible:not([data-testid=ae-family-fold])]:opacity-100",
    );
  });

  it("truncates the title at the actions on hover and focus, with no fade over it", () => {
    renderSidebar();
    expect(link().className).toContain("md:group-hover:pr-[106px]!");
    expect(link().className).toContain(
      "md:group-has-[:focus-visible:not([data-testid=ae-family-fold])]:pr-[106px]!",
    );
    expect(link().className).not.toContain("md:group-hover:pr-20");
    const cls = within(lead()).getByTestId("conversation-actions").parentElement!.className;
    expect(cls).not.toContain("--ae-fade-color");
    expect(cls).not.toContain("bg-[");
  });
});
