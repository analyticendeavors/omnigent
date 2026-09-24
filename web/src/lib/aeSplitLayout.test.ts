// Tests for the split view's layout helpers (omnigent-ae patches P5 and P9):
// the URL round trip, the remembered layout and its migration from version 1,
// "Open in split view"'s merge rule, the presets (slot rectangles, growing,
// shrinking, switching, swapping), the divider math in both axes and the
// pane-frame check.

import { beforeEach, describe, expect, it } from "vitest";
import {
  AE_SPLIT_MAX_PANES,
  AE_SPLIT_MIN_FRACTION,
  AE_SPLIT_PRESETS,
  AE_SPLIT_STORAGE_KEY,
  type AeSplitLayout,
  type AeSplitPresetId,
  addEmptyPane,
  addPane,
  addedSlot,
  applyPreset,
  cleanPanes,
  defaultPreset,
  formatLayoutParam,
  formatSplitParam,
  isAeSplitPane,
  keptSlots,
  layoutWithSession,
  makeLayout,
  migrateStoredLayout,
  nextPreset,
  normalizeSizes,
  paneSessionFromPath,
  parseLayoutParam,
  parseSplitParam,
  readStoredLayout,
  removePane,
  resizeAt,
  resizeColumn,
  resizeRow,
  slotCount,
  slotRects,
  splitHref,
  swapPanes,
  writeStoredLayout,
} from "./aeSplitLayout";

/** Two side by side at the given widths. */
function row(panes: (string | null)[], cols?: number[]): AeSplitLayout {
  const layout = makeLayout(panes);
  return cols ? { ...layout, cols } : layout;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("split URL", () => {
  it("parses sessions and the new-pane token, dropping duplicates and blanks", () => {
    expect(parseSplitParam("a,new,b,a,,")).toEqual(["a", null, "b"]);
  });

  it("caps at the maximum pane count", () => {
    expect(parseSplitParam("a,b,c,d,e")).toHaveLength(AE_SPLIT_MAX_PANES);
  });

  it("treats an absent or empty parameter as no layout", () => {
    expect(parseSplitParam(null)).toBeNull();
    expect(parseSplitParam(" , ")).toBeNull();
  });

  it("round-trips through formatSplitParam and splitHref", () => {
    expect(formatSplitParam(["a", null])).toBe("a,new");
    expect(splitHref(["a", "b"])).toBe("/split?s=a,b");
    expect(parseSplitParam(formatSplitParam(["x", null, "y"]))).toEqual(["x", null, "y"]);
  });

  it("carries the preset in `l` only when it is not side by side", () => {
    expect(splitHref(["a", "b"], "cols2")).toBe("/split?s=a,b");
    expect(splitHref(["a", "b"], "rows2")).toBe("/split?s=a,b&l=rows2");
    expect(formatLayoutParam("grid", 4)).toBe("grid");
    expect(formatLayoutParam("cols4", 4)).toBeNull();
  });

  it("reads `l` only when it names a preset for that many panes", () => {
    expect(parseLayoutParam("stack-right", 3)).toBe("stack-right");
    expect(parseLayoutParam("stack-right", 2)).toBeNull();
    expect(parseLayoutParam("spiral", 2)).toBeNull();
    expect(parseLayoutParam(null, 2)).toBeNull();
  });

  it("keeps empty panes but not duplicate sessions", () => {
    expect(cleanPanes([null, null, "a", "a"])).toEqual([null, null, "a"]);
  });
});

describe("pane paths", () => {
  it("reads the session from a chat path and null from the landing page", () => {
    expect(paneSessionFromPath("/c/conv_1")).toBe("conv_1");
    expect(paneSessionFromPath("/c/conv_1/")).toBe("conv_1");
    expect(paneSessionFromPath("/")).toBeNull();
  });

  it("returns undefined for pages that are not a session", () => {
    expect(paneSessionFromPath("/settings/general")).toBeUndefined();
    expect(paneSessionFromPath("/inbox")).toBeUndefined();
  });
});

describe("remembered layout", () => {
  it("writes version 2 under the version 1 key and reads it back", () => {
    const layout: AeSplitLayout = {
      preset: "stack-left",
      panes: ["a", "b", "c"],
      cols: [0.6, 0.4],
      rows: [[0.3, 0.7], [1]],
    };
    writeStoredLayout(layout);
    const raw = JSON.parse(window.localStorage.getItem(AE_SPLIT_STORAGE_KEY)!);
    expect(raw.v).toBe(2);
    expect(readStoredLayout()).toEqual(layout);
  });

  it("migrates a version 1 row to side by side with its widths", () => {
    window.localStorage.setItem(
      AE_SPLIT_STORAGE_KEY,
      JSON.stringify({ panes: ["a", "b"], sizes: [0.3, 0.7] }),
    );
    expect(readStoredLayout()).toEqual({
      preset: "cols2",
      panes: ["a", "b"],
      cols: [0.3, 0.7],
      rows: [[1], [1]],
    });
  });

  it("migrates version 1 layouts of one, three and four panes", () => {
    expect(migrateStoredLayout({ panes: ["a"], sizes: [1] })?.preset).toBe("one");
    expect(migrateStoredLayout({ panes: ["a", null, "c"], sizes: [1, 1, 2] })).toEqual({
      preset: "cols3",
      panes: ["a", null, "c"],
      cols: [0.25, 0.25, 0.5],
      rows: [[1], [1], [1]],
    });
    expect(migrateStoredLayout({ panes: ["a", "b", "c", "d"] })?.preset).toBe("cols4");
  });

  it("repairs version 1 sizes that do not fit the panes", () => {
    window.localStorage.setItem(
      AE_SPLIT_STORAGE_KEY,
      JSON.stringify({ panes: ["a", "b"], sizes: [1] }),
    );
    expect(readStoredLayout()?.cols).toEqual([0.5, 0.5]);
  });

  it("falls back to side by side when a version 2 preset does not fit its panes", () => {
    expect(
      migrateStoredLayout({ v: 2, preset: "grid", panes: ["a", "b"], cols: [0.5, 0.5] }),
    ).toEqual({ preset: "cols2", panes: ["a", "b"], cols: [0.5, 0.5], rows: [[1], [1]] });
    expect(migrateStoredLayout({ v: 2, preset: "bogus", panes: ["a", "b", "c"] })?.preset).toBe(
      "cols3",
    );
  });

  it("repairs version 2 sizes per column", () => {
    expect(
      migrateStoredLayout({
        v: 2,
        preset: "grid",
        panes: ["a", "b", "c", "d"],
        cols: [1, 3],
        rows: [[1, 1, 1], "x"],
      }),
    ).toEqual({
      preset: "grid",
      panes: ["a", "b", "c", "d"],
      cols: [0.25, 0.75],
      rows: [
        [0.5, 0.5],
        [0.5, 0.5],
      ],
    });
  });

  it("ignores garbage", () => {
    window.localStorage.setItem(AE_SPLIT_STORAGE_KEY, "{not json");
    expect(readStoredLayout()).toBeNull();
    window.localStorage.setItem(AE_SPLIT_STORAGE_KEY, JSON.stringify({ panes: [] }));
    expect(readStoredLayout()).toBeNull();
    expect(migrateStoredLayout(null)).toBeNull();
    expect(migrateStoredLayout("a,b")).toBeNull();
  });
});

describe("layoutWithSession", () => {
  it("seeds with the session being viewed when nothing is remembered", () => {
    expect(layoutWithSession(null, "b", "a")).toEqual(makeLayout(["a", "b"]));
  });

  it("opens the session alone when nothing is remembered or viewed", () => {
    expect(layoutWithSession(null, "b", null)).toEqual(makeLayout(["b"]));
  });

  it("appends to the remembered panes and keeps a session already there in place", () => {
    const stored = row(["a", "b"], [0.4, 0.6]);
    expect(layoutWithSession(stored, "c", "x").panes).toEqual(["a", "b", "c"]);
    expect(layoutWithSession(stored, "a", "x")).toBe(stored);
  });

  it("grows the remembered preset the way Add pane does", () => {
    const stacked = makeLayout(["a", "b"], "rows2");
    expect(layoutWithSession(stacked, "c", null)).toMatchObject({
      preset: "stack-left",
      panes: ["a", "b", "c"],
    });
  });

  it("replaces the last pane at the maximum, keeping the preset", () => {
    const stored = makeLayout(["a", "b", "c", "d"], "grid");
    expect(layoutWithSession(stored, "e", null)).toMatchObject({
      preset: "grid",
      panes: ["a", "b", "c", "e"],
    });
  });
});

describe("presets", () => {
  it("offers the seven arrangements, each holding two to four panes", () => {
    expect(AE_SPLIT_PRESETS.map((p) => p.id)).toEqual([
      "cols2",
      "rows2",
      "stack-left",
      "stack-right",
      "grid",
      "cols3",
      "cols4",
    ]);
    expect(AE_SPLIT_PRESETS.map((p) => slotCount(p.id))).toEqual([2, 2, 3, 3, 4, 3, 4]);
    expect(slotCount("one")).toBe(1);
  });

  it("defaults to side by side for a pane count", () => {
    expect([1, 2, 3, 4].map(defaultPreset)).toEqual(["one", "cols2", "cols3", "cols4"]);
  });

  it("lays out every preset's slots column by column, covering the area once", () => {
    const expected: Record<string, [number, number, number, number][]> = {
      cols2: [
        [0, 0, 0.5, 1],
        [0.5, 0, 0.5, 1],
      ],
      rows2: [
        [0, 0, 1, 0.5],
        [0, 0.5, 1, 0.5],
      ],
      "stack-left": [
        [0, 0, 0.5, 0.5],
        [0, 0.5, 0.5, 0.5],
        [0.5, 0, 0.5, 1],
      ],
      "stack-right": [
        [0, 0, 0.5, 1],
        [0.5, 0, 0.5, 0.5],
        [0.5, 0.5, 0.5, 0.5],
      ],
      grid: [
        [0, 0, 0.5, 0.5],
        [0, 0.5, 0.5, 0.5],
        [0.5, 0, 0.5, 0.5],
        [0.5, 0.5, 0.5, 0.5],
      ],
    };
    for (const [id, rects] of Object.entries(expected)) {
      const layout = makeLayout(
        Array.from({ length: rects.length }, (_, i) => `p${i}`),
        id as AeSplitPresetId,
      );
      expect(slotRects(layout).map((r) => [r.x, r.y, r.w, r.h])).toEqual(rects);
    }
    for (const preset of AE_SPLIT_PRESETS) {
      const layout = makeLayout(
        Array.from({ length: slotCount(preset.id) }, () => null),
        preset.id,
      );
      const area = slotRects(layout).reduce((a, r) => a + r.w * r.h, 0);
      expect(area).toBeCloseTo(1);
    }
  });

  it("follows resized columns and rows", () => {
    const layout: AeSplitLayout = {
      preset: "stack-right",
      panes: ["a", "b", "c"],
      cols: [0.3, 0.7],
      rows: [[1], [0.25, 0.75]],
    };
    expect(slotRects(layout).map((r) => [r.x, r.y, r.w, r.h])).toEqual([
      [0, 0, 0.3, 1],
      [0.3, 0, 0.7, 0.25],
      [0.3, 0.25, 0.7, 0.75],
    ]);
  });

  it("makes a layout in the preset asked, or the default when it does not fit", () => {
    expect(makeLayout(["a", "b"], "rows2")).toEqual({
      preset: "rows2",
      panes: ["a", "b"],
      cols: [1],
      rows: [[0.5, 0.5]],
    });
    expect(makeLayout(["a", "b"], "grid").preset).toBe("cols2");
  });
});

describe("adding a pane", () => {
  it("switches to the next preset that fits, keeping the arrangement's character", () => {
    const grown: Record<string, AeSplitPresetId | null> = {
      one: "cols2",
      cols2: "cols3",
      rows2: "stack-left",
      "stack-left": "grid",
      "stack-right": "grid",
      cols3: "cols4",
      grid: null,
      cols4: null,
    };
    for (const [from, to] of Object.entries(grown)) {
      expect(nextPreset(from as AeSplitPresetId)).toBe(to);
    }
  });

  it("puts the new pane where the grown preset adds a slot, so open panes stay put", () => {
    // 2 stacked -> 2+1: the new pane is the lone one on the right.
    expect(addPane(makeLayout(["a", "b"], "rows2"))).toMatchObject({
      preset: "stack-left",
      panes: ["a", "b", null],
    });
    // 1+2 -> grid: the new pane goes under the left one.
    const mirror = makeLayout(["a", "b", "c"], "stack-right");
    expect(addedSlot(mirror)).toBe(1);
    expect(addPane(mirror, "d")).toMatchObject({ preset: "grid", panes: ["a", "d", "b", "c"] });
    // 2+1 -> grid: the new pane goes under the right one.
    expect(addPane(makeLayout(["a", "b", "c"], "stack-left"), "d").panes).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("adds an empty pane with equal sizes, and is a no-op when full", () => {
    expect(addEmptyPane(row(["a"]))).toEqual(makeLayout(["a", null]));
    const wide = row(["a", "b"], [0.7, 0.3]);
    expect(addEmptyPane(wide).cols).toEqual([1 / 3, 1 / 3, 1 / 3]);
    const full = makeLayout(["a", "b", "c", "d"], "grid");
    expect(addEmptyPane(full)).toBe(full);
    expect(addedSlot(full)).toBe(-1);
    expect(addEmptyPane(makeLayout(["a", "b", "c", "d"]))).toEqual(
      makeLayout(["a", "b", "c", "d"]),
    );
  });
});

describe("closing a pane", () => {
  it("gives a closed pane's width to the survivors", () => {
    expect(removePane(row(["a", "b", "c"], [0.5, 0.25, 0.25]), 0)).toEqual({
      preset: "cols2",
      panes: ["b", "c"],
      cols: [0.5, 0.5],
      rows: [[1], [1]],
    });
  });

  it("shrinks to the preset of the shape that is left", () => {
    const grid = makeLayout(["a", "b", "c", "d"], "grid");
    expect(removePane(grid, 0)).toMatchObject({ preset: "stack-right", panes: ["b", "c", "d"] });
    expect(removePane(grid, 3)).toMatchObject({ preset: "stack-left", panes: ["a", "b", "c"] });
    const twoOne = makeLayout(["a", "b", "c"], "stack-left");
    expect(removePane(twoOne, 2)).toMatchObject({ preset: "rows2", panes: ["a", "b"] });
    expect(removePane(twoOne, 0)).toMatchObject({ preset: "cols2", panes: ["b", "c"] });
    expect(removePane(makeLayout(["a", "b"], "rows2"), 1)).toMatchObject({
      preset: "one",
      panes: ["a"],
    });
  });

  it("keeps the surviving rows' proportions", () => {
    const layout: AeSplitLayout = {
      preset: "stack-right",
      panes: ["a", "b", "c"],
      cols: [0.4, 0.6],
      rows: [[1], [0.3, 0.7]],
    };
    expect(removePane(layout, 0)).toEqual({
      preset: "rows2",
      panes: ["b", "c"],
      cols: [1],
      rows: [[0.3, 0.7]],
    });
  });

  it("never removes the last pane", () => {
    const one = makeLayout(["a"]);
    expect(removePane(one, 0)).toBe(one);
  });
});

describe("switching presets", () => {
  it("keeps sessions in slot order and opens extra slots on the new-session page", () => {
    expect(applyPreset(makeLayout(["a", "b"]), "grid")).toEqual({
      preset: "grid",
      panes: ["a", "b", null, null],
      cols: [0.5, 0.5],
      rows: [
        [0.5, 0.5],
        [0.5, 0.5],
      ],
    });
    expect(applyPreset(makeLayout(["a", "b"]), "rows2")).toMatchObject({
      preset: "rows2",
      panes: ["a", "b"],
    });
  });

  it("drops empty panes first, then the last sessions", () => {
    expect(keptSlots(["a", null, "b", null], 2)).toEqual([0, 2]);
    expect(keptSlots(["a", "b", "c", "d"], 2)).toEqual([0, 1]);
    expect(keptSlots(["a", null, "b", "c"], 2)).toEqual([0, 2]);
    expect(applyPreset(makeLayout(["a", null, "b", "c"], "grid"), "stack-left").panes).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("swapping panes", () => {
  it("swaps two slots' sessions and keeps the slots' sizes", () => {
    const layout: AeSplitLayout = {
      preset: "stack-left",
      panes: ["a", "b", "c"],
      cols: [0.3, 0.7],
      rows: [[0.4, 0.6], [1]],
    };
    expect(swapPanes(layout, 0, 2)).toEqual({ ...layout, panes: ["c", "b", "a"] });
  });

  it("ignores a swap with itself or outside the layout", () => {
    const layout = makeLayout(["a", "b"]);
    expect(swapPanes(layout, 1, 1)).toBe(layout);
    expect(swapPanes(layout, 1, 2)).toBe(layout);
    expect(swapPanes(layout, -1, 0)).toBe(layout);
  });
});

describe("sizes", () => {
  it("normalizes to fractions summing to one", () => {
    expect(normalizeSizes([1, 3], 2)).toEqual([0.25, 0.75]);
    expect(normalizeSizes([0, 1], 2)).toEqual([0.5, 0.5]);
    expect(normalizeSizes(["x", 1], 2)).toEqual([0.5, 0.5]);
  });

  it("moves one divider and clamps at the minimum width", () => {
    const [a, b, c] = resizeAt([0.5, 0.25, 0.25], 1, 0.1);
    expect(a).toBe(0.5);
    expect(b).toBeCloseTo(0.35);
    expect(c).toBeCloseTo(0.15);
    const clamped = resizeAt([0.5, 0.5], 0, -0.9);
    expect(clamped[0]).toBeCloseTo(AE_SPLIT_MIN_FRACTION);
    expect(clamped[1]).toBeCloseTo(1 - AE_SPLIT_MIN_FRACTION);
  });

  it("resizes columns and the stacked panes of one column independently", () => {
    const grid = makeLayout(["a", "b", "c", "d"], "grid");
    const wider = resizeColumn(grid, 0, 0.1);
    expect(wider.cols[0]).toBeCloseTo(0.6);
    expect(wider.rows).toEqual(grid.rows);
    const taller = resizeRow(grid, 1, 0, 0.2);
    expect(taller.rows[0]).toEqual([0.5, 0.5]);
    expect(taller.rows[1]![0]).toBeCloseTo(0.7);
    expect(taller.rows[1]![1]).toBeCloseTo(0.3);
    expect(resizeRow(grid, 1, 0, 0.9).rows[1]![1]).toBeCloseTo(AE_SPLIT_MIN_FRACTION);
  });
});

describe("isAeSplitPane", () => {
  it("is true only for a framed window whose name carries the prefix", () => {
    const top = { name: "ae-split-pane-1" } as Window;
    (top as { parent: Window }).parent = top;
    expect(isAeSplitPane(top)).toBe(false);
    const framed = { name: "ae-split-pane-1", parent: {} } as unknown as Window;
    expect(isAeSplitPane(framed)).toBe(true);
    const other = { name: "preview", parent: {} } as unknown as Window;
    expect(isAeSplitPane(other)).toBe(false);
    expect(isAeSplitPane(window)).toBe(false);
  });
});
