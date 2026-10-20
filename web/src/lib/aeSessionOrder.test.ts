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
// Rows with a creation time, newest first unless listed otherwise.
const made = (entries: [string, number][]) =>
  entries.map(([id, created_at]) => ({ id, created_at }));

describe("aeApplyManualOrder", () => {
  it("puts unranked rows newer than every ranked one on top, the others below", () => {
    const list = made([
      ["new2", 50],
      ["b", 20],
      ["old1", 15],
      ["new1", 40],
      ["a", 10],
      ["old2", 5],
    ]);
    expect(ids(aeApplyManualOrder(list, ["a", "b"]))).toEqual([
      "new2",
      "new1",
      "a",
      "b",
      "old1",
      "old2",
    ]);
  });

  it("puts every row on top, in incoming order, when none is ranked", () => {
    const list = made([
      ["x", 1],
      ["y", 2],
    ]);
    expect(aeApplyManualOrder(list, ["gone"])).toBe(list);
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
  // Two ranking units: the session list s1..s4 and a folder f1, f2 (updated order).
  const sessionRows = made([
    ["s1", 40],
    ["s2", 30],
    ["s3", 20],
    ["s4", 10],
  ]);
  const folderRows = made([
    ["f1", 35],
    ["f2", 15],
  ]);
  const units = [sessionRows, folderRows];
  const sessions = ids(sessionRows);
  const folder = ids(folderRows);
  const shown = (order: readonly string[], unit = sessionRows) =>
    ids(aeApplyManualOrder([...unit], order));
  const move = (order: readonly string[], id: string, to: AeMoveTo, scopeIds = sessions) =>
    aeMoveInOrder({ order, units, scopeIds, id, to });

  it("moves within the list from an empty order, ranking the loaded rows first", () => {
    const next = move([], "s3", "top");
    expect(shown(next)).toEqual(["s3", "s1", "s2", "s4"]);
    // The other list shows what it showed.
    expect(shown(next, folderRows)).toEqual(["f1", "f2"]);
    expect(next).toEqual(["f1", "f2", "s3", "s1", "s2", "s4"]);
  });

  it("handles up, down and bottom by the list's own neighbours", () => {
    let order = move([], "s3", "up");
    expect(shown(order)).toEqual(["s1", "s3", "s2", "s4"]);
    order = move(order, "s1", "down");
    expect(shown(order)).toEqual(["s3", "s1", "s2", "s4"]);
    order = move(order, "s3", "bottom");
    expect(shown(order)).toEqual(["s1", "s2", "s4", "s3"]);
    expect(shown(order, folderRows)).toEqual(["f1", "f2"]);
  });

  it("drops before or after a target the way the insertion line shows", () => {
    expect(shown(move([], "s1", { after: "s3" }))).toEqual(["s2", "s3", "s1", "s4"]);
    expect(shown(move([], "s4", { before: "s2" }))).toEqual(["s1", "s4", "s2", "s3"]);
    expect(shown(move([], "s1", { before: "s3" }))).toEqual(["s2", "s1", "s3", "s4"]);
  });

  it("moves a folder row among its folder's rows only", () => {
    const next = move([], "f2", "top", folder);
    expect(shown(next, folderRows)).toEqual(["f2", "f1"]);
    expect(shown(next)).toEqual(sessions);
  });

  it("returns the order itself for a move that changes nothing", () => {
    const order = [...sessions, ...folder];
    expect(move(order, "s1", "top")).toBe(order);
    expect(move(order, "s1", "up")).toBe(order);
    expect(move(order, "s4", "down")).toBe(order);
    expect(move(order, "s1", { before: "s2" })).toBe(order);
    expect(move(order, "s1", { after: "missing" })).toBe(order);
    expect(move(order, "unlisted", "top")).toBe(order);
  });

  it("keeps a new session on top and an older late row below the arranged ones", () => {
    const order = move([], "s4", "top");
    const later = made([
      ["s0", 50],
      ...sessionRows.map((r) => [r.id, r.created_at] as [string, number]),
      ["s9", 1],
    ]);
    expect(shown(order, later)).toEqual(["s0", "s4", "s1", "s2", "s3", "s9"]);
  });

  it("changes only the moved row when unranked rows show above and below", () => {
    // s2 and s1 are ranked; s0 is newer (top), s3 and s4 are older (bottom).
    const order = ["s2", "s1"];
    const unit = made([
      ["s0", 50],
      ...sessionRows.map((r) => [r.id, r.created_at] as [string, number]),
    ]);
    const scope = ids(unit);
    expect(shown(order, unit)).toEqual(["s0", "s2", "s1", "s3", "s4"]);
    const up = aeMoveInOrder({ order, units: [unit], scopeIds: scope, id: "s4", to: "up" });
    expect(shown(up, unit)).toEqual(["s0", "s2", "s1", "s4", "s3"]);
    const top = aeMoveInOrder({ order, units: [unit], scopeIds: scope, id: "s3", to: "top" });
    expect(shown(top, unit)).toEqual(["s3", "s0", "s2", "s1", "s4"]);
  });

  it("replays on a fresh order by the list as that order shows it", () => {
    // Another device put s4 first; "up" on s2 now passes s1 only.
    const fresh = ["s4", "s1", "s2", "s3"];
    expect(shown(move(fresh, "s2", "up"))).toEqual(["s4", "s2", "s1", "s3"]);
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
      units: [loadedIds.map((id) => ({ id }))],
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
