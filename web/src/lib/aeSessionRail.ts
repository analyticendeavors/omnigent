// The session rail (omnigent-ae, 2026-10-17): a right-hand column of folding
// sections about the open session, reordered by drag (or the section menu on
// a phone). Open state, order, folds and what a session shows when it opens
// are per device; the phone sheet's open state is not saved.

import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { aeTempPromotedTo } from "@/lib/aeTempPromotions";
import { isTempConvId } from "@/lib/tempConversationId";

export const AE_RAIL_SECTIONS = [
  "triage",
  "environment",
  "context",
  "agents",
  "scheduled",
  "usage",
  "connectors",
  "sent",
  "outputs",
  "changes",
] as const;

export type AeRailSectionId = (typeof AE_RAIL_SECTIONS)[number];

export const AE_RAIL_TITLES: Record<AeRailSectionId, string> = {
  triage: "Triage",
  environment: "Environment",
  context: "Context",
  agents: "Agents",
  scheduled: "Scheduled",
  usage: "Usage",
  connectors: "Connectors",
  sent: "Sent files",
  outputs: "Outputs",
  changes: "Changes",
};

/** Sections folded until the person unfolds them on this device. */
export const AE_RAIL_DEFAULT_FOLDED: readonly AeRailSectionId[] = ["connectors"];

/** Props every section component receives from the rail. */
export interface AeRailSectionProps {
  /** The session the rail describes (the chat in view). */
  sessionId: string;
}

const STORAGE_KEY = "ae.sessionRail.v1";

/**
 * What a desktop session shows when it opens (Settings > Chat, 2026-10-22):
 * `rail` opens the rail and starts a restored workspace panel closed, `both`
 * keeps that panel when the two fit, `panel` leaves the rail alone and the
 * panel as it was. A URL signal (file, agents, comment) opens the panel in all three.
 */
export type AeSessionOpenView = "rail" | "both" | "panel";

export const AE_SESSION_OPEN_VIEWS: readonly AeSessionOpenView[] = ["rail", "both", "panel"];

function isSessionOpenView(value: unknown): value is AeSessionOpenView {
  return typeof value === "string" && (AE_SESSION_OPEN_VIEWS as readonly string[]).includes(value);
}

interface Persisted {
  open: boolean;
  /** The rail closed to make room for a panel, not by the user; it reopens once the room is back. */
  closedForPanel: boolean;
  order: AeRailSectionId[];
  folded: Partial<Record<AeRailSectionId, boolean>>;
  /** What a session shows when it opens (desktop only). */
  sessionOpenView: AeSessionOpenView;
}

/** The choice saved, or the old "Open the session rail in every session" switch: off was `panel`, on or unset is `rail`. */
function readSessionOpenView(saved: { sessionOpenView?: unknown; openInEverySession?: unknown }) {
  if (isSessionOpenView(saved.sessionOpenView)) return saved.sessionOpenView;
  return saved.openInEverySession === false ? "panel" : "rail";
}

function isSectionId(value: unknown): value is AeRailSectionId {
  return typeof value === "string" && (AE_RAIL_SECTIONS as readonly string[]).includes(value);
}

/** Known ids in the saved order, then any section added since, in default order. */
export function normalizeOrder(saved: unknown): AeRailSectionId[] {
  const kept = Array.isArray(saved) ? saved.filter(isSectionId) : [];
  const unique = [...new Set(kept)];
  return [...unique, ...AE_RAIL_SECTIONS.filter((id) => !unique.includes(id))];
}

function defaultFolded(): Partial<Record<AeRailSectionId, boolean>> {
  return Object.fromEntries(AE_RAIL_DEFAULT_FOLDED.map((id) => [id, true]));
}

function readPersisted(): Persisted {
  const fallback: Persisted = {
    open: false,
    closedForPanel: false,
    order: [...AE_RAIL_SECTIONS],
    folded: defaultFolded(),
    sessionOpenView: "rail",
  };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Persisted> & { openInEverySession?: unknown };
    const folded: Partial<Record<AeRailSectionId, boolean>> = { ...fallback.folded };
    if (parsed.folded && typeof parsed.folded === "object") {
      for (const [id, value] of Object.entries(parsed.folded)) {
        if (isSectionId(id) && typeof value === "boolean") folded[id] = value;
      }
    }
    return {
      open: parsed.open === true,
      // Only a closed rail can be waiting for room.
      closedForPanel: parsed.closedForPanel === true && parsed.open !== true,
      order: normalizeOrder(parsed.order),
      folded,
      sessionOpenView: readSessionOpenView(parsed),
    };
  } catch {
    return fallback;
  }
}

function writePersisted(state: Persisted): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Blocked storage: the layout lasts until the page reloads.
  }
}

export interface AeRailFocus {
  id: AeRailSectionId;
  /** Increments per request, so asking twice for the same section scrolls twice. */
  seq: number;
}

interface AeSessionRailState extends Persisted {
  /** The phone sheet; never saved, so a reload does not reopen it full screen. */
  sheetOpen: boolean;
  focus: AeRailFocus | null;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Close the rail for a panel that needs the room (true), or reopen it once the room is back (false). */
  setClosedForPanel: (closed: boolean) => void;
  setSheetOpen: (open: boolean) => void;
  setSessionOpenView: (view: AeSessionOpenView) => void;
  setFolded: (id: AeRailSectionId, folded: boolean) => void;
  /** Move a section to an index in the current order (drag and drop). */
  moveTo: (id: AeRailSectionId, index: number) => void;
  /** Move a section up (-1) or down (+1); the phone menu's Move up and Move down. */
  moveBy: (id: AeRailSectionId, delta: number) => void;
  moveToTop: (id: AeRailSectionId) => void;
  resetOrder: () => void;
  /** Open the rail (or the phone sheet), unfold the section and scroll it into view. */
  focusSection: (id: AeRailSectionId, opts?: { sheet?: boolean }) => void;
}

export const useAeSessionRailStore = create<AeSessionRailState>((set, get) => ({
  ...readPersisted(),
  sheetOpen: false,
  focus: null,
  // The user opening or closing the rail ends any wait for room.
  setOpen: (open) => set({ open, closedForPanel: false }),
  toggle: () => set({ open: !get().open, closedForPanel: false }),
  setClosedForPanel: (closed) => set({ open: !closed, closedForPanel: closed }),
  setSheetOpen: (sheetOpen) => set({ sheetOpen }),
  setSessionOpenView: (sessionOpenView) => set({ sessionOpenView }),
  setFolded: (id, folded) => set({ folded: { ...get().folded, [id]: folded } }),
  moveTo: (id, index) => {
    const order = get().order.filter((other) => other !== id);
    const at = Math.max(0, Math.min(index, order.length));
    order.splice(at, 0, id);
    set({ order });
  },
  moveBy: (id, delta) => {
    const index = get().order.indexOf(id);
    if (index < 0) return;
    get().moveTo(id, index + delta);
  },
  moveToTop: (id) => get().moveTo(id, 0),
  resetOrder: () => set({ order: [...AE_RAIL_SECTIONS] }),
  focusSection: (id, opts) =>
    set((state) => ({
      ...(opts?.sheet ? { sheetOpen: true } : { open: true, closedForPanel: false }),
      folded: { ...state.folded, [id]: false },
      focus: { id, seq: (state.focus?.seq ?? 0) + 1 },
    })),
}));

/** The docked rail's width. */
export const AE_RAIL_WIDTH_PX = 304;
/** The narrowest chat the rail docks beside: the floor upstream's workspace panel keeps too. */
const CHAT_MIN_WIDTH_PX = 480;
/** The gap upstream keeps between the chat and the open workspace panel. */
const WORKSPACE_GAP_PX = 8;
/** The workspace panel's minimum width, for a restore that runs before its width is known. */
const PANEL_MIN_WIDTH_PX = 240;

/** True when the window, less the rest of the row, cannot fit the rail beside a 480 px chat. */
export function aeRailFloats(viewportWidth: number, reservedWidth: number) {
  return viewportWidth - reservedWidth - AE_RAIL_WIDTH_PX < CHAT_MIN_WIDTH_PX;
}

/** The row's width that is not the chat's: the sidebar, workspace panel (with its gap) and push panel. */
export function aeRailReservedWidth(
  sidebarWidth: number,
  workspacePanelWidth: number,
  pushPanelWidth: number,
) {
  const workspace = workspacePanelWidth > 0 ? workspacePanelWidth + WORKSPACE_GAP_PX : 0;
  return sidebarWidth + workspace + pushPanelWidth;
}

/** True when a session switch opens the rail on a desktop. */
export function aeRailOpensOnSwitch(view: AeSessionOpenView): boolean {
  return view !== "panel";
}

/** True when a restored panel starts closed: desktop, no URL signal, and `rail`, or `both` without the room. */
export function aeRailSkipsRestoredPanel(opts: {
  view: AeSessionOpenView;
  isMobile: boolean;
  urlSignal: boolean;
  viewport: number;
  reserved: number;
}): boolean {
  if (opts.view === "panel" || opts.isMobile || opts.urlSignal) return false;
  return opts.view === "rail" || aeRailFloats(opts.viewport, opts.reserved);
}

// The session id the shell last restored panels for, temp ids included.
let restoredSession: string | null = null;

/** True when *sessionId* is the server id the last restored temp id became. */
export function aeRailIsPromotedSession(sessionId: string): boolean {
  return restoredSession !== null && aeTempPromotedTo(restoredSession) === sessionId;
}

/** A restored workspace-panel open state, closed when `aeRailSkipsRestoredPanel` says so; never saved. */
export function aeRailRestoredPanelOpen(
  conversationId: string,
  open: boolean,
  opts: { sidebarWidth: number; panelWidth?: number; urlSignal?: boolean },
): boolean {
  const promoted = aeRailIsPromotedSession(conversationId);
  restoredSession = conversationId;
  const chosen = useAeSessionRailStore.getState().sessionOpenView;
  // A new chat's temp id draws no rail, so `rail` there keeps a panel that fits.
  const view = chosen === "rail" && isTempConvId(conversationId) ? "both" : chosen;
  if (!open || promoted || view === "panel" || typeof window === "undefined") return open;
  const panel = opts.panelWidth || PANEL_MIN_WIDTH_PX;
  return !aeRailSkipsRestoredPanel({
    view,
    // The shell's phone breakpoint (Tailwind `md`).
    isMobile: !window.matchMedia?.("(min-width: 768px)").matches,
    urlSignal: opts.urlSignal ?? false,
    viewport: window.innerWidth,
    reserved: aeRailReservedWidth(opts.sidebarWidth, panel, 0),
  });
}

/** Forget the restored session, when the shell shows none (home, the new chat page). */
export function aeRailForgetRestoredSession(): void {
  restoredSession = null;
}

useAeSessionRailStore.subscribe((state, previous) => {
  if (
    state.open !== previous.open ||
    state.closedForPanel !== previous.closedForPanel ||
    state.order !== previous.order ||
    state.folded !== previous.folded ||
    state.sessionOpenView !== previous.sessionOpenView
  ) {
    writePersisted({
      open: state.open,
      closedForPanel: state.closedForPanel,
      order: state.order,
      folded: state.folded,
      sessionOpenView: state.sessionOpenView,
    });
  }
});

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

function pageVisible(): boolean {
  return document.visibilityState !== "hidden";
}

/** False while the tab is in the background. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, pageVisible, () => true);
}

/** Whether a section is unfolded on this device. */
export function useAeRailSectionOpen(id: AeRailSectionId): boolean {
  return useAeSessionRailStore((s) => !s.folded[id]);
}

/**
 * True while the section's body is on screen: the rail (or phone sheet) is
 * open, the section unfolded, and the tab visible. Sections gate their
 * fetches and polling on it.
 */
export function useAeRailSectionActive(id: AeRailSectionId): boolean {
  const railShown = useAeSessionRailStore((s) => s.open || s.sheetOpen);
  const unfolded = useAeRailSectionOpen(id);
  const visible = usePageVisible();
  return railShown && unfolded && visible;
}
