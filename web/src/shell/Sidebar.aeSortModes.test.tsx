// The sidebar's Triage grouping and Manual ordering (omnigent-ae, 2026-10-19),
// with the sidebar_grouping_ui flag on:
//   1. The filter menu offers Triage under Grouping and Manual under Ordering.
//   2. Triage lists Pinned, then one group per status with its glyph, word and
//      count, then a collapsed Archived group that loads only when opened.
//   3. Manual reads the saved order only while it is on, shows rows in it with
//      new sessions on top, and moves rows from the row menu and by drag.
//   4. A filed session dropped on a sibling in its own folder stays filed.

import type * as IdentityModule from "@/lib/identity";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useScopeCache", () => import("@/test/mockScopeCache"));

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  isMobile: false,
  moveToProject: vi.fn(),
  projects: [] as string[],
  folderRows: {} as Record<string, unknown[]>,
  pinned: [] as unknown[],
  archivedFetchNext: vi.fn(),
}));

vi.mock("@/hooks/useIsMobileViewport", () => ({ useIsMobileViewport: () => mocks.isMobile }));
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
      data: { conversations: mocks.pinned, filterHonored: true },
      isSuccess: true,
    }),
    useProjects: () => ({
      data: mocks.projects.map((name) => ({ id: `p_${name}`, name })),
    }),
    useProjectSessions: (project: string, enabled: boolean) => ({
      data: enabled
        ? {
            pages: [
              {
                data: mocks.folderRows[project] ?? [],
                first_id: null,
                last_id: null,
                has_more: false,
              },
            ],
            pageParams: [undefined],
          }
        : undefined,
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    }),
    useMoveToProject: () => ({ mutate: mocks.moveToProject }),
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
import { useAeSidebarStore } from "./aeSidebarStore";
import { Sidebar } from "./Sidebar";

const useConvMock = vi.mocked(useConversations);

let server = { order: [] as string[], revision: 0 };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function sidebarCalls(method: string) {
  return mocks.fetch.mock.calls.filter(
    ([url, init]) =>
      url === "/v1/ae/sidebar" && ((init as RequestInit | undefined)?.method ?? "GET") === method,
  );
}

// Rows are named in the tests; their ids are 32 lowercase hex, as the server's
// are, since only such ids enter the saved order. `temp:` names stay as is.
const NAMES = new Map<string, string>();
function sid(name: string): string {
  if (name.startsWith("temp:")) return name;
  const id = Buffer.from(name).toString("hex").padStart(32, "0");
  NAMES.set(id, name);
  return id;
}
const nameOf = (id: string) => NAMES.get(id) ?? id;

/** The last PUT's order, by row name. */
function lastPut(): { order: string[]; revision: number } {
  const calls = sidebarCalls("PUT");
  const body = JSON.parse(String((calls.at(-1)![1] as RequestInit).body));
  return { ...body, order: body.order.map(nameOf) };
}

function row(name: string, updated: number, extra: Partial<Conversation> = {}): Conversation {
  return conversation(sid(name), {
    title: name,
    updated_at: updated,
    created_at: updated,
    ...extra,
  });
}

function serve(rows: Conversation[], archived: Conversation[] = [], archivedMore = false) {
  useConvMock.mockImplementation((...args: unknown[]) => {
    if (args[4] !== "archived") return conversationPage(rows);
    const page = conversationPage(archived) as unknown as Record<string, unknown>;
    return {
      ...page,
      hasNextPage: archivedMore,
      fetchNextPage: mocks.archivedFetchNext,
    } as unknown as ReturnType<typeof useConversations>;
  });
}

function setView(grouping: string, ordering: string) {
  localStorage.setItem("omnigent:sidebar-view", JSON.stringify({ grouping, ordering, show: [] }));
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

function headerNames(): string[] {
  return [...document.querySelectorAll("h2 > button")].map((button) => button.textContent ?? "");
}

function rowIds(): string[] {
  return [...document.querySelectorAll("li[data-sidebar-session-id]")].map((li) =>
    nameOf(li.getAttribute("data-sidebar-session-id") ?? ""),
  );
}

function rowItem(name: string): HTMLElement {
  return document.querySelector<HTMLElement>(`li[data-sidebar-session-id="${sid(name)}"]`)!;
}

function openRowMenu(id: string) {
  fireEvent.pointerDown(within(rowItem(id)).getByTestId("conversation-actions"), { button: 0 });
}

function openFilterSubmenu(testId: string) {
  fireEvent.pointerDown(screen.getByTestId("session-filter"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.keyDown(screen.getByTestId(testId), { key: "ArrowRight" });
}

// jsdom has no layout, so give each session row a stacked rect for dnd-kit's
// pointer collision; everything else stays zero-sized and never collides.
const ROW_HEIGHT = 30;
function stubRowRects() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const rows = [...document.querySelectorAll("li[data-sidebar-session-id]")];
    const index = rows.indexOf(this);
    if (index < 0) return new DOMRect(0, 0, 0, 0);
    return new DOMRect(0, index * ROW_HEIGHT, 200, ROW_HEIGHT);
  });
}

function rowCenter(id: string) {
  return { clientX: 50, clientY: rowIds().indexOf(id) * ROW_HEIGHT + ROW_HEIGHT / 2 };
}

async function drag(sourceId: string, targetId: string) {
  const start = rowCenter(sourceId);
  const target = rowCenter(targetId);
  fireEvent.mouseDown(rowItem(sourceId), { button: 0, ...start });
  fireEvent.mouseMove(document, { clientX: start.clientX, clientY: start.clientY - 10 });
  await act(async () => {
    fireEvent.mouseMove(document, target);
  });
  const insertion = screen.queryByTestId("ae-order-insertion");
  await act(async () => {
    fireEvent.mouseUp(document, target);
  });
  return insertion;
}

beforeEach(() => {
  localStorage.clear();
  mocks.isMobile = false;
  mocks.projects = [];
  mocks.folderRows = {};
  mocks.pinned = [];
  mocks.moveToProject.mockReset();
  mocks.archivedFetchNext.mockReset();
  server = { order: [], revision: 0 };
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url !== "/v1/ae/sidebar") return json({}, 404);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { order: string[] };
      server = { order: body.order, revision: server.revision + 1 };
    }
    return json(server);
  });
});

afterEach(async () => {
  fireEvent.mouseUp(document);
  cleanup();
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  vi.restoreAllMocks();
  useConvMock.mockReset();
});

describe("filter menu", () => {
  it("offers Triage under Grouping and Manual under Ordering", () => {
    serve([row("a", 3)]);
    renderSidebar();
    openFilterSubmenu("session-grouping-menu");
    expect(screen.getByTestId("session-grouping-triage")).toHaveTextContent("Triage");
    fireEvent.click(screen.getByTestId("session-grouping-triage"));
    expect(JSON.parse(localStorage.getItem("omnigent:sidebar-view")!)).toMatchObject({
      grouping: "triage",
    });
    openFilterSubmenu("session-ordering-menu");
    expect(screen.getByTestId("session-ordering-manual")).toHaveTextContent("Manual");
  });
});

describe("Triage grouping", () => {
  const ROWS = [
    row("w", 9, { labels: { "ae.status": "working" } }),
    row("blk", 8, { labels: { "ae.status": "working" }, pending_elicitations_count: 1 }),
    row("r", 7, { labels: { "ae.status": "review" } }),
    row("n", 6),
    row("p", 5, { labels: { "ae.status": "parked" } }),
    row("ref", 4, { labels: { "ae.status": "reference" } }),
    row("w2", 3, { labels: { "ae.status": "working" } }),
    row("pin", 2, { labels: { "omnigent.pinned": "1" } }),
  ];

  it("lists Pinned, then each status group with its count, then Archived", () => {
    setView("triage", "updated");
    mocks.pinned = [ROWS[7]];
    serve(ROWS);
    renderSidebar();
    expect(headerNames()).toEqual([
      "Pinned",
      "Blocked1",
      "Working2",
      "Review1",
      "No status1",
      "Parked1",
      "Reference1",
      "Archived",
    ]);
    const working = screen.getAllByTestId("ae-triage-title")[1];
    expect(working).toHaveAttribute("data-group", "Working");
    // The glyph is hidden, so the header never reads the status twice.
    expect(within(working).queryByRole("img")).toBeNull();
    expect(working.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(rowIds().slice(0, 3)).toEqual(["pin", "blk", "w"]);
  });

  it("keeps every other grouping's headers as they were", () => {
    setView("status", "updated");
    serve(ROWS);
    renderSidebar();
    expect(screen.queryByTestId("ae-triage-title")).toBeNull();
    expect(screen.queryByRole("button", { name: "Archived" })).toBeNull();
  });

  it("loads archived sessions only once the Archived group opens, and shows more", () => {
    setView("triage", "updated");
    serve([row("a", 3)], [row("old", 1, { archived: true })], true);
    renderSidebar();
    const archivedEnabled = () =>
      useConvMock.mock.calls.some(
        (args) => args[4] === "archived" && (args[2] as { enabled?: boolean })?.enabled === true,
      );
    expect(archivedEnabled()).toBe(false);
    expect(rowIds()).not.toContain("old");
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(archivedEnabled()).toBe(true);
    expect(rowIds()).toContain("old");
    expect(localStorage.getItem("ae.sidebar.archivedOpen")).toBe("open");
    // Tabler history, so it does not read as the Reference group's archive box.
    const glyph = screen.getByRole("button", { name: "Archived" }).querySelector("svg path");
    expect(glyph).toHaveAttribute("d", "M12 8l0 4l2 2");
    fireEvent.click(screen.getByTestId("ae-archived-show-more"));
    expect(mocks.archivedFetchNext).toHaveBeenCalledTimes(1);
  });

  it("hides Archived in selection mode and on the Shared display", () => {
    setView("triage", "updated");
    serve([row("a", 3), row("s", 2, { owner: "other@example.com" })]);
    renderSidebar();
    expect(screen.getByRole("button", { name: "Archived" })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("toggle-selection-mode"));
    expect(screen.queryByRole("button", { name: "Archived" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Exit selection mode" }));
    openFilterSubmenu("session-display-menu");
    fireEvent.click(screen.getByTestId("session-filter-shared"));
    expect(screen.queryByRole("button", { name: "Archived" })).toBeNull();
  });
});

describe("Manual ordering", () => {
  it("reads the saved order only while Manual is on", async () => {
    serve([row("a", 3)]);
    renderSidebar();
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(sidebarCalls("GET")).toHaveLength(0);
    cleanup();
    setView("default", "manual");
    renderSidebar();
    await waitFor(() => expect(sidebarCalls("GET")).toHaveLength(1));
  });

  it("shows rows in the saved order, a session it lacks on top", async () => {
    server = { order: ["c", "a"].map(sid), revision: 3 };
    setView("default", "manual");
    serve([row("a", 3), row("b", 2), row("c", 1)]);
    renderSidebar();
    await waitFor(() => expect(rowIds()).toEqual(["b", "c", "a"]));
  });

  it("moves a row from the menu and saves the order", async () => {
    server = { order: ["a", "b", "c"].map(sid), revision: 3 };
    setView("default", "manual");
    serve([row("a", 3), row("b", 2), row("c", 1)]);
    renderSidebar();
    await waitFor(() => expect(rowIds()).toEqual(["a", "b", "c"]));
    fireEvent.contextMenu(screen.getByRole("link", { name: /^c/ }));
    fireEvent.keyDown(screen.getByTestId("ae-move-menu"), { key: "ArrowRight" });
    const item = (to: string) =>
      screen.getAllByTestId("ae-move-item").find((el) => el.getAttribute("data-move") === to)!;
    expect(item("down")).toHaveAttribute("data-disabled");
    expect(item("bottom")).toHaveAttribute("data-disabled");
    fireEvent.click(item("top"));
    await waitFor(() => expect(rowIds()).toEqual(["c", "a", "b"]));
    await waitFor(() => expect(sidebarCalls("PUT")).toHaveLength(1));
    expect(lastPut()).toEqual({ order: ["c", "a", "b"], revision: 3 });
  });

  it("offers no Move items outside Manual", () => {
    serve([row("a", 3), row("b", 2)]);
    renderSidebar();
    fireEvent.contextMenu(screen.getByRole("link", { name: /^a/ }));
    expect(screen.queryByTestId("ae-move-menu")).toBeNull();
  });

  it("lists the Move items flat under a Move label on a phone", async () => {
    mocks.isMobile = true;
    setView("default", "manual");
    serve([row("a", 3), row("b", 2)]);
    renderSidebar();
    await waitFor(() => expect(useAeSidebarStore.getState().manual).toBe(true));
    openRowMenu("a");
    expect(screen.getByText("Move", { selector: "p" })).toBeInTheDocument();
    expect(screen.getAllByTestId("ae-move-item").map((item) => item.textContent)).toEqual([
      "Move to top",
      "Move up",
      "Move down",
      "Move to bottom",
    ]);
    // Plain items: the Status values stay the menu's only radio items.
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(5);
    fireEvent.click(screen.getByText("Move to bottom"));
    await waitFor(() => expect(rowIds()).toEqual(["b", "a"]));
  });

  it("keeps a session still being created out of the saved order", async () => {
    mocks.isMobile = true;
    setView("default", "manual");
    serve([row("temp:new", 4, { provisional: true }), row("a", 3), row("b", 2)]);
    renderSidebar();
    await waitFor(() => expect(useAeSidebarStore.getState().manual).toBe(true));
    expect(useAeSidebarStore.getState().loadedIds).not.toContain("temp:new");
    openRowMenu("b");
    fireEvent.click(screen.getByText("Move up"));
    await waitFor(() => expect(sidebarCalls("PUT")).toHaveLength(1));
    expect(lastPut().order).toEqual(["b", "a"]);
    // The unsaved row is listed (a provisional row carries no row id attribute).
    expect(screen.getByRole("link", { name: /temp:new/ })).toBeInTheDocument();
    expect(useAeSidebarStore.getState().listOf.get("temp:new")).toBe("sessions");
  });

  it("reorders the Sessions list by drag", async () => {
    stubRowRects();
    setView("default", "manual");
    serve([row("a", 3), row("b", 2), row("c", 1)]);
    renderSidebar();
    await waitFor(() => expect(useAeSidebarStore.getState().listOf.size).toBe(3));
    const insertion = await drag("c", "a");
    expect(insertion).not.toBeNull();
    await waitFor(() => expect(rowIds()).toEqual(["c", "a", "b"]));
    await waitFor(() => expect(sidebarCalls("PUT")).toHaveLength(1));
  });

  it("keeps a filed session in its folder when dropped on a sibling there", async () => {
    stubRowRects();
    mocks.projects = ["Alpha"];
    const filed = [
      row("f1", 3, { labels: { omni_project: "Alpha" } }),
      row("f2", 2, { labels: { omni_project: "Alpha" } }),
    ];
    mocks.folderRows = { Alpha: filed };
    localStorage.setItem("omnigent:expanded-project-sections", JSON.stringify(["Alpha"]));
    setView("default", "manual");
    serve([...filed, row("s1", 1)]);
    renderSidebar();
    await waitFor(() =>
      expect(useAeSidebarStore.getState().listOf.get(sid("f2"))).toBe("folder:Alpha"),
    );
    expect(rowIds().slice(0, 2)).toEqual(["f1", "f2"]);
    await drag("f2", "f1");
    expect(mocks.moveToProject).not.toHaveBeenCalled();
    await waitFor(() => expect(rowIds().slice(0, 2)).toEqual(["f2", "f1"]));
    await waitFor(() => expect(sidebarCalls("PUT")).toHaveLength(1));
  });

  it("does nothing when a row drops on a row in another Triage group", async () => {
    stubRowRects();
    setView("triage", "manual");
    serve([
      row("w", 2, { labels: { "ae.status": "working" } }),
      row("r", 1, { labels: { "ae.status": "review" } }),
    ]);
    renderSidebar();
    await waitFor(() => expect(useAeSidebarStore.getState().listOf.size).toBe(2));
    const insertion = await drag("r", "w");
    expect(insertion).toBeNull();
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(sidebarCalls("PUT")).toHaveLength(0);
    expect(mocks.moveToProject).not.toHaveBeenCalled();
  });
});
