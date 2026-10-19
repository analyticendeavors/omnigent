import { describe, expect, it } from "vitest";
import {
  AE_ORDER_MAX,
  type AeMoveTo,
  aeApplyManualOrder,
  aeIsOrderId,
  aeMoveInOrder,
  aeTrimOrder,
} from "./aeSessionOrder";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((row) => row.id);

describe("aeApplyManualOrder", () => {
  it("puts rows the order lacks first, in their incoming order, then the rest by rank", () => {
    const ordered = aeApplyManualOrder(rows("new2", "b", "new1", "a", "c"), ["c", "a", "b"]);
    expect(ids(ordered)).toEqual(["new2", "new1", "c", "a", "b"]);
  });

  it("returns the rows themselves for an empty order", () => {
    const list = rows("a", "b");
    expect(aeApplyManualOrder(list, [])).toBe(list);
  });

  it("ignores ranked ids the list does not hold", () => {
    expect(ids(aeApplyManualOrder(rows("b", "a"), ["gone", "a", "b"]))).toEqual(["a", "b"]);
  });
});

describe("aeMoveInOrder", () => {
  // Two lists share one order: Sessions holds s1..s4, a folder holds f1 and f2.
  const loadedIds = ["s1", "f1", "s2", "s3", "f2", "s4"];
  const sessions = ["s1", "s2", "s3", "s4"];
  const folder = ["f1", "f2"];
  const shown = (order: readonly string[], members: string[]) =>
    ids(aeApplyManualOrder(rows(...loadedIds.filter((id) => members.includes(id))), order));
  const move = (order: readonly string[], id: string, to: AeMoveTo, scopeIds = sessions) =>
    aeMoveInOrder({ order, loadedIds, scopeIds, id, to });

  it("moves within the list from an empty order, writing the loaded rows in first", () => {
    const next = move([], "s3", "top");
    expect(shown(next, sessions)).toEqual(["s3", "s1", "s2", "s4"]);
    // The other list shows what it showed.
    expect(shown(next, folder)).toEqual(["f1", "f2"]);
    expect(next).toEqual(["s3", "s1", "f1", "s2", "f2", "s4"]);
  });

  it("handles up, down and bottom by the list's own neighbours", () => {
    let order = move([], "s3", "up");
    expect(shown(order, sessions)).toEqual(["s1", "s3", "s2", "s4"]);
    order = move(order, "s1", "down");
    expect(shown(order, sessions)).toEqual(["s3", "s1", "s2", "s4"]);
    order = move(order, "s3", "bottom");
    expect(shown(order, sessions)).toEqual(["s1", "s2", "s4", "s3"]);
    expect(shown(order, folder)).toEqual(["f1", "f2"]);
  });

  it("drops before or after a target the way the insertion line shows", () => {
    expect(shown(move([], "s1", { after: "s3" }), sessions)).toEqual(["s2", "s3", "s1", "s4"]);
    expect(shown(move([], "s4", { before: "s2" }), sessions)).toEqual(["s1", "s4", "s2", "s3"]);
    expect(shown(move([], "s1", { before: "s3" }), sessions)).toEqual(["s2", "s1", "s3", "s4"]);
  });

  it("moves a folder row among its folder's rows only", () => {
    const next = move([], "f2", "top", folder);
    expect(shown(next, folder)).toEqual(["f2", "f1"]);
    expect(shown(next, sessions)).toEqual(sessions);
  });

  it("returns the order itself for a move that changes nothing", () => {
    const order = [...loadedIds];
    expect(move(order, "s1", "top")).toBe(order);
    expect(move(order, "s1", "up")).toBe(order);
    expect(move(order, "s4", "down")).toBe(order);
    expect(move(order, "s1", { before: "s2" })).toBe(order);
    expect(move(order, "s1", { after: "missing" })).toBe(order);
    expect(move(order, "unlisted", "top")).toBe(order);
  });

  it("keeps a new session on top of its list after other moves", () => {
    const order = move([], "s4", "top");
    const withNew = ["s0", ...sessions];
    expect(ids(aeApplyManualOrder(rows(...withNew), order))).toEqual([
      "s0",
      "s4",
      "s1",
      "s2",
      "s3",
    ]);
  });

  it("replays on a fresh order by the list as that order shows it", () => {
    // Another device put s4 first; "up" on s2 now passes s1 only.
    const fresh = ["s4", "s1", "s2", "s3"];
    expect(shown(move(fresh, "s2", "up"), sessions)).toEqual(["s4", "s2", "s1", "s3"]);
  });
});

describe("aeTrimOrder", () => {
  it("drops unloaded ids from the end first, keeping the moved id", () => {
    const order = Array.from({ length: AE_ORDER_MAX + 2 }, (_, i) => `id${i}`);
    const loaded = new Set(order.slice(0, AE_ORDER_MAX - 5));
    const last = order[order.length - 1];
    const trimmed = aeTrimOrder(order, loaded, last);
    expect(trimmed).toHaveLength(AE_ORDER_MAX);
    expect(trimmed.at(-1)).toBe(last);
    expect(trimmed).not.toContain(order[order.length - 2]);
    expect(trimmed).not.toContain(order[order.length - 3]);
  });

  it("never drops the moved id, even when every id is loaded", () => {
    const order = Array.from({ length: AE_ORDER_MAX + 3 }, (_, i) => `id${i}`);
    const last = order[order.length - 1];
    const trimmed = aeTrimOrder(order, new Set(order), last);
    expect(trimmed).toHaveLength(AE_ORDER_MAX);
    expect(trimmed.at(-1)).toBe(last);
    expect(trimmed.slice(0, -1)).toEqual(order.slice(0, AE_ORDER_MAX - 1));
  });

  it("keeps a row moved to the bottom of more than 500 loaded rows", () => {
    const loadedIds = Array.from({ length: AE_ORDER_MAX + 20 }, (_, i) => `id${i}`);
    const next = aeMoveInOrder({
      order: [],
      loadedIds,
      scopeIds: loadedIds,
      id: "id0",
      to: "bottom",
    });
    expect(next).toHaveLength(AE_ORDER_MAX);
    expect(next.at(-1)).toBe("id0");
  });

  it("leaves a short order alone", () => {
    const order = ["a"];
    expect(aeTrimOrder(order, new Set())).toBe(order);
  });
});

describe("aeIsOrderId", () => {
  it("accepts session ids and refuses a provisional row's", () => {
    expect(aeIsOrderId("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(aeIsOrderId("temp:0123456789abcdef0123456789ab")).toBe(false);
    expect(aeIsOrderId("0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(aeIsOrderId("abc")).toBe(false);
  });
});
