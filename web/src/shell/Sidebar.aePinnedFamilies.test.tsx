// Pinned keeps a family's tree (omnigent-ae, 2026-10-31):
//   1. A pinned lead lists its pinned open sessions under it, indented, at the
//      lead's pin slot, whatever the sessions' own pin values.
//   2. A session pinned without its lead stays a flat row.
//   3. A family with every member pinned is gone from Families.
//   4. Dragging a lead moves its whole family; a child is no drop target.
//   5. The lead's chevron folds its pinned sessions away.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarDataProvider } from "@/hooks/useSidebarData";
import { CapabilitiesProvider } from "@/lib/CapabilitiesContext";
import { FALLBACK_SERVER_INFO } from "@/lib/capabilities";
import { resetAeFamilyFoldsCache } from "@/lib/aeFamilyTree";
import { conversation as conv, conversationPage } from "@/test/sidebarMockHelpers";
import { answerPinFamily, usePinFamilyQuestion } from "@/lib/aePinFamilyChoice";
import { resetAePinFamilyForTests } from "./aePinFamily";
import { Sidebar } from "./Sidebar";

vi.mock("@/hooks/useScopeCache", () => import("@/test/mockScopeCache"));

const mocks = vi.hoisted(() => ({
  pinned: [] as ReturnType<typeof conv>[],
  filterHonored: true,
  pinFn: vi.fn(),
  reorderPins: vi.fn(),
  readPage: vi.fn(),
}));

vi.mock("@/hooks/useConversations", async () => {
  const { conversationHooksMock } = await import("@/test/sidebarMockHelpers");
  return {
    ...conversationHooksMock(),
    fetchConversationsPage: mocks.readPage,
    useProjects: vi.fn(() => ({ data: [] })),
    usePinnedConversations: () => ({
      data: { conversations: mocks.pinned, filterHonored: mocks.filterHonored },
      isSuccess: true,
    }),
    useTogglePinnedConversation: () => ({ mutate: vi.fn(), mutateAsync: mocks.pinFn }),
    useReorderPinnedConversations: () => ({ mutate: mocks.reorderPins }),
  };
});
vi.mock("@/components/PermissionsModal", () => ({ PermissionsModal: () => null }));

import { useConversations } from "@/hooks/useConversations";

const ROW_HEIGHT = 30;
const DND_CLICK_GUARD_MS = 60;
const pin = (value: number, extra: Record<string, string> = {}) => ({
  labels: { "omnigent.pinned": String(value), ...extra },
});

function renderTree(grouping = "default") {
  localStorage.setItem(
    "omnigent:sidebar-view",
    JSON.stringify({ grouping, ordering: "updated", show: [] }),
  );
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

const ids = () =>
  [...document.querySelectorAll("li[data-sidebar-session-id]")].map((li) =>
    li.getAttribute("data-sidebar-session-id"),
  );
const rowOf = (id: string) =>
  document.querySelector<HTMLElement>(`li[data-sidebar-session-id="${id}"]`)!;

// jsdom has no layout: stack the session rows for dnd-kit's pointer collision.
function stubRowRects() {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const index = [...document.querySelectorAll("li[data-sidebar-session-id]")].indexOf(this);
    return index < 0
      ? new DOMRect(0, 0, 0, 0)
      : new DOMRect(0, index * ROW_HEIGHT, 200, ROW_HEIGHT);
  });
}

async function drag(sourceId: string, targetId: string) {
  const at = (id: string) => ({ clientX: 50, clientY: ids().indexOf(id) * ROW_HEIGHT + 15 });
  const start = at(sourceId);
  const target = at(targetId);
  fireEvent.mouseDown(rowOf(sourceId), { button: 0, ...start });
  fireEvent.mouseMove(document, { clientX: start.clientX, clientY: start.clientY - 10 });
  await act(async () => {
    fireEvent.mouseMove(document, target);
  });
  const insertion = screen.queryByTestId("pin-order-insertion") !== null;
  await act(async () => {
    fireEvent.mouseUp(document, target);
  });
  // dnd-kit keeps a document click guard for 50 ms after a drag ends; wait it out so
  // the next click, even in the next test, is not swallowed.
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, DND_CLICK_GUARD_MS);
    });
  });
  return insertion;
}

beforeEach(() => {
  localStorage.clear();
  resetAeFamilyFoldsCache();
  resetAePinFamilyForTests();
  mocks.filterHonored = true;
  // The lead (pinned first), a solo pin, then the lead's child pinned last.
  mocks.pinned = [
    conv("lead", pin(1000)),
    conv("solo", pin(1001)),
    conv("kid", pin(1002, { "ae.orch": "lead" })),
  ];
  vi.mocked(useConversations).mockImplementation(() => conversationPage([conv("other")]));
  stubRowRects();
});

afterEach(() => {
  fireEvent.mouseUp(document);
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Pinned families", () => {
  it("lists a pinned lead's pinned session under it, indented, at the lead's slot", () => {
    renderTree();
    expect(ids().slice(0, 3)).toEqual(["lead", "kid", "solo"]);
    expect(within(rowOf("kid")).getByTestId("ae-family-indent")).toHaveAttribute("data-depth", "1");
    expect(within(rowOf("solo")).queryByTestId("ae-family-indent")).toBeNull();
    expect(within(rowOf("lead")).queryByTestId("ae-family-indent")).toBeNull();
  });

  it("keeps a session pinned without its lead as a flat row", () => {
    mocks.pinned = [conv("solo", pin(1001)), conv("kid", pin(1002, { "ae.orch": "lead" }))];
    vi.mocked(useConversations).mockImplementation(() =>
      conversationPage([conv("lead"), conv("other")]),
    );
    renderTree();
    expect(ids().slice(0, 2)).toEqual(["solo", "kid"]);
    expect(within(rowOf("kid")).queryByTestId("ae-family-indent")).toBeNull();
  });

  it("takes a fully pinned family out of Families", () => {
    vi.mocked(useConversations).mockImplementation(() =>
      conversationPage([conv("other"), conv("kid", { labels: { "ae.orch": "lead" } })]),
    );
    renderTree("family");
    expect(ids().filter((id) => id === "lead" || id === "kid")).toEqual(["lead", "kid"]);
    expect(document.querySelector('[data-section="Families"]')).toHaveTextContent("Families0");
    expect(ids().filter((id) => id === "kid")).toHaveLength(1);
  });

  it("moves the whole family when its lead is dragged, and takes no drop on a child", async () => {
    renderTree();
    expect(await drag("solo", "kid")).toBe(false);
    expect(mocks.reorderPins).not.toHaveBeenCalled();

    expect(await drag("lead", "solo")).toBe(true);
    // The lead's pinned session follows it, below the lead's new value.
    expect(mocks.reorderPins).toHaveBeenCalledExactlyOnceWith([
      { id: "lead", pinnedAt: 1002 },
      { id: "kid", pinnedAt: 1003 },
    ]);
  });

  it("folds a pinned lead's sessions away from its chevron", () => {
    renderTree();
    fireEvent.click(within(rowOf("lead")).getByTestId("ae-family-fold"));
    expect(ids().slice(0, 2)).toEqual(["lead", "solo"]);
    expect(rowOf("kid")).toBeNull();
  });

  it("asks, and lands the whole family at the drop spot, when a lead is dropped on a pinned row", async () => {
    window.localStorage.setItem("omnigent:ae-pin-family", "ask");
    const lead2 = conv("lead2");
    const kid2 = conv("kid2", { labels: { "ae.orch": "lead2", "ae.status": "working" } });
    vi.mocked(useConversations).mockImplementation(() =>
      conversationPage([lead2, kid2, conv("other")]),
    );
    mocks.readPage.mockImplementation(async ({ visibility }: { visibility?: string }) => ({
      data: visibility === "archived" ? [] : [lead2, kid2],
      has_more: false,
      last_id: null,
    }));
    mocks.pinFn.mockResolvedValue({});
    renderTree();
    const question = renderHook(() => usePinFamilyQuestion());
    await drag("lead2", "solo");
    await waitFor(() => expect(question.result.current?.action).toBe("pin"));
    expect(mocks.pinFn).not.toHaveBeenCalled();
    act(() => answerPinFamily("family"));
    await waitFor(() => expect(mocks.pinFn).toHaveBeenCalledTimes(2));
    const [lead, kid] = mocks.pinFn.mock.calls.map(([w]) => w);
    expect(lead).toEqual({ id: "lead2", pinned: true, pinnedAt: 1000.5 });
    expect(kid.id).toBe("kid2");
    expect(kid.pinnedAt).toBeGreaterThan(1000.5);
    expect(kid.pinnedAt).toBeLessThan(1001);
  });

  it("keeps a pinned session fixed under its lead even when reordering is off", async () => {
    mocks.filterHonored = false;
    renderTree();
    expect(await drag("kid", "solo")).toBe(false);
    expect(mocks.reorderPins).not.toHaveBeenCalled();
    expect(mocks.pinFn).not.toHaveBeenCalled();
  });
});
