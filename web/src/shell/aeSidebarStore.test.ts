// The drag handlers' side of Manual ordering: every drop on a row-order target
// is consumed (upstream would read it as the Sessions list and unfile the
// row), and a row-order target in another list never collides.

import type { Over } from "@dnd-kit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSidebarDrop } from "./sidebarNav";
import {
  aeHandleOrderDrop,
  aeInsertionSide,
  aeMoveRow,
  aePlaceOf,
  aePointerWithin,
  useAeSidebarStore,
} from "./aeSidebarStore";

const LISTS = new Map([
  ["sessions", ["s1", "s2", "s3"]],
  ["folder:Alpha", ["f1", "f2"]],
]);

function publish(move = vi.fn(() => true)) {
  const listOf = new Map<string, string>();
  for (const [key, ids] of LISTS) for (const id of ids) listOf.set(id, key);
  useAeSidebarStore.setState({
    manual: true,
    order: [],
    lists: LISTS,
    listOf,
    loadedIds: ["s1", "f1", "s2", "f2", "s3"],
    move,
  });
  return move;
}

const over = (data: Record<string, unknown>) => ({ id: "x", data: { current: data } }) as Over;
const orderTarget = (id: string) => over({ type: "ae-order", id });

afterEach(() => {
  useAeSidebarStore.setState({
    manual: false,
    order: null,
    lists: new Map(),
    listOf: new Map(),
    loadedIds: [],
    move: null,
  });
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
      loadedIds: ["s1", "f1", "s2", "f2", "s3"],
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

  it("drops every row-order target outside Manual or for an unlisted row", () => {
    publish();
    expect(collide("pinned-row")).toEqual(["project:Alpha"]);
    useAeSidebarStore.setState({ manual: false });
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
    expect(aePlaceOf({ ...state, manual: false }, "s1")).toBeNull();
    expect(aeInsertionSide("s1", "s3")).toBe("after");
    expect(aeInsertionSide("s3", "s1")).toBe("before");
    expect(aeInsertionSide("s1", "f1")).toBeNull();
  });
});
