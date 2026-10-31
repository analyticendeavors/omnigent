// Pinned keeps a family's tree (omnigent-ae, 2026-10-31):
//   1. A pinned lead lists its pinned open sessions under it, indented, at the
//      lead's pin slot, whatever the sessions' own pin values.
//   2. A session pinned without its lead stays a flat row.
//   3. A family with every member pinned is gone from Families.
//   4. Dragging a lead moves its whole family; a child is no drop target.
//   5. The lead's chevron folds its pinned sessions away.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarDataProvider } from "@/hooks/useSidebarData";
import { CapabilitiesProvider } from "@/lib/CapabilitiesContext";
import { FALLBACK_SERVER_INFO } from "@/lib/capabilities";
import { resetAeFamilyFoldsCache } from "@/lib/aeFamilyTree";
import { conversation as conv, conversationPage } from "@/test/sidebarMockHelpers";
import { Sidebar } from "./Sidebar";

vi.mock("@/hooks/useScopeCache", () => import("@/test/mockScopeCache"));

const mocks = vi.hoisted(() => ({
  pinned: [] as ReturnType<typeof conv>[],
  pinFn: vi.fn(),
  reorderPins: vi.fn(),
}));

vi.mock("@/hooks/useConversations", async () => {
  const { conversationHooksMock } = await import("@/test/sidebarMockHelpers");
  return {
    ...conversationHooksMock(),
    useProjects: vi.fn(() => ({ data: [] })),
    usePinnedConversations: () => ({
      data: { conversations: mocks.pinned, filterHonored: true },
      isSuccess: true,
    }),
    useTogglePinnedConversation: () => ({ mutate: vi.fn(), mutateAsync: mocks.pinFn }),
    useReorderPinnedConversations: () => ({ mutate: mocks.reorderPins }),
  };
});
vi.mock("@/components/PermissionsModal", () => ({ PermissionsModal: () => null }));

import { useConversations } from "@/hooks/useConversations";

const ROW_HEIGHT = 30;
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
  return insertion;
}

beforeEach(() => {
  localStorage.clear();
  resetAeFamilyFoldsCache();
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
    expect(mocks.reorderPins).toHaveBeenCalledExactlyOnceWith([{ id: "lead", pinnedAt: 1002 }]);
  });

  it("folds a pinned lead's sessions away from its chevron", () => {
    renderTree();
    fireEvent.click(within(rowOf("lead")).getByTestId("ae-family-fold"));
    expect(ids().slice(0, 2)).toEqual(["lead", "solo"]);
    expect(rowOf("kid")).toBeNull();
  });
});
