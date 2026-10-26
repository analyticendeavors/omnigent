// Session families in the sidebar (omnigent-ae, 2026-10-23), with the
// sidebar_grouping_ui flag on:
//   1. A lead and the sessions it started (ae.orch), and forks of them, carry
//      one colored dot; other rows carry none.
//   2. A dot narrows the list to its family without opening the session.
//   3. Grouping > Family lists "Families" (each lead with its sessions as a
//      tree, foldable from the lead's chevron) then "Standalone".
//   4. Show > Family dots turns the dots off.
//   5. A lead row shows only its name and chevron; the family's cost and
//      session count are in its hover card (2026-10-25).
//   6. Archiving a lead archives its sessions, asking first while one is open.

import type * as IdentityModule from "@/lib/identity";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionDrafts, setSessionDraft } from "@/lib/sessionDrafts";

vi.mock("@/hooks/useScopeCache", () => import("@/test/mockScopeCache"));

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  archived: vi.fn(),
  archiveOne: vi.fn(),
  archiveMany: vi.fn(),
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

function rowItem(name: string): HTMLElement {
  return document.querySelector<HTMLElement>(`li[data-sidebar-session-id="${sid(name)}"]`)!;
}

function rowNames(): string[] {
  return [...document.querySelectorAll("li[data-sidebar-session-id]")].map(
    (li) => ROWS.find((c) => c.id === li.getAttribute("data-sidebar-session-id"))?.title ?? "",
  );
}

/**
 * Hovers a lead's row and returns its hover card's family block, once its
 * `field` (sessions or spend) reads `text`, label and value run together.
 */
async function familyBlock(name: string, field: string, text: string): Promise<HTMLElement> {
  const link = rowItem(name).querySelector<HTMLElement>(`a[href="/c/${sid(name)}"]`)!;
  fireEvent.pointerMove(link, { pointerType: "mouse" });
  const card = await screen.findByTestId("session-tooltip-content");
  const block = await within(card).findByTestId("ae-hover-family");
  await waitFor(() =>
    expect(within(block).queryByTestId(`ae-hover-family-${field}`)?.textContent).toBe(text),
  );
  return block;
}

function dotOf(name: string): HTMLElement | null {
  return within(rowItem(name)).queryByTestId("ae-family-dot");
}

beforeEach(() => {
  localStorage.clear();
  // These cases cover cost mode; tokens is the default.
  window.localStorage.setItem("omnigent:ae-spend-display", "cost");
  resetAeFamilyFoldsCache();
  resetAeFamilyClosedCache();
  mocks.archived.mockReset();
  mocks.archived.mockResolvedValue({ data: [] });
  mocks.archiveOne.mockReset();
  mocks.archiveMany.mockReset();
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
  function sections(): (string | null)[] {
    return screen.getAllByTestId("ae-family-section").map((el) => el.textContent);
  }

  it("lists families first as tree rows, then every other session", () => {
    setView({ grouping: "family" });
    renderSidebar();
    expect(sections()).toEqual(["Families1", "Standalone2"]);
    expect(rowNames()).toEqual([
      "Role routing build",
      "Escalation tool",
      "Families PR",
      "Families PR (fork)",
      "Fabric card speed",
      "PASS deck",
    ]);
    // The lead keeps its dot; lines and indent replace the dots on its sessions.
    expect(dotOf("Role routing build")).not.toBeNull();
    expect(dotOf("Escalation tool")).toBeNull();
    const depth = (name: string) =>
      within(rowItem(name)).queryByTestId("ae-family-indent")?.getAttribute("data-depth");
    expect(depth("Escalation tool")).toBe("1");
    expect(depth("Families PR (fork)")).toBe("2");
    expect(depth("Fabric card speed")).toBeUndefined();
  });

  it("shows the family's cost and open count on the lead's hover card and a role chip on a child", async () => {
    useConvMock.mockImplementation(() =>
      conversationPage([
        row("Escalation tool", 60, { "ae.orch": sid("Role routing build"), "ae.role": "builder" }),
        ...ROWS.slice(1),
      ]),
    );
    mocks.fetch.mockImplementation((input: unknown) =>
      Promise.resolve(
        String(input).startsWith("/v1/sessions/")
          ? new Response(
              JSON.stringify({
                usage_by_model: {
                  "claude-sonnet-5-5": { total_cost_usd: 1.5 },
                },
              }),
            )
          : new Response("{}", { status: 404 }),
      ),
    );
    setView({ grouping: "family" });
    renderSidebar();
    const badge = within(rowItem("Escalation tool")).getByTestId("ae-family-role");
    expect(badge.textContent).toBe("B");
    expect(badge.getAttribute("title")).toBe("Builder");
    expect(within(rowItem("Families PR")).queryByTestId("ae-family-role")).toBeNull();
    // Lead plus its three listed sessions at $1.50 each (cost only, as Claude reports).
    const block = await familyBlock("Role routing build", "spend", "Cost$6.00");
    expect(within(block).getByTestId("ae-hover-family-sessions").textContent).toBe(
      "Sessions3 open",
    );
  });

  it.each([
    ["planner", "P", "Planner"],
    ["reviewer", "R", "Reviewer"],
    ["helper", "H", "Helper"],
    ["lead", "L", "Lead"],
  ])("shows %s as the letter %s on a child", (role, letter, name) => {
    useConvMock.mockImplementation(() =>
      conversationPage([
        row("Escalation tool", 60, { "ae.orch": sid("Role routing build"), "ae.role": role }),
        ...ROWS.slice(1),
      ]),
    );
    setView({ grouping: "family" });
    renderSidebar();
    const badge = within(rowItem("Escalation tool")).getByTestId("ae-family-role");
    expect(badge.textContent).toBe(letter);
    expect(badge.getAttribute("title")).toBe(name);
  });

  it("shows only the name and a bare chevron on the lead row, never a cost or count pill", async () => {
    mocks.fetch.mockImplementation((input: unknown) =>
      Promise.resolve(
        String(input).startsWith("/v1/sessions/")
          ? new Response(JSON.stringify({ usage_by_model: { m: { total_cost_usd: 1 } } }))
          : new Response("{}", { status: 404 }),
      ),
    );
    setView({ grouping: "family" });
    renderSidebar();
    const lead = rowItem("Role routing build");
    await familyBlock("Role routing build", "spend", "Cost$4.00");
    const chevron = within(lead).getByTestId("ae-family-fold");
    expect(chevron.textContent).toBe("");
    expect(chevron.getAttribute("aria-label")).toBe("Hide 3 sessions");
    const link = lead.querySelector<HTMLElement>(`a[href="/c/${sid("Role routing build")}"]`)!;
    expect(link.textContent).toBe("Role routing build");
  });

  describe("raise arrow", () => {
    const RAISED = {
      "ae.orch": sid("Role routing build"),
      "ae.model_start": "claude-sonnet-5-5|medium",
      "ae.raises": "1",
      "ae.raise_cap": "1",
    };

    function runsOn(model: string, effort: string) {
      mocks.fetch.mockImplementation((input: unknown) =>
        Promise.resolve(
          String(input).startsWith("/v1/sessions/")
            ? new Response(JSON.stringify({ llm_model: model, reasoning_effort: effort }))
            : new Response("{}", { status: 404 }),
        ),
      );
    }

    function withRaised() {
      useConvMock.mockImplementation(() =>
        conversationPage([row("Escalation tool", 60, RAISED), ...ROWS.slice(1)]),
      );
      setView({ grouping: "family" });
    }

    it("shows an amber arrow naming the start and the limit while the helper runs above its start", async () => {
      runsOn("claude-opus-4-8", "high");
      withRaised();
      renderSidebar();
      const line = await within(rowItem("Escalation tool")).findByTestId("ae-family-raise-line");
      expect(line.textContent).toBe("");
      expect(line.getAttribute("title")).toBe("Raise limit reached (1 of 1)");
      expect(within(rowItem("Escalation tool")).queryByText(/cap reached/)).toBeNull();
    });

    it("names where the helper started and the raises used against the limit", async () => {
      runsOn("claude-opus-4-8", "high");
      useConvMock.mockImplementation(() =>
        conversationPage([
          row("Escalation tool", 60, { ...RAISED, "ae.raise_cap": "2" }),
          ...ROWS.slice(1),
        ]),
      );
      setView({ grouping: "family" });
      renderSidebar();
      const line = await within(rowItem("Escalation tool")).findByTestId("ae-family-raise-line");
      expect(line.getAttribute("data-cap-reached")).toBe("false");
      expect(line.getAttribute("title")).toBe("Raised from Sonnet medium (1 of 2)");
    });

    it("hides the line once the helper is back at its start", async () => {
      runsOn("claude-sonnet-5-5", "medium");
      withRaised();
      renderSidebar();
      await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(within(rowItem("Escalation tool")).queryByTestId("ae-family-raise-line")).toBeNull();
    });

    it("shows nothing for a member without a start label", async () => {
      runsOn("claude-opus-4-8", "high");
      withRaised();
      renderSidebar();
      await within(rowItem("Escalation tool")).findByTestId("ae-family-raise-line");
      expect(within(rowItem("Families PR")).queryByTestId("ae-family-raise-line")).toBeNull();
    });
  });

  it("reserves pr-7 for a Family row's marker and keeps pr-8 elsewhere", () => {
    // A draft puts a marker on the row, so it has a trailing indicator.
    setSessionDraft(sid("Escalation tool"), { text: "x", files: [] });
    setSessionDraft(sid("Fabric card speed"), { text: "x", files: [] });
    const reserve = (name: string) =>
      rowItem(name).querySelector<HTMLElement>(`a[href="/c/${sid(name)}"]`)!.className;
    useConvMock.mockImplementation(() => conversationPage(ROWS));
    setView({ grouping: "family" });
    renderSidebar();
    expect(reserve("Escalation tool")).toMatch(/(^|\s)pr-7(\s|$)/);
    expect(reserve("Fabric card speed")).toMatch(/(^|\s)pr-8(\s|$)/);
    clearSessionDrafts();
  });

  describe("spend setting", () => {
    function tokenUsage() {
      useConvMock.mockImplementation(() => conversationPage(ROWS));
      mocks.fetch.mockImplementation((input: unknown) =>
        Promise.resolve(
          String(input).startsWith("/v1/sessions/")
            ? new Response(
                JSON.stringify({
                  usage_by_model: {
                    "gpt-5.5": { input_tokens: 90_000, output_tokens: 10_000, total_cost_usd: 2 },
                  },
                }),
              )
            : new Response("{}", { status: 404 }),
        ),
      );
      setView({ grouping: "family" });
    }

    it("shows the family's tokens on the hover card in tokens mode", async () => {
      window.localStorage.setItem("omnigent:ae-spend-display", "tokens");
      tokenUsage();
      renderSidebar();
      await familyBlock("Role routing build", "spend", "Tokens400k");
    });

    it("shows no family total on the hover card when off", async () => {
      window.localStorage.setItem("omnigent:ae-spend-display", "off");
      tokenUsage();
      renderSidebar();
      const block = await familyBlock("Role routing build", "sessions", "Sessions3 open");
      await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
      expect(within(block).queryByTestId("ae-hover-family-spend")).toBeNull();
    });
  });

  it("falls back to tokens on the hover card when no cost is reported", async () => {
    useConvMock.mockImplementation(() => conversationPage(ROWS));
    mocks.fetch.mockImplementation((input: unknown) =>
      Promise.resolve(
        String(input).startsWith("/v1/sessions/")
          ? new Response(
              JSON.stringify({
                usage_by_model: {
                  "gpt-5.5": { input_tokens: 90_000, output_tokens: 10_000 },
                },
              }),
            )
          : new Response("{}", { status: 404 }),
      ),
    );
    setView({ grouping: "family" });
    renderSidebar();
    await familyBlock("Role routing build", "spend", "Tokens400k");
  });

  it("badges a folded lead's chevron with its open count, pink when one waits on you", () => {
    useConvMock.mockImplementation(() =>
      conversationPage(
        ROWS.map((c) => (c.title === "Families PR" ? { ...c, pending_elicitations_count: 1 } : c)),
      ),
    );
    setView({ grouping: "family" });
    renderSidebar();
    const chevron = () => within(rowItem("Role routing build")).getByTestId("ae-family-fold");
    // Open families show their rows, so no badge.
    expect(within(chevron()).queryByTestId("ae-family-fold-count")).toBeNull();
    fireEvent.click(chevron());
    const badge = within(chevron()).getByTestId("ae-family-fold-count");
    expect(badge.textContent).toBe("3");
    expect(badge.getAttribute("data-waiting")).toBe("true");
    expect(chevron().getAttribute("aria-label")).toBe("Show 3 sessions, one waits on you");
  });

  it("folds a family from the lead's chevron and remembers it", () => {
    setView({ grouping: "family" });
    const view = renderSidebar();
    const pill = within(rowItem("Role routing build")).getByTestId("ae-family-fold");
    expect(pill.getAttribute("title")).toBe("Hide 3 sessions");
    fireEvent.click(pill);
    expect(rowNames()).toEqual(["Role routing build", "Fabric card speed", "PASS deck"]);
    expect(JSON.parse(localStorage.getItem("omnigent:ae-family-folds")!)).toEqual([
      sid("Role routing build"),
    ]);
    view.rerenderSidebar();
    expect(rowNames()).toHaveLength(3);
    fireEvent.click(within(rowItem("Role routing build")).getByTestId("ae-family-fold"));
    expect(rowNames()).toHaveLength(6);
  });

  describe("closed rows", () => {
    const lead = sid("Role routing build");
    const ref = (name: string, updated: number) =>
      row(name, updated, { "ae.orch": lead, "ae.status": "reference" });
    const withClosed = (...extra: Conversation[]) =>
      useConvMock.mockImplementation(() => conversationPage([...ROWS, ...extra]));
    const closedNames = () =>
      [...document.querySelectorAll('[data-testid="ae-family-closed-row"]')].map(
        (li) => li.textContent,
      );

    it("folds a reference child into '1 closed', keeps a review child, and remembers opening it", async () => {
      withClosed(
        ref("Old helper", 5),
        row("Done helper", 6, { "ae.orch": lead, "ae.status": "review" }),
      );
      setView({ grouping: "family" });
      const view = renderSidebar();
      const pill = within(rowItem("Role routing build")).getByTestId("ae-family-fold");
      expect(pill.textContent).toBe("");
      expect(pill.getAttribute("title")).toBe(
        "5 sessions: 3 working, 1 done waiting for your read, 1 closed",
      );
      expect(rowItem("Done helper")).toBeTruthy();
      expect(rowItem("Old helper")).toBeNull();
      const fold = screen.getByTestId("ae-family-closed-fold");
      expect(fold.textContent).toBe("1 closed");
      expect(closedNames()).toEqual([]);
      fireEvent.click(within(fold).getByRole("button"));
      expect(closedNames()).toEqual(["Old helper"]);
      view.rerenderSidebar();
      expect(closedNames()).toEqual(["Old helper"]);
      expect(JSON.parse(localStorage.getItem("omnigent:ae-family-closed-open")!)).toEqual([lead]);
      await familyBlock("Role routing build", "sessions", "Sessions4 open \u00b7 1 closed");
    });

    it("gives a closed row the same hover card as an open one", async () => {
      withClosed(ref("Old helper", 5));
      localStorage.setItem("omnigent:ae-family-closed-open", JSON.stringify([lead]));
      setView({ grouping: "family" });
      renderSidebar();
      const link = screen.getByTestId("ae-family-closed-row").querySelector("a")!;
      fireEvent.pointerMove(link, { pointerType: "mouse" });
      const card = await screen.findByTestId("session-tooltip-content");
      expect(card.textContent).toContain("Old helper");
    });

    it("says a closed session stopped with an error on its hover card", async () => {
      withClosed({ ...ref("Old helper", 5), status: "failed" });
      localStorage.setItem("omnigent:ae-family-closed-open", JSON.stringify([lead]));
      setView({ grouping: "family" });
      renderSidebar();
      const link = screen.getByTestId("ae-family-closed-row").querySelector("a")!;
      fireEvent.pointerMove(link, { pointerType: "mouse" });
      const card = await screen.findByTestId("session-tooltip-content");
      expect(card.textContent).toContain("Stopped with an error");
    });

    it("badges a folded family with only its open count, not the closed ones", () => {
      withClosed(ref("Old helper", 5));
      localStorage.setItem("omnigent:ae-family-folds", JSON.stringify([lead]));
      setView({ grouping: "family" });
      renderSidebar();
      const chevron = within(rowItem("Role routing build")).getByTestId("ae-family-fold");
      expect(within(chevron).getByTestId("ae-family-fold-count").textContent).toBe("3");
      expect(chevron.getAttribute("aria-label")).toBe("Show 4 sessions, 3 open");
    });

    it("counts archived children and lists them with the open group", async () => {
      mocks.archived.mockResolvedValue({
        data: [
          { ...row("Archived one", 9, { "ae.orch": lead }), archived: true },
          { ...row("Archived two", 3, { "ae.orch": lead }), archived: true },
        ],
      });
      withClosed(ref("Old helper", 5));
      localStorage.setItem("omnigent:ae-family-closed-open", JSON.stringify([lead]));
      setView({ grouping: "family" });
      renderSidebar();
      await screen.findByText("Archived one");
      expect(closedNames()).toEqual(["Archived one", "Old helper", "Archived two"]);
      expect(
        within(rowItem("Role routing build")).getByTestId("ae-family-fold").getAttribute("title"),
      ).toBe("6 sessions: 3 working, 3 closed (2 archived)");
    });

    it("shows five closed rows, then reveals the rest from 'Show N more'", () => {
      withClosed(...Array.from({ length: 7 }, (_, i) => ref(`Helper ${i}`, 30 - i)));
      localStorage.setItem("omnigent:ae-family-closed-open", JSON.stringify([lead]));
      setView({ grouping: "family" });
      renderSidebar();
      expect(closedNames()).toHaveLength(5);
      const more = screen.getByTestId("ae-family-closed-more");
      expect(more.textContent).toBe("Show 2 more");
      fireEvent.click(within(more).getByRole("button"));
      expect(closedNames()).toHaveLength(7);
      expect(screen.queryByTestId("ae-family-closed-more")).toBeNull();
    });

    it("adds the cap note to the pill title and asks for archived sessions only in Family grouping", async () => {
      let n = 0;
      mocks.archived.mockImplementation(async () => {
        n += 1;
        return { data: [], last_id: `p${n}`, has_more: true };
      });
      setView({ grouping: "family" });
      renderSidebar();
      await waitFor(() =>
        expect(
          within(rowItem("Role routing build")).getByTestId("ae-family-fold").getAttribute("title"),
        ).toBe("Hide 3 sessions (older archived not counted)"),
      );
      expect(mocks.archived.mock.calls[0][0]).toMatchObject({ visibility: "archived", limit: 200 });
      cleanup();
      mocks.archived.mockClear();
      setView({ grouping: "default" });
      renderSidebar();
      expect(mocks.archived).not.toHaveBeenCalled();
    });

    it("leaves a family with no closed members as it was", () => {
      setView({ grouping: "family" });
      renderSidebar();
      expect(screen.queryByTestId("ae-family-closed-fold")).toBeNull();
      expect(
        within(rowItem("Role routing build")).getByTestId("ae-family-fold").getAttribute("title"),
      ).toBe("Hide 3 sessions");
    });
  });

  it("says how a family forms while none shows", () => {
    useConvMock.mockImplementation(() =>
      conversationPage(
        ROWS.filter((c) => !c.labels?.["ae.orch"] && !c.labels?.["omnigent.fork.source_id"]),
      ),
    );
    setView({ grouping: "family" });
    renderSidebar();
    expect(sections()).toEqual(["Families0", "Standalone3"]);
    expect(screen.getByTestId("ae-families-hint")).toBeTruthy();
  });

  it("stands in for a lead that is not loaded, keeping its session out of the rest", () => {
    useConvMock.mockImplementation(() =>
      conversationPage(ROWS.filter((c) => c.title !== "Role routing build")),
    );
    setView({ grouping: "family" });
    renderSidebar();
    expect(screen.getByTestId("ae-family-stand-in").textContent).toContain("Lead not loaded");
    expect(rowNames().slice(0, 3)).toEqual([
      "Escalation tool",
      "Families PR",
      "Families PR (fork)",
    ]);
  });

  const withoutLead = () =>
    useConvMock.mockImplementation(() =>
      conversationPage(ROWS.filter((c) => c.title !== "Role routing build")),
    );

  it("lists only the stand-in while its family is folded, never the hidden session", () => {
    withoutLead();
    localStorage.setItem("omnigent:ae-family-folds", JSON.stringify([sid("Role routing build")]));
    setView({ grouping: "family" });
    renderSidebar();
    const standIn = screen.getByTestId("ae-family-stand-in");
    expect(within(standIn).getByTestId("ae-family-fold").getAttribute("title")).toBe(
      "Show 3 sessions",
    );
    expect(rowNames()).toEqual(["Fabric card speed", "PASS deck"]);
  });

  it("narrows to a stand-in family from its dot", () => {
    withoutLead();
    setView({ grouping: "family" });
    renderSidebar();
    fireEvent.click(within(screen.getByTestId("ae-family-stand-in")).getByTestId("ae-family-dot"));
    expect(screen.getByTestId("ae-family-filter")).toBeTruthy();
    expect(rowNames()).toEqual(["Escalation tool", "Families PR", "Families PR (fork)"]);
  });

  it("closes the phone drawer when the stand-in lead is tapped", () => {
    withoutLead();
    setView({ grouping: "family" });
    const matchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never;
    try {
      const onClose = vi.fn();
      renderSidebar(onClose);
      fireEvent.click(within(screen.getByTestId("ae-family-stand-in")).getByRole("link"));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  describe("archive cascade", () => {
    const lead = sid("Role routing build");
    const mine = (c: Conversation): Conversation => ({ ...c, owner: "viewer@example.com" });
    const child = (name: string, status: string, parent = lead) =>
      mine(row(name, 50, { "ae.orch": parent, "ae.status": status }));
    /** *listed* are the sidebar's rows; the archive reads them plus *unlisted* from the server. */
    const family = (listed: Conversation[], unlisted: Conversation[] = []) => {
      const rows = [...listed, mine(row("PASS deck", 20)), mine(row("Role routing build", 10))];
      useConvMock.mockImplementation(() => conversationPage(rows));
      mocks.archived.mockImplementation(async ({ visibility }: { visibility?: string }) =>
        visibility === "archived"
          ? { data: [] }
          : { data: [...rows, ...unlisted], has_more: false, last_id: null },
      );
      setView({ grouping: "family" });
    };
    const archivedIds = () => mocks.archiveMany.mock.calls[0][0].ids;

    function rightClickArchive(name: string) {
      const link = rowItem(name).querySelector<HTMLElement>(`a[href="/c/${sid(name)}"]`)!;
      fireEvent.contextMenu(link);
      fireEvent.click(screen.getByTestId("archive-conversation"));
    }

    beforeEach(() => mocks.archiveMany.mockResolvedValue([]));

    it("archives every child at once when all are in the closed group, grandchildren too", async () => {
      family([
        child("Escalation tool", "reference"),
        child("Families PR", "reference"),
        child("Nested helper", "reference", sid("Families PR")),
      ]);
      renderSidebar();
      rightClickArchive("Role routing build");
      await waitFor(() => expect(mocks.archiveMany).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId("ae-family-archive-confirm")).toBeNull();
      expect(archivedIds()).toEqual([
        lead,
        sid("Escalation tool"),
        sid("Families PR"),
        sid("Nested helper"),
      ]);
      expect(mocks.archiveMany.mock.calls[0][0].archived).toBe(true);
      expect(mocks.archiveOne).not.toHaveBeenCalled();
    });

    it("asks first while a child is open, then archives them all", async () => {
      family([child("Escalation tool", "reference"), child("Families PR", "working")]);
      renderSidebar();
      rightClickArchive("Role routing build");
      const confirm = await screen.findByTestId("ae-family-archive-confirm");
      expect(confirm.textContent).toContain(
        "Are you sure you would like to archive this? There are still open sessions.",
      );
      expect(mocks.archiveMany).not.toHaveBeenCalled();
      fireEvent.click(within(confirm).getByRole("button", { name: "Archive" }));
      expect(mocks.archiveMany).toHaveBeenCalledTimes(1);
      expect(archivedIds()).toEqual([lead, sid("Escalation tool"), sid("Families PR")]);
    });

    it("finds an open child the sidebar has not loaded, and asks first", async () => {
      family([child("Escalation tool", "reference")], [child("Older helper", "working")]);
      renderSidebar();
      rightClickArchive("Role routing build");
      const confirm = await screen.findByTestId("ae-family-archive-confirm");
      fireEvent.click(within(confirm).getByRole("button", { name: "Archive" }));
      expect(archivedIds()).toEqual([lead, sid("Escalation tool"), sid("Older helper")]);
    });

    it("archives nothing when the confirm is cancelled", async () => {
      family([child("Escalation tool", "working"), child("Families PR", "working")]);
      renderSidebar();
      rightClickArchive("Role routing build");
      const confirm = await screen.findByTestId("ae-family-archive-confirm");
      fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByTestId("ae-family-archive-confirm")).toBeNull());
      expect(mocks.archiveMany).not.toHaveBeenCalled();
      expect(mocks.archiveOne).not.toHaveBeenCalled();
    });

    it("archives a session with no family alone", () => {
      family([child("Escalation tool", "working"), child("Families PR", "working")]);
      renderSidebar();
      rightClickArchive("PASS deck");
      expect(mocks.archiveOne).toHaveBeenCalledTimes(1);
      expect(mocks.archiveMany).not.toHaveBeenCalled();
    });
  });
});
