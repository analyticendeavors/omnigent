// The drag handlers' side of Manual ordering: every drop on a row-order target
// is consumed (upstream would read it as the Sessions list and unfile the
// row), and a row-order target in another list never collides.

import type { Over } from "@dnd-kit/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));
vi.mock("@/components/ui/toast", () => ({ showToast: mocks.toast }));

import { resolveSidebarDrop } from "./sidebarNav";
import {
  AE_MANUAL_SWITCH_TOAST,
  aeCancelPendingMoves,
  aeHandleOrderDrop,
  aeInsertionSide,
  aeMoveRow,
  aePlaceOf,
  aePointerWithin,
  useAeSidebarStore,
  useAeSidebarView,
} from "./aeSidebarStore";

const UNITS = [
  [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
  [{ id: "f1" }, { id: "f2" }],
];

const LISTS = new Map([
  ["sessions", ["s1", "s2", "s3"]],
  ["folder:Alpha", ["f1", "f2"]],
]);

function publish(move = vi.fn(() => true)) {
  const listOf = new Map<string, string>();
  for (const [key, ids] of LISTS) for (const id of ids) listOf.set(id, key);
  useAeSidebarStore.setState({
    listed: true,
    manual: true,
    order: [],
    lists: LISTS,
    listOf,
    units: () => UNITS,
    move,
  });
  return move;
}

const over = (data: Record<string, unknown>) => ({ id: "x", data: { current: data } }) as Over;
const orderTarget = (id: string) => over({ type: "ae-order", id });

afterEach(() => {
  useAeSidebarStore.setState({
    listed: false,
    manual: false,
    order: null,
    lists: new Map(),
    listOf: new Map(),
    units: null,
    move: null,
    queryClient: null,
    switchToManual: null,
  });
  aeCancelPendingMoves();
  mocks.fetch.mockReset();
  mocks.toast.mockReset();
});

describe("aeHandleOrderDrop", () => {
  it("leaves every other target to upstream", () => {
    publish();
    expect(aeHandleOrderDrop("f1", null)).toBe(false);
    expect(aeHandleOrderDrop("f1", over({ type: "project", name: "Alpha" }))).toBe(false);
    expect(aeHandleOrderDrop("f1", over({ type: "pin-order", id: "p1" }))).toBe(false);
  });

  it("consumes a drop on a sibling in the row's own folder, which upstream would unfile", () => {
    const move = publish();
    // Without the guard: an unknown target reads as the Sessions list.
    expect(
      resolveSidebarDrop({ id: "f1", project: "Alpha", isPinned: false }, {
        type: "ae-order",
      } as never),
    ).toMatchObject({ kind: "ungroup" });
    expect(aeHandleOrderDrop("f1", orderTarget("f2"))).toBe(true);
    expect(move).toHaveBeenCalledWith({
      kind: "move",
      id: "f1",
      to: { after: "f2" },
      scopeIds: ["f1", "f2"],
      units: UNITS,
    });
  });

  it("drops above a row when dragged up, below it when dragged down", () => {
    const move = publish();
    aeHandleOrderDrop("s3", orderTarget("s1"));
    expect(move).toHaveBeenLastCalledWith(expect.objectContaining({ to: { before: "s1" } }));
    aeHandleOrderDrop("s1", orderTarget("s2"));
    expect(move).toHaveBeenLastCalledWith(expect.objectContaining({ to: { after: "s2" } }));
  });

  it("consumes the row itself, another list's row and a drop with no save path", () => {
    const move = publish();
    expect(aeHandleOrderDrop("s1", orderTarget("s1"))).toBe(true);
    expect(aeHandleOrderDrop("s1", orderTarget("f1"))).toBe(true);
    expect(move).not.toHaveBeenCalled();
    useAeSidebarStore.setState({ move: null });
    expect(aeHandleOrderDrop("s1", orderTarget("s2"))).toBe(true);
    expect(aeMoveRow("s1", "down")).toBe(false);
  });
});

describe("aePointerWithin", () => {
  const rect = (top: number) =>
    ({ top, bottom: top + 30, left: 0, right: 200, width: 200, height: 30 }) as DOMRect;
  const container = (id: string, data: Record<string, unknown>) => ({
    id,
    key: id,
    data: { current: data },
    disabled: false,
    node: { current: null },
    rect: { current: null },
  });

  function collide(activeId: string) {
    const containers = [
      container("ae-order:s2", { type: "ae-order", id: "s2" }),
      container("ae-order:f2", { type: "ae-order", id: "f2" }),
      container("project:Alpha", { type: "project", name: "Alpha" }),
    ];
    const args = {
      active: { id: activeId, data: { current: { type: "session" } } },
      collisionRect: rect(0),
      droppableRects: new Map(containers.map((c) => [c.id, rect(0)])),
      droppableContainers: containers,
      pointerCoordinates: { x: 10, y: 10 },
    } as unknown as Parameters<typeof aePointerWithin>[0];
    return aePointerWithin(args).map((collision) => String(collision.id));
  }

  it("keeps only the dragged row's own list among the row-order targets", () => {
    publish();
    expect(collide("s1").sort()).toEqual(["ae-order:s2", "project:Alpha"]);
    expect(collide("f1").sort()).toEqual(["ae-order:f2", "project:Alpha"]);
  });

  it("keeps the own list's targets outside Manual too", () => {
    publish();
    useAeSidebarStore.setState({ manual: false });
    expect(collide("s1").sort()).toEqual(["ae-order:s2", "project:Alpha"]);
  });

  it("drops every row-order target for a row in no list (pinned, archived)", () => {
    publish();
    expect(collide("pinned-row")).toEqual(["project:Alpha"]);
    useAeSidebarStore.setState({ listed: false, listOf: new Map() });
    expect(collide("s1")).toEqual(["project:Alpha"]);
  });
});

describe("aePlaceOf and aeInsertionSide", () => {
  it("reads a row's place in its list", () => {
    publish();
    const state = useAeSidebarStore.getState();
    expect(aePlaceOf(state, "s1")).toBe("first");
    expect(aePlaceOf(state, "s2")).toBe("middle");
    expect(aePlaceOf(state, "s3")).toBe("last");
    expect(aePlaceOf(state, "missing")).toBeNull();
    expect(aePlaceOf({ ...state, manual: false }, "s1")).toBe("first");
    expect(aePlaceOf({ ...state, listed: false }, "s1")).toBeNull();
    expect(aeInsertionSide("s1", "s3")).toBe("after");
    expect(aeInsertionSide("s3", "s1")).toBe("before");
    expect(aeInsertionSide("s1", "f1")).toBeNull();
  });
});

describe("a move outside Manual", () => {
  const [A, B, C] = ["a", "b", "c"].map((ch) => ch.repeat(32));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  function publishUpdated() {
    const move = vi.fn(() => true);
    const switchToManual = vi.fn(() => useAeSidebarStore.setState({ manual: true }));
    useAeSidebarStore.setState({
      listed: true,
      manual: false,
      order: null,
      lists: new Map([["sessions", [A, B, C]]]),
      listOf: new Map([A, B, C].map((id) => [id, "sessions"])),
      units: () => [[{ id: A }, { id: B }, { id: C }]],
      move,
      queryClient: new QueryClient(),
      switchToManual,
    });
    return { move, switchToManual };
  }

  it("switches to Manual, reads the saved order fresh, then moves", async () => {
    const { move, switchToManual } = publishUpdated();
    mocks.fetch.mockResolvedValue(json({ order: [], revision: 0 }));
    expect(aeHandleOrderDrop(C, orderTarget(A))).toBe(true);
    expect(switchToManual).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith(AE_MANUAL_SWITCH_TOAST);
    expect(move).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move).toHaveBeenCalledWith(expect.objectContaining({ id: C, to: { before: A } }));
  });

  it("switches nothing for a move that changes nothing", () => {
    const { switchToManual } = publishUpdated();
    expect(aeMoveRow(A, "top")).toBe(false);
    expect(aeMoveRow(C, "down")).toBe(false);
    expect(switchToManual).not.toHaveBeenCalled();
  });

  it("chains a later move behind the pending one", async () => {
    const { move } = publishUpdated();
    let answer!: (res: Response) => void;
    mocks.fetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    );
    aeMoveRow(C, "top");
    aeMoveRow(B, "bottom");
    expect(move).not.toHaveBeenCalled();
    answer(json({ order: [], revision: 0 }));
    await vi.waitFor(() => expect(move).toHaveBeenCalledTimes(2));
    expect((move.mock.calls as unknown as [{ id: string }][]).map(([op]) => op.id)).toEqual([C, B]);
  });

  it("drops a pending move when Manual is left, and a failed read with the error toast", async () => {
    const { move } = publishUpdated();
    let answer!: (res: Response) => void;
    mocks.fetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    );
    aeMoveRow(C, "top");
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    aeCancelPendingMoves();
    answer(json({ order: [], revision: 0 }));
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(move).not.toHaveBeenCalled();

    useAeSidebarStore.setState({ manual: false });
    mocks.toast.mockReset();
    mocks.fetch.mockResolvedValueOnce(json({}, 500));
    aeMoveRow(C, "top");
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(2));
    expect(String(mocks.toast.mock.calls[1][0])).toContain("Could not save the session order");
    expect(move).not.toHaveBeenCalled();
  });
});

describe("useAeSidebarView", () => {
  const query = {
    data: undefined,
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    fetchNextPage: vi.fn(),
  } as unknown as Parameters<typeof useAeSidebarView>[0]["conversationsQuery"];

  function listedFor(searchQuery: string, activeTab: "all" | "archived", available: boolean) {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(
      () =>
        useAeSidebarView({
          view: { grouping: "default", ordering: "updated", show: [] },
          orderFrozen: false,
          conversationsQuery: query,
          searchQuery,
          activeTab,
          onViewChange: vi.fn(),
          available,
        }),
      { wrapper },
    );
    return result.current.listed;
  }

  it("lists rows only with the view options on, outside search and the Archived display", () => {
    expect(listedFor("", "all", true)).toBe(true);
    expect(listedFor("fix", "all", true)).toBe(false);
    expect(listedFor("", "archived", true)).toBe(false);
    expect(listedFor("", "all", false)).toBe(false);
  });
});
