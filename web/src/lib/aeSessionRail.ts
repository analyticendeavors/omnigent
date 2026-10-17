// The session rail (omnigent-ae, 2026-10-17): a right-hand column of folding
// sections about the open session, reordered by drag (or the section menu on
// a phone). Open state, order and folds are per device; the phone sheet's
// open state is not saved.

import { useSyncExternalStore } from "react";
import { create } from "zustand";

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

interface Persisted {
  open: boolean;
  order: AeRailSectionId[];
  folded: Partial<Record<AeRailSectionId, boolean>>;
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
    order: [...AE_RAIL_SECTIONS],
    folded: defaultFolded(),
  };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const folded: Partial<Record<AeRailSectionId, boolean>> = { ...fallback.folded };
    if (parsed.folded && typeof parsed.folded === "object") {
      for (const [id, value] of Object.entries(parsed.folded)) {
        if (isSectionId(id) && typeof value === "boolean") folded[id] = value;
      }
    }
    return { open: parsed.open === true, order: normalizeOrder(parsed.order), folded };
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
  setSheetOpen: (open: boolean) => void;
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
  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),
  setSheetOpen: (sheetOpen) => set({ sheetOpen }),
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
      ...(opts?.sheet ? { sheetOpen: true } : { open: true }),
      folded: { ...state.folded, [id]: false },
      focus: { id, seq: (state.focus?.seq ?? 0) + 1 },
    })),
}));

useAeSessionRailStore.subscribe((state, previous) => {
  if (
    state.open !== previous.open ||
    state.order !== previous.order ||
    state.folded !== previous.folded
  ) {
    writePersisted({ open: state.open, order: state.order, folded: state.folded });
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
