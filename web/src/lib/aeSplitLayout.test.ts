// Tests for the split view's layout helpers (omnigent-ae patch P5): the URL
// round trip, the remembered layout, "Open in split view"'s merge rule, the
// divider math and the pane-frame check.

import { beforeEach, describe, expect, it } from "vitest";
import {
  AE_SPLIT_MAX_PANES,
  AE_SPLIT_MIN_FRACTION,
  AE_SPLIT_STORAGE_KEY,
  addEmptyPane,
  cleanPanes,
  formatSplitParam,
  isAeSplitPane,
  layoutWithSession,
  normalizeSizes,
  paneSessionFromPath,
  parseSplitParam,
  readStoredLayout,
  removePane,
  resizeAt,
  splitHref,
  writeStoredLayout,
} from "./aeSplitLayout";

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
  it("writes and reads back panes and sizes", () => {
    writeStoredLayout({ panes: ["a", "b"], sizes: [0.3, 0.7] });
    expect(readStoredLayout()).toEqual({ panes: ["a", "b"], sizes: [0.3, 0.7] });
  });

  it("repairs sizes that do not fit the panes", () => {
    window.localStorage.setItem(
      AE_SPLIT_STORAGE_KEY,
      JSON.stringify({ panes: ["a", "b"], sizes: [1] }),
    );
    expect(readStoredLayout()?.sizes).toEqual([0.5, 0.5]);
  });

  it("ignores garbage", () => {
    window.localStorage.setItem(AE_SPLIT_STORAGE_KEY, "{not json");
    expect(readStoredLayout()).toBeNull();
    window.localStorage.setItem(AE_SPLIT_STORAGE_KEY, JSON.stringify({ panes: [] }));
    expect(readStoredLayout()).toBeNull();
  });
});

describe("layoutWithSession", () => {
  it("seeds with the session being viewed when nothing is remembered", () => {
    expect(layoutWithSession(null, "b", "a").panes).toEqual(["a", "b"]);
  });

  it("opens the session alone when nothing is remembered or viewed", () => {
    expect(layoutWithSession(null, "b", null).panes).toEqual(["b"]);
  });

  it("appends to the remembered panes and keeps a session already there in place", () => {
    const stored = { panes: ["a", "b"], sizes: [0.4, 0.6] };
    expect(layoutWithSession(stored, "c", "x").panes).toEqual(["a", "b", "c"]);
    expect(layoutWithSession(stored, "a", "x")).toEqual(stored);
  });

  it("replaces the last pane at the maximum", () => {
    const stored = { panes: ["a", "b", "c", "d"], sizes: [0.25, 0.25, 0.25, 0.25] };
    expect(layoutWithSession(stored, "e", null).panes).toEqual(["a", "b", "c", "e"]);
  });
});

describe("sizes", () => {
  it("normalizes to fractions summing to one", () => {
    expect(normalizeSizes([1, 3], 2)).toEqual([0.25, 0.75]);
    expect(normalizeSizes([0, 1], 2)).toEqual([0.5, 0.5]);
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

  it("gives a closed pane's width to the survivors", () => {
    expect(removePane({ panes: ["a", "b", "c"], sizes: [0.5, 0.25, 0.25] }, 0)).toEqual({
      panes: ["b", "c"],
      sizes: [0.5, 0.5],
    });
  });

  it("adds an empty pane with equal widths, up to the maximum", () => {
    expect(addEmptyPane({ panes: ["a"], sizes: [1] })).toEqual({
      panes: ["a", null],
      sizes: [0.5, 0.5],
    });
    const full = { panes: ["a", "b", "c", "d"], sizes: [0.25, 0.25, 0.25, 0.25] };
    expect(addEmptyPane(full)).toBe(full);
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
