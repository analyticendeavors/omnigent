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
  aeCrossMove,
  aeEndDrag,
  aeHandleOrderDrop,
  aeInsertionSide,
  aeMoveRow,
  aePlaceOf,
  aePointerWithin,
  aeTrackDragMove,
  useAePublishSidebarScopes,
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
    triage: false,
    frozenTriage: null,
    crossSide: null,
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

  it("consumes the row itself, a row it cannot move to and a drop with no save path", () => {
    const move = publish();
    expect(aeHandleOrderDrop("s1", orderTarget("s1"))).toBe(true);
    useAeSidebarStore.setState({
      lists: new Map([...LISTS, ["shared", ["x1"]]]),
      listOf: new Map([...useAeSidebarStore.getState().listOf, ["x1", "shared"]]),
    });
    expect(aeHandleOrderDrop("s1", orderTarget("x1"))).toBe(true);
    expect(move).not.toHaveBeenCalled();
    useAeSidebarStore.setState({ move: null });
    expect(aeHandleOrderDrop("s1", orderTarget("s2"))).toBe(true);
    expect(aeMoveRow("s1", "down")).toBe(false);
  });
});

describe("a drop on a row of another list", () => {
  it("files the row into that folder or Sessions, then places it on the line's side", () => {
    const move = publish();
    const fileTo = vi.fn();
    useAeSidebarStore.setState({ crossSide: { id: "f2", side: "after" } });
    expect(aeHandleOrderDrop("s1", orderTarget("f2"), fileTo)).toBe(true);
    expect(fileTo).toHaveBeenCalledExactlyOnceWith("Alpha");
    expect(move).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "s1", to: { after: "f2" }, scopeIds: ["f1", "f2", "s1"] }),
    );
    expect(useAeSidebarStore.getState().crossSide).toBeNull();

    aeHandleOrderDrop("f1", orderTarget("s2"), fileTo);
    expect(fileTo).toHaveBeenLastCalledWith("");
    expect(move).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "f1",
        to: { before: "s2" },
        scopeIds: ["s1", "s2", "s3", "f1"],
      }),
    );
  });

  it("reads which lists a row can move between", () => {
    publish();
    const state = useAeSidebarStore.getState();
    expect(aeCrossMove(state, "s1", "s2")).toBeNull();
    expect(aeCrossMove(state, "s1", "f1")).toEqual({ kind: "project", project: "Alpha" });
    expect(aeCrossMove(state, "f1", "s1")).toEqual({ kind: "project", project: "" });
    expect(aeCrossMove(state, "missing", "s1")).toBeNull();
    const groups = new Map([
      ["r1", "group:Review"],
      ["n1", "group:No status"],
      ["u1", "group:Today"],
    ]);
    expect(aeCrossMove({ listOf: groups, triage: true }, "r1", "n1")).toEqual({
      kind: "status",
      group: "No status",
      status: null,
    });
    expect(aeCrossMove({ listOf: groups, triage: true }, "n1", "r1")).toMatchObject({
      status: "review",
    });
    // The other groupings (by status activity, by date) group by what a drop cannot change.
    expect(aeCrossMove({ listOf: groups, triage: false }, "r1", "n1")).toBeNull();
    expect(aeCrossMove({ listOf: groups, triage: true }, "r1", "u1")).toBeNull();
  });

  it("sets the Triage group's status, holds the row there, then places it", async () => {
    const [R, W] = ["a", "b"].map((ch) => ch.repeat(32));
    const move = vi.fn(() => true);
    const queryClient = new QueryClient();
    queryClient.setQueryData(["conversations", "x"], {
      pages: [{ data: [{ id: R, labels: { "ae.status": "review" } }] }],
      pageParams: [null],
    });
    const frozen = new Map();
    useAeSidebarStore.setState({
      listed: true,
      manual: true,
      order: [],
      triage: true,
      frozenTriage: frozen,
      lists: new Map([
        ["group:Review", [R]],
        ["group:Parked", [W]],
      ]),
      listOf: new Map([
        [R, "group:Review"],
        [W, "group:Parked"],
      ]),
      units: () => [[{ id: R }, { id: W }]],
      move,
      queryClient,
    });
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    expect(aeHandleOrderDrop(R, orderTarget(W))).toBe(true);
    await vi.waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(mocks.fetch.mock.calls[0][1].body))).toEqual({
      labels: { "ae.status": "parked" },
    });
    expect(frozen.get(R)).toBe("Parked");
    expect(move).toHaveBeenCalledWith(
      expect.objectContaining({ id: R, to: { before: W }, scopeIds: [W, R] }),
    );
  });

  it("leaves the row in place when the status is refused", async () => {
    const [R, W] = ["a", "b"].map((ch) => ch.repeat(32));
    const move = vi.fn(() => true);
    useAeSidebarStore.setState({
      listed: true,
      manual: true,
      triage: true,
      lists: new Map([
        ["group:Review", [R]],
        ["group:Parked", [W]],
      ]),
      listOf: new Map([
        [R, "group:Review"],
        [W, "group:Parked"],
      ]),
      units: () => [[{ id: R }, { id: W }]],
      move,
      queryClient: new QueryClient(),
    });
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 500 }));
    aeHandleOrderDrop(R, orderTarget(W));
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    expect(move).not.toHaveBeenCalled();
  });

  it("tracks the pointer's half of the row under it, for another list only", () => {
    publish();
    const event = (activeId: string, overId: string, y: number) =>
      ({
        active: { id: activeId, rect: { current: { translated: null } } },
        over: {
          id: `ae-order:${overId}`,
          rect: { top: 100, height: 30 },
          data: { current: { type: "ae-order", id: overId } },
        },
        activatorEvent: new MouseEvent("mousedown", { clientY: 0 }),
        delta: { x: 0, y },
      }) as unknown as Parameters<typeof aeTrackDragMove>[0];
    aeTrackDragMove(event("s1", "f1", 110));
    expect(useAeSidebarStore.getState().crossSide).toEqual({ id: "f1", side: "before" });
    aeTrackDragMove(event("s1", "f1", 120));
    expect(useAeSidebarStore.getState().crossSide).toEqual({ id: "f1", side: "after" });
    aeTrackDragMove(event("s1", "s2", 120));
    expect(useAeSidebarStore.getState().crossSide).toBeNull();
    aeTrackDragMove(event("s1", "f1", 120));
    expect(aeEndDrag()).toEqual({ id: "f1", side: "after" });
    expect(useAeSidebarStore.getState().crossSide).toBeNull();
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

  it("keeps the row targets a drop can use, rows first", () => {
    publish();
    expect(collide("s1")).toEqual(["ae-order:s2", "ae-order:f2", "project:Alpha"]);
    expect(collide("f1")).toEqual(["ae-order:s2", "ae-order:f2", "project:Alpha"]);
  });

  it("drops another list's targets a row cannot move to", () => {
    publish();
    useAeSidebarStore.setState({
      listOf: new Map([
        ["s1", "shared"],
        ["s2", "sessions"],
        ["f2", "folder:Alpha"],
      ]),
    });
    expect(collide("s1")).toEqual(["project:Alpha"]);
  });

  it("keeps the targets outside Manual too", () => {
    publish();
    useAeSidebarStore.setState({ manual: false });
    expect(collide("s1")).toEqual(["ae-order:s2", "ae-order:f2", "project:Alpha"]);
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

  it("switches and saves a drop into another list even where the order looks unchanged", async () => {
    const { move, switchToManual } = publishUpdated();
    const F = "f".repeat(32);
    useAeSidebarStore.setState({
      lists: new Map([
        ["sessions", [A, B, C]],
        ["folder:Alpha", [F]],
      ]),
      listOf: new Map([...[A, B, C].map((id) => [id, "sessions"] as const), [F, "folder:Alpha"]]),
      units: () => [[{ id: F }], [{ id: A }, { id: B }, { id: C }]],
    });
    mocks.fetch.mockResolvedValue(json({ order: [], revision: 0 }));
    useAeSidebarStore.setState({ crossSide: { id: C, side: "after" } });
    expect(aeHandleOrderDrop(F, orderTarget(C), () => {})).toBe(true);
    expect(switchToManual).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    expect(move).toHaveBeenCalledWith(
      expect.objectContaining({ id: F, to: { after: C }, keep: true }),
    );
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
          view: { grouping: "default", ordering: "updated", show: [], familyDots: true },
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

  it("loads further pages under Status ordering, so every session sorts by its icon", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    for (const [ordering, loads] of [
      ["status", 1],
      ["updated", 0],
    ] as const) {
      const paged = { ...query, hasNextPage: true, fetchNextPage: vi.fn() } as typeof query;
      renderHook(
        () =>
          useAeSidebarView({
            view: { grouping: "default", ordering, show: [], familyDots: true },
            orderFrozen: false,
            conversationsQuery: paged,
            searchQuery: "",
            activeTab: "all",
            onViewChange: vi.fn(),
            available: true,
          }),
        { wrapper },
      );
      expect(paged.fetchNextPage).toHaveBeenCalledTimes(loads);
    }
  });
});

describe("useAePublishSidebarScopes in the family tree", () => {
  it("publishes each family as its own list, and no stand-in lead", () => {
    const rows = (...ids: string[]) => ids.map((id) => ({ id })) as never[];
    const ae = {
      listed: true,
      manual: true,
      order: null,
      statusSort: false,
      triage: false,
      frozenTriage: null,
      switchToManual: vi.fn(),
    } as never;
    const sessions = rows("a", "a1", "ghost", "g1", "plain");
    const titles = new Map([
      ["a", "Families"],
      ["a1", "Families"],
      ["ghost", "Families"],
      ["g1", "Families"],
      ["plain", "Standalone"],
    ]);
    const family = (root: string) => ({ family: { root } });
    const aeTree = {
      rows: new Map([
        ["a", family("a")],
        ["a1", family("a")],
        ["ghost", family("ghost")],
        ["g1", family("ghost")],
      ]),
      standIns: new Set(["ghost"]),
    };
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    renderHook(
      () =>
        useAePublishSidebarScopes(
          ae,
          { shared: [], sessions, projectGroups: [], groupTitles: titles, aeTree },
          new Map(),
          null,
          null,
        ),
      { wrapper },
    );
    const { lists, listOf } = useAeSidebarStore.getState();
    expect([...lists]).toEqual([
      ["family:a", ["a", "a1"]],
      ["family:ghost", ["g1"]],
      ["group:Standalone", ["plain"]],
    ]);
    expect(listOf.has("ghost")).toBe(false);
    // A drop in another family has no list to land on, so nothing collides or snaps back.
    expect(aeCrossMove(useAeSidebarStore.getState(), "a1", "g1")).toBeNull();
    expect(aePlaceOf(useAeSidebarStore.getState(), "a1")).toBe("last");
  });
});
