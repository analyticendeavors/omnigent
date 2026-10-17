import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AE_RAIL_SECTIONS,
  normalizeOrder,
  useAeSessionRailStore,
  type AeRailSectionId,
} from "./aeSessionRail";

const STORAGE_KEY = "ae.sessionRail.v1";

function order(): AeRailSectionId[] {
  return useAeSessionRailStore.getState().order;
}

beforeEach(() => {
  window.localStorage.clear();
  useAeSessionRailStore.setState({
    open: false,
    sheetOpen: false,
    order: [...AE_RAIL_SECTIONS],
    folded: { connectors: true },
    focus: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("normalizeOrder", () => {
  it("drops unknown and repeated ids and appends missing ones in default order", () => {
    const result = normalizeOrder(["usage", "bogus", "triage", "usage", 7]);
    expect(result.slice(0, 2)).toEqual(["usage", "triage"]);
    expect(result).toHaveLength(AE_RAIL_SECTIONS.length);
    expect(new Set(result).size).toBe(AE_RAIL_SECTIONS.length);
    expect(result.slice(2)).toEqual(
      AE_RAIL_SECTIONS.filter((id) => id !== "usage" && id !== "triage"),
    );
  });

  it("falls back to the default order for anything that is not an array", () => {
    expect(normalizeOrder(undefined)).toEqual([...AE_RAIL_SECTIONS]);
    expect(normalizeOrder({ triage: 1 })).toEqual([...AE_RAIL_SECTIONS]);
  });
});

describe("reordering", () => {
  it("moveTo puts the section at the index, clamped to the list", () => {
    const { moveTo } = useAeSessionRailStore.getState();
    moveTo("changes", 1);
    expect(order().slice(0, 3)).toEqual(["triage", "changes", "environment"]);
    moveTo("triage", 99);
    expect(order().at(-1)).toBe("triage");
    moveTo("triage", -5);
    expect(order()[0]).toBe("triage");
  });

  it("moveBy steps one place and stays put at either end", () => {
    const { moveBy } = useAeSessionRailStore.getState();
    moveBy("environment", -1);
    expect(order().slice(0, 2)).toEqual(["environment", "triage"]);
    moveBy("environment", -1);
    expect(order()[0]).toBe("environment");
    moveBy("changes", 1);
    expect(order().at(-1)).toBe("changes");
    moveBy("context", 1);
    expect(order().indexOf("context")).toBe(3);
  });

  it("moveToTop and resetOrder", () => {
    const { moveToTop, resetOrder } = useAeSessionRailStore.getState();
    moveToTop("outputs");
    expect(order()[0]).toBe("outputs");
    resetOrder();
    expect(order()).toEqual([...AE_RAIL_SECTIONS]);
  });
});

describe("focusSection", () => {
  it("opens the rail, unfolds the section and bumps the request number", () => {
    const { focusSection } = useAeSessionRailStore.getState();
    focusSection("connectors");
    let state = useAeSessionRailStore.getState();
    expect(state.open).toBe(true);
    expect(state.sheetOpen).toBe(false);
    expect(state.folded.connectors).toBe(false);
    expect(state.focus).toEqual({ id: "connectors", seq: 1 });

    focusSection("connectors", { sheet: true });
    state = useAeSessionRailStore.getState();
    expect(state.sheetOpen).toBe(true);
    expect(state.focus).toEqual({ id: "connectors", seq: 2 });
  });
});

describe("persistence", () => {
  it("saves open state, order and folds, but not the phone sheet", () => {
    const store = useAeSessionRailStore.getState();
    store.setOpen(true);
    store.moveToTop("usage");
    store.setFolded("agents", true);
    store.setSheetOpen(true);
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved.open).toBe(true);
    expect(saved.order[0]).toBe("usage");
    expect(saved.folded.agents).toBe(true);
    expect(saved).not.toHaveProperty("sheetOpen");
  });

  it("reads a saved layout back, ignoring unknown ids", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        open: true,
        order: ["changes", "nope"],
        folded: { triage: true, nope: true, usage: "yes" },
      }),
    );
    vi.resetModules();
    const fresh = await import("./aeSessionRail");
    const state = fresh.useAeSessionRailStore.getState();
    expect(state.open).toBe(true);
    expect(state.order[0]).toBe("changes");
    expect(state.order).toHaveLength(AE_RAIL_SECTIONS.length);
    expect(state.folded).toEqual({ connectors: true, triage: true });
  });

  it("works with defaults when storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.resetModules();
    const fresh = await import("./aeSessionRail");
    const state = fresh.useAeSessionRailStore.getState();
    expect(state.open).toBe(false);
    expect(state.order).toEqual([...AE_RAIL_SECTIONS]);
    expect(() => state.setOpen(true)).not.toThrow();
    expect(setItem).toHaveBeenCalled();
    expect(fresh.useAeSessionRailStore.getState().open).toBe(true);
  });
});
