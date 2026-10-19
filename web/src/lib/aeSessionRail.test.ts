import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AE_RAIL_SECTIONS,
  aeRailIsPromotedSession,
  aeRailForgetRestoredSession,
  aeRailRestoredPanelOpen,
  aeRailSkipsRestoredPanel,
  normalizeOrder,
  useAeSessionRailStore,
  type AeRailSectionId,
} from "./aeSessionRail";
import { aeRecordTempPromotion } from "./aeTempPromotions";

const STORAGE_KEY = "ae.sessionRail.v1";

function order(): AeRailSectionId[] {
  return useAeSessionRailStore.getState().order;
}

beforeEach(() => {
  window.localStorage.clear();
  useAeSessionRailStore.setState({
    open: false,
    closedForPanel: false,
    sheetOpen: false,
    order: [...AE_RAIL_SECTIONS],
    folded: { connectors: true },
    focus: null,
    openInEverySession: true,
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

describe("closing for a panel", () => {
  it("reopens on its own call, and the user opening or closing the rail forgets it", () => {
    const store = useAeSessionRailStore.getState();
    store.setOpen(true);
    store.setClosedForPanel(true);
    expect(useAeSessionRailStore.getState()).toMatchObject({ open: false, closedForPanel: true });
    store.setClosedForPanel(false);
    expect(useAeSessionRailStore.getState()).toMatchObject({ open: true, closedForPanel: false });
    store.setClosedForPanel(true);
    store.toggle();
    expect(useAeSessionRailStore.getState()).toMatchObject({ open: true, closedForPanel: false });
    store.setClosedForPanel(true);
    store.setOpen(false);
    expect(useAeSessionRailStore.getState().closedForPanel).toBe(false);
    store.setClosedForPanel(true);
    store.focusSection("usage");
    expect(useAeSessionRailStore.getState()).toMatchObject({ open: true, closedForPanel: false });
  });
});

describe("persistence", () => {
  it("saves open state, order and folds, but not the phone sheet", () => {
    const store = useAeSessionRailStore.getState();
    store.setOpen(true);
    store.moveToTop("usage");
    store.setFolded("agents", true);
    store.setSheetOpen(true);
    let saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved.open).toBe(true);
    expect(saved.order[0]).toBe("usage");
    expect(saved.folded.agents).toBe(true);
    expect(saved).not.toHaveProperty("sheetOpen");
    store.setClosedForPanel(true);
    saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved).toMatchObject({ open: false, closedForPanel: true });
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

  it("reads a rail waiting for room back, but drops the mark on an open rail", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: false, closedForPanel: true }));
    vi.resetModules();
    let fresh = await import("./aeSessionRail");
    expect(fresh.useAeSessionRailStore.getState()).toMatchObject({
      open: false,
      closedForPanel: true,
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: true, closedForPanel: true }));
    vi.resetModules();
    fresh = await import("./aeSessionRail");
    expect(fresh.useAeSessionRailStore.getState()).toMatchObject({
      open: true,
      closedForPanel: false,
    });
  });

  it("opens in every session by default, saves the choice and reads it back", async () => {
    vi.resetModules();
    let fresh = await import("./aeSessionRail");
    expect(fresh.useAeSessionRailStore.getState().openInEverySession).toBe(true);
    fresh.useAeSessionRailStore.getState().setOpenInEverySession(false);
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(saved.openInEverySession).toBe(false);
    vi.resetModules();
    fresh = await import("./aeSessionRail");
    expect(fresh.useAeSessionRailStore.getState().openInEverySession).toBe(false);
  });

  it("loads a layout saved before the preference existed, with the preference on", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ open: false, closedForPanel: false, order: ["usage"], folded: {} }),
    );
    vi.resetModules();
    const fresh = await import("./aeSessionRail");
    const state = fresh.useAeSessionRailStore.getState();
    expect(state.openInEverySession).toBe(true);
    expect(state.order[0]).toBe("usage");
    expect(state.open).toBe(false);
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
    expect(state.openInEverySession).toBe(true);
    expect(() => state.setOpen(true)).not.toThrow();
    expect(setItem).toHaveBeenCalled();
    expect(fresh.useAeSessionRailStore.getState().open).toBe(true);
  });
});

describe("aeRailSkipsRestoredPanel", () => {
  const base = { everySession: true, isMobile: false, urlSignal: false, viewport: 1280 };

  it("skips the panel only when the rail opens in every session on a desktop and they do not fit", () => {
    // 1280 - (320 + 488) - 304 leaves the chat 168 px.
    expect(aeRailSkipsRestoredPanel({ ...base, reserved: 808 })).toBe(true);
    // 1920 - 808 - 304 leaves it 808 px: both fit.
    expect(aeRailSkipsRestoredPanel({ ...base, viewport: 1920, reserved: 808 })).toBe(false);
    expect(aeRailSkipsRestoredPanel({ ...base, everySession: false, reserved: 808 })).toBe(false);
    expect(aeRailSkipsRestoredPanel({ ...base, isMobile: true, reserved: 808 })).toBe(false);
    expect(aeRailSkipsRestoredPanel({ ...base, urlSignal: true, reserved: 808 })).toBe(false);
  });
});

describe("aeRailRestoredPanelOpen", () => {
  const desktop = { sidebarWidth: 320, panelWidth: 480 };

  let phone = false;
  const matchMedia = window.matchMedia;

  beforeEach(() => {
    phone = false;
    aeRailForgetRestoredSession();
    useAeSessionRailStore.setState({ openInEverySession: true });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    window.matchMedia = ((query: string) => ({ ...matchMedia(query), matches: !phone })) as never;
  });

  afterEach(() => {
    window.matchMedia = matchMedia;
  });

  it("starts a panel that would not fit closed, and saves nothing", () => {
    const before = { ...window.localStorage };
    expect(aeRailRestoredPanelOpen("s-1", true, desktop)).toBe(false);
    expect({ ...window.localStorage }).toEqual(before);
  });

  it("keeps the panel when it fits, when a URL asks for it, on a phone, or when the setting is off", () => {
    expect(
      aeRailRestoredPanelOpen("s-1", true, { ...desktop, sidebarWidth: 0, panelWidth: 240 }),
    ).toBe(true);
    expect(aeRailRestoredPanelOpen("s-1", true, { ...desktop, urlSignal: true })).toBe(true);
    phone = true;
    expect(aeRailRestoredPanelOpen("s-1", true, desktop)).toBe(true);
    useAeSessionRailStore.setState({ openInEverySession: false });
    expect(aeRailRestoredPanelOpen("s-1", true, desktop)).toBe(true);
    expect(aeRailRestoredPanelOpen("s-1", false, desktop)).toBe(false);
  });

  it("measures a panel of unknown width at its minimum", () => {
    // 1280 - (320 + 248) - 304 leaves the chat 408 px: still too narrow.
    expect(aeRailRestoredPanelOpen("s-1", true, { sidebarWidth: 320 })).toBe(false);
  });

  it("keeps a new chat's panel as it was when its temp id becomes its own server id", () => {
    aeRailRestoredPanelOpen("temp:abc", true, desktop);
    aeRecordTempPromotion("temp:abc", "s-new");
    expect(aeRailIsPromotedSession("s-other")).toBe(false);
    expect(aeRailIsPromotedSession("s-new")).toBe(true);
    expect(aeRailRestoredPanelOpen("s-new", true, desktop)).toBe(true);
  });

  it("treats a move from an unsent new chat to an unrelated session as a switch", () => {
    aeRailRestoredPanelOpen("temp:unsent", false, desktop);
    expect(aeRailIsPromotedSession("s-b")).toBe(false);
    expect(aeRailRestoredPanelOpen("s-b", true, desktop)).toBe(false);
  });

  it("forgets the temp id when the shell shows no session", () => {
    aeRailRestoredPanelOpen("temp:abc", false, desktop);
    aeRecordTempPromotion("temp:abc", "s-new");
    aeRailForgetRestoredSession();
    expect(aeRailIsPromotedSession("s-new")).toBe(false);
  });
});
