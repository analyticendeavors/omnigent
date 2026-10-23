// Session families in the sidebar (omnigent-ae, 2026-10-23), with the
// sidebar_grouping_ui flag on:
//   1. A lead and the sessions it started (ae.orch), and forks of them, carry
//      one colored dot; other rows carry none.
//   2. A dot narrows the list to its family without opening the session.
//   3. Grouping > Family lists one group per family, lead first, then the rest.
//   4. Show > Family dots turns the dots off.

import type * as IdentityModule from "@/lib/identity";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useScopeCache", () => import("@/test/mockScopeCache"));

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

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
    usePinnedConversations: () => ({
      data: { conversations: [], filterHonored: true },
      isSuccess: true,
    }),
    useProjects: () => ({ data: [] }),
    useMoveToProject: () => ({ mutate: vi.fn() }),
    useTogglePinnedConversation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  };
});
vi.mock("@/components/PermissionsModal", () => ({ PermissionsModal: () => null }));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type Conversation, useConversations } from "@/hooks/useConversations";
import { SidebarDataProvider } from "@/hooks/useSidebarData";
import { CapabilitiesProvider } from "@/lib/CapabilitiesContext";
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
  row("Escalation tool", 60, { "ae.orch": sid("Role routing build") }),
  row("Fabric card speed", 50),
  row("Families PR", 40, { "ae.orch": sid("Role routing build") }),
  row("Families PR (fork)", 35, { "omnigent.fork.source_id": sid("Families PR") }),
  row("PASS deck", 20),
  row("Role routing build", 10),
];

function setView(view: Record<string, unknown>) {
  localStorage.setItem(
    "omnigent:sidebar-view",
    JSON.stringify({ grouping: "default", ordering: "updated", show: [], ...view }),
  );
}

function renderSidebar() {
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
              <Sidebar open={true} onClose={vi.fn()} />
            </CapabilitiesProvider>
          </MemoryRouter>
        </TooltipProvider>
      </SidebarDataProvider>
    </QueryClientProvider>
  );
  const view = render(ui());
  return Object.assign(view, { rerenderSidebar: () => view.rerender(ui()) });
}

function rowItem(name: string): HTMLElement {
  return document.querySelector<HTMLElement>(`li[data-sidebar-session-id="${sid(name)}"]`)!;
}

function rowNames(): string[] {
  return [...document.querySelectorAll("li[data-sidebar-session-id]")].map(
    (li) => ROWS.find((c) => c.id === li.getAttribute("data-sidebar-session-id"))?.title ?? "",
  );
}

function dotOf(name: string): HTMLElement | null {
  return within(rowItem(name)).queryByTestId("ae-family-dot");
}

beforeEach(() => {
  localStorage.clear();
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValue(new Response("{}", { status: 404 }));
  useConvMock.mockImplementation(() => conversationPage(ROWS));
});

afterEach(() => {
  cleanup();
  useConvMock.mockReset();
});

describe("family dots", () => {
  it("marks a lead, its sessions and their forks alike, and nothing else", () => {
    setView({});
    renderSidebar();
    const family = ["Role routing build", "Escalation tool", "Families PR", "Families PR (fork)"];
    const colors = family.map((name) => dotOf(name)?.firstElementChild?.getAttribute("style"));
    expect(colors.every((style) => style && style === colors[0])).toBe(true);
    expect(dotOf("Fabric card speed")).toBeNull();
    expect(dotOf("PASS deck")).toBeNull();
    expect(dotOf("Role routing build")!.getAttribute("aria-label")).toBe(
      "Leads 3 sessions. Show only this family",
    );
    expect(dotOf("Families PR")!.getAttribute("aria-label")).toBe(
      "Started by Role routing build. Show only this family",
    );
    expect(dotOf("Families PR (fork)")!.getAttribute("aria-label")).toBe(
      "Forked from Families PR. Show only this family",
    );
  });

  it("narrows the list to the family on a click, and back on the bar's clear", () => {
    setView({});
    renderSidebar();
    fireEvent.click(dotOf("Families PR")!);
    expect(rowNames()).toEqual([
      "Escalation tool",
      "Families PR",
      "Families PR (fork)",
      "Role routing build",
    ]);
    const bar = screen.getByTestId("ae-family-filter");
    expect(bar.textContent).toContain("Role routing build");
    expect(bar.textContent).toContain("4");
    expect(dotOf("Families PR")!.getAttribute("aria-pressed")).toBe("true");
    // The filter menu moves to the Sessions header while the folders give way.
    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
    expect(screen.getByTestId("session-filter")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ae-family-filter-clear"));
    expect(rowNames()).toHaveLength(ROWS.length);
    expect(screen.queryByTestId("ae-family-filter")).toBeNull();
  });

  it("keeps a double-click on the dot from renaming the row", () => {
    setView({});
    renderSidebar();
    const dot = dotOf("Families PR")!;
    fireEvent.click(dot);
    fireEvent.click(dot);
    fireEvent.doubleClick(dot);
    expect(within(rowItem("Families PR")).queryByRole("textbox")).toBeNull();
  });

  it("drops the narrowing when its family leaves the list", () => {
    setView({});
    const view = renderSidebar();
    fireEvent.click(dotOf("Families PR")!);
    expect(screen.getByTestId("ae-family-filter")).toBeTruthy();
    // The lead and its sessions are archived: no family is left to narrow to.
    useConvMock.mockImplementation(() =>
      conversationPage(
        ROWS.filter(
          (c) =>
            !c.title?.startsWith("Families") &&
            c.title !== "Role routing build" &&
            c.title !== "Escalation tool",
        ),
      ),
    );
    view.rerenderSidebar();
    expect(screen.queryByTestId("ae-family-filter")).toBeNull();
    expect(rowNames()).toEqual(["Fabric card speed", "PASS deck"]);
  });

  it("hides the dots when Show > Family dots is off", () => {
    setView({ familyDots: false });
    renderSidebar();
    expect(screen.queryAllByTestId("ae-family-dot")).toHaveLength(0);
  });
});

describe("Grouping > Family", () => {
  it("lists each family under its lead, lead first, then every other session", () => {
    setView({ grouping: "family" });
    renderSidebar();
    const titles = screen.getAllByTestId("ae-family-title");
    expect(titles).toHaveLength(1);
    expect(titles[0].textContent).toBe("Role routing build4");
    expect(rowNames()).toEqual([
      "Role routing build",
      "Escalation tool",
      "Families PR",
      "Families PR (fork)",
      "Fabric card speed",
      "PASS deck",
    ]);
    const headers = [...document.querySelectorAll("h2 > button")].map((b) => b.textContent);
    expect(headers).toEqual(["Role routing build4", "Sessions"]);
  });
});
