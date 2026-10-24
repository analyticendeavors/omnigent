// The sidebar's Triage grouping and Manual ordering (omnigent-ae, 2026-10-19),
// as the session list wires them in. The list publishes which list each row
// sits in to a small module store once per change; rows, project folders, the
// drag handlers and the Move menu read it through selectors, so a refresh
// re-renders only the rows whose list changed. One session list mounts at a
// time (the peek sidebar is the same instance), so the store is not keyed.
// In any Ordering, a drop on a row of the same list or a Move item reorders;
// outside Manual it first switches this device to Manual. A drop on a row of
// another list (another project folder, Sessions, or another Triage group)
// first files the row there or sets its status, then places it the same way.

import {
  type CollisionDetection,
  type DragMoveEvent,
  type Over,
  pointerWithin,
} from "@dnd-kit/core";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { showToast } from "@/components/ui/toast";
import type { Conversation } from "@/hooks/useConversations";
import {
  type AeOrderOp,
  aeFetchOrder,
  aeShowOrderError,
  useAeLoadAllPages,
  useAeOrderMover,
  useAeSidebarOrder,
} from "@/hooks/useAeSidebarOrder";
import type { SidebarListQuery } from "@/hooks/useSidebarData";
import type { AeStatus } from "@/lib/aeLabels";
import {
  type AeMoveTo,
  type AeOrderRow,
  aeApplyManualOrder,
  aeIsOrderId,
  aeMoveInOrder,
} from "@/lib/aeSessionOrder";
import {
  AE_TRIAGE_STATUS,
  type AeTriageGroup,
  type AeTriageRow,
  aeSortByTriage,
  aeTriageGroupOf,
} from "@/lib/aeTriage";
import type { SessionFilter } from "@/lib/sessionFilterPreferences";
import type { SidebarViewPreferences } from "@/lib/sidebarViewPreferences";
import { aeCachedRow, applyAeStatus } from "./AeStatusMenu";
import { type ActiveChatOverride, sortByUpdatedAtDesc } from "./sidebarNav";

interface AeSidebarState {
  /** The lists are published: the view options are on, not searching, not the Archived display. */
  listed: boolean;
  /** Manual ordering is on, outside search and the Archived display. */
  manual: boolean;
  /** The saved order while Manual is on, else `null`. */
  order: readonly string[] | null;
  /** Status ordering sorts rows by their status icon. */
  statusSort: boolean;
  /** Triage grouping is on. */
  triage: boolean;
  /** Triage groups held while the pointer is in the list. */
  frozenTriage: Map<string, AeTriageGroup> | null;
  /** During a drag, the row of another list under the pointer and the side the drop lands on. */
  crossSide: { id: string; side: "before" | "after" } | null;
  /** Each list's row ids as shown, by list key (`sessions`, `shared`, `group:…`, `folder:…`). */
  lists: ReadonlyMap<string, readonly string[]>;
  /** Each listed row's list key. */
  listOf: ReadonlyMap<string, string>;
  /** Every loaded row by ranking unit (see `aeMoveInOrder`), built when a move needs it. */
  units: (() => AeOrderRow[][]) | null;
  /** Applies and queues a change to the order. */
  move: ((op: AeOrderOp) => boolean) | null;
  queryClient: QueryClient | null;
  /** Switches this device's Ordering to Manual. */
  switchToManual: (() => void) | null;
}

const IDLE: AeSidebarState = {
  listed: false,
  manual: false,
  order: null,
  statusSort: false,
  triage: false,
  frozenTriage: null,
  crossSide: null,
  lists: new Map(),
  listOf: new Map(),
  units: null,
  move: null,
  queryClient: null,
  switchToManual: null,
};

export const useAeSidebarStore = create<AeSidebarState>(() => IDLE);

export const AE_MANUAL_SWITCH_TOAST =
  "Sessions are in Manual order now. Change it under the filter icon > Ordering.";

// Moves made outside Manual wait for a fresh read of the saved order; any move
// after them chains behind, so moves apply in the order they were made.
// Leaving Manual bumps the generation, which drops every move still waiting.
let chain: Promise<void> = Promise.resolve();
let waiting = 0;
let generation = 0;

function later(step: (current: () => boolean) => Promise<void> | void): void {
  const started = generation;
  const current = () => started === generation;
  waiting += 1;
  chain = chain
    .then(() => (current() ? step(current) : undefined))
    .catch(() => {})
    .finally(() => {
      waiting -= 1;
    });
}

/** Drop every move still waiting for the saved order. */
export function aeCancelPendingMoves(): void {
  generation += 1;
}

const NO_ORDER: readonly string[] = [];

type AeListRow = AeOrderRow & AeTriageRow;

/** Rows in the saved order while Manual is on, by status icon while Status is, else as given. */
function aeOrderRows<T extends AeListRow>(
  rows: T[],
  order: readonly string[] | null,
  statusSort: boolean,
  frozen: Map<string, AeTriageGroup> | null,
): T[] {
  if (order) return aeApplyManualOrder(rows, order);
  return statusSort ? aeSortByTriage(rows, frozen) : rows;
}

/** What the session list needs from the AE view options. */
export interface AeSidebarView {
  /** Rows are drop targets and offer Move: view options on, not searching, not Archived. */
  listed: boolean;
  manual: boolean;
  switchToManual: () => void;
  triage: boolean;
  order: readonly string[] | null;
  /** Status ordering sorts by status icon (Blocked first, Reference last), outside search and Archived. */
  statusSort: boolean;
  /** Triage groups held while the pointer is in the list. */
  frozenTriage: Map<string, AeTriageGroup> | null;
  /** Rows in the saved order while Manual is on, by status icon while Status is, else `rows`. */
  applyOrder: <T extends AeListRow>(rows: T[]) => T[];
  /** A row's Triage group while Triage is on, else `null`. */
  triageTitle: (conversation: Conversation) => AeTriageGroup | null;
  /** Triage's Archived group shows: not while searching, nor on the Shared and Archived displays. */
  archivedGroup: boolean;
}

export function useAeSidebarView({
  view,
  orderFrozen,
  conversationsQuery,
  searchQuery,
  activeTab,
  onViewChange,
  available,
}: {
  view: SidebarViewPreferences;
  orderFrozen: boolean;
  conversationsQuery: SidebarListQuery;
  searchQuery: string;
  activeTab: SessionFilter;
  onViewChange: (patch: Partial<SidebarViewPreferences>) => void;
  /** The sidebar_grouping_ui view options are on; without them Ordering cannot change. */
  available: boolean;
}): AeSidebarView {
  // Search results and archived rows keep upstream's order.
  const listed = available && !searchQuery && activeTab !== "archived";
  const manualOn = view.ordering === "manual" && listed;
  const statusSort = view.ordering === "status" && listed;
  const triage = view.grouping === "triage";
  const { data } = useAeSidebarOrder(manualOn);
  const order = manualOn ? (data?.order ?? NO_ORDER) : null;
  const switchToManual = useCallback(() => onViewChange({ ordering: "manual" }), [onViewChange]);
  // "By family" needs each lead loaded with its sessions (omnigent-ae, 2026-10-23).
  const family = view.grouping === "family";
  useAeLoadAllPages(conversationsQuery, listed && (manualOn || triage || statusSort || family));
  useEffect(() => {
    if (!manualOn) aeCancelPendingMoves();
  }, [manualOn]);
  // Like the Status grouping's frozen buckets: cleared once no hold remains.
  const frozenRef = useRef(new Map<string, AeTriageGroup>());
  useEffect(() => {
    if (!orderFrozen) frozenRef.current.clear();
  }, [orderFrozen]);
  const frozenTriage = orderFrozen ? frozenRef.current : null;
  const archivedGroup = triage && listed && activeTab !== "shared";
  return useMemo(
    () => ({
      listed,
      manual: order !== null,
      switchToManual,
      triage,
      order,
      statusSort,
      frozenTriage,
      applyOrder: <T extends AeListRow>(rows: T[]) =>
        aeOrderRows(rows, order, statusSort, frozenTriage),
      triageTitle: (conversation: Conversation) =>
        triage ? aeTriageGroupOf(conversation, frozenTriage) : null,
      archivedGroup,
    }),
    [listed, order, statusSort, switchToManual, triage, frozenTriage, archivedGroup],
  );
}

interface PublishedSections {
  shared: Conversation[];
  sessions: Conversation[];
  projectGroups: { name: string; conversations: Conversation[] }[];
  groupTitles: ReadonlyMap<string, string> | null;
  /** Grouping > Family's tree: each family is its own list, and a stand-in lead is in none. */
  aeTree?: {
    rows: ReadonlyMap<string, { family: { root: string } }>;
    standIns: ReadonlySet<string>;
    /** Closed-group rows: in no drop list and no ranking. */
    closed?: ReadonlyMap<string, unknown>;
  } | null;
}

/**
 * Publish each list's rows to the store while listed: Shared, Sessions or each
 * of its groups, and each project folder with its own loaded pages.
 */
export function useAePublishSidebarScopes(
  ae: AeSidebarView,
  sections: PublishedSections,
  folderConversations: ReadonlyMap<string, Conversation[]>,
  activeOverride: ActiveChatOverride | null,
  frozenKeys: Map<string, number> | null,
): void {
  const queryClient = useQueryClient();
  const move = useAeOrderMover();
  useLayoutEffect(() => {
    if (!ae.listed) {
      if (useAeSidebarStore.getState().listed) useAeSidebarStore.setState(IDLE);
      return;
    }
    const lists = new Map<string, string[]>();
    const add = (key: string, rows: readonly Conversation[]) => {
      if (rows.length === 0) return;
      const ids = lists.get(key) ?? [];
      for (const row of rows) ids.push(row.id);
      lists.set(key, ids);
    };
    add("shared", sections.shared);
    const titles = sections.groupTitles;
    if (titles) {
      const tree = sections.aeTree;
      for (const row of sections.sessions) {
        if (tree?.standIns.has(row.id) || tree?.closed?.has(row.id)) continue;
        const family = tree?.rows.get(row.id)?.family.root;
        add(family ? `family:${family}` : `group:${titles.get(row.id) ?? ""}`, [row]);
      }
    } else add("sessions", sections.sessions);
    for (const group of sections.projectGroups) {
      add(`folder:${group.name}`, folderConversations.get(group.name) ?? group.conversations);
    }
    const listOf = new Map<string, string>();
    for (const [key, ids] of lists) for (const id of ids) listOf.set(id, key);
    // The ranking units as the sidebar ranks them: the session list (Shared,
    // Sessions and every group together) and each folder. Manual ranks them in
    // updated order; any other Ordering seeds from what it shows.
    const manual = ae.manual;
    const units = () =>
      [
        [...sections.shared, ...sections.sessions],
        ...sections.projectGroups.map(
          (group) => folderConversations.get(group.name) ?? group.conversations,
        ),
      ].map((rows) =>
        (manual ? sortByUpdatedAtDesc(rows, activeOverride, frozenKeys) : rows)
          // A provisional `temp:` row (a session still being created) never enters the order.
          .filter((row) => aeIsOrderId(row.id) && !sections.aeTree?.closed?.has(row.id))
          .map(({ id, created_at }) => ({ id, created_at })),
      );
    useAeSidebarStore.setState({
      listed: true,
      manual,
      order: ae.order,
      statusSort: ae.statusSort,
      triage: ae.triage,
      frozenTriage: ae.frozenTriage,
      lists,
      listOf,
      units,
      move,
      queryClient,
      switchToManual: ae.switchToManual,
    });
  }, [ae, sections, folderConversations, activeOverride, frozenKeys, move, queryClient]);
  useLayoutEffect(
    () => () => {
      aeCancelPendingMoves();
      useAeSidebarStore.setState(IDLE);
    },
    [],
  );
}

/** A project folder's rows ordered like the session list: Manual's saved order, or Status's icons. */
export function useAeFolderOrder(): <T extends AeListRow>(rows: T[]) => T[] {
  const order = useAeSidebarStore((s) => s.order);
  const statusSort = useAeSidebarStore((s) => s.statusSort);
  const frozen = useAeSidebarStore((s) => s.frozenTriage);
  return useCallback(
    <T extends AeListRow>(rows: T[]) => aeOrderRows(rows, order, statusSort, frozen),
    [order, statusSort, frozen],
  );
}

/**
 * Move a row within its list, or within `list` when it is landing in another
 * one. Outside Manual, switch to Manual and make the move on a fresh read of
 * the saved order. False when the row is in no list or the move changes nothing.
 */
export function aeMoveRow(
  id: string,
  to: AeMoveTo,
  list = useAeSidebarStore.getState().listOf.get(id),
): boolean {
  const state = useAeSidebarStore.getState();
  const { move, units, queryClient, switchToManual } = state;
  const ids = list === undefined ? undefined : state.lists.get(list);
  const keep = list !== state.listOf.get(id);
  const scopeIds = ids && !ids.includes(id) ? [...ids, id] : ids;
  if (!state.listed || !move || !units || !scopeIds) return false;
  const op: AeOrderOp = { kind: "move", id, to, scopeIds, units: units(), ...(keep && { keep }) };
  if (state.manual) {
    if (waiting === 0) return move(op);
    later(() => {
      move(op);
    });
    return true;
  }
  if (!switchToManual || !queryClient) return false;
  // A move that would not change the list as shown switches nothing.
  if (!keep && aeMoveInOrder({ order: NO_ORDER, units: op.units, scopeIds, id, to }) === NO_ORDER) {
    return false;
  }
  switchToManual();
  showToast(AE_MANUAL_SWITCH_TOAST);
  later(async (current) => {
    try {
      await aeFetchOrder(queryClient);
    } catch (error) {
      if (!current()) return;
      // No move saves without a read: drop every move queued behind this one too.
      aeCancelPendingMoves();
      aeShowOrderError(error);
      return;
    }
    if (current()) move(op);
  });
  return true;
}

/** Where a row sits in its list, for the Move menu; `null` when unlisted. */
export type AeRowPlace = "only" | "first" | "last" | "middle";

export function aePlaceOf(state: AeSidebarState, id: string): AeRowPlace | null {
  const list = state.listed ? state.listOf.get(id) : undefined;
  const ids = list === undefined ? undefined : state.lists.get(list);
  if (!ids) return null;
  const index = ids.indexOf(id);
  if (ids.length === 1) return "only";
  if (index === 0) return "first";
  return index === ids.length - 1 ? "last" : "middle";
}

/** Which side of `targetId` a drag of `draggedId` lands on; `null` across lists. */
export function aeInsertionSide(draggedId: string, targetId: string): "before" | "after" | null {
  const state = useAeSidebarStore.getState();
  const list = state.listOf.get(draggedId);
  if (list === undefined || state.listOf.get(targetId) !== list) return null;
  const ids = state.lists.get(list) ?? [];
  return ids.indexOf(draggedId) < ids.indexOf(targetId) ? "after" : "before";
}

/** What a drop on a row of another list does before placing the row: file it, or set its status. */
export type AeCrossMove =
  | { kind: "project"; project: string }
  | { kind: "status"; group: AeTriageGroup; status: AeStatus | null };

/**
 * What dropping `draggedId` on `targetId` in another list does: into another
 * project folder or Sessions (`project` "" unfiles it), or into another Triage
 * group (its status, `null` for No status). `null` within one list, and for
 * Shared, the other groupings and rows in no list.
 */
export function aeCrossMove(
  state: Pick<AeSidebarState, "listOf" | "triage">,
  draggedId: string,
  targetId: string,
): AeCrossMove | null {
  const from = state.listOf.get(draggedId);
  const to = state.listOf.get(targetId);
  if (from === undefined || to === undefined || from === to) return null;
  const projectOf = (key: string) =>
    key === "sessions" ? "" : key.startsWith("folder:") ? key.slice("folder:".length) : null;
  const project = projectOf(to);
  if (project !== null && projectOf(from) !== null) return { kind: "project", project };
  if (!state.triage || !from.startsWith("group:") || !to.startsWith("group:")) return null;
  const group = to.slice("group:".length);
  if (!Object.hasOwn(AE_TRIAGE_STATUS, group)) return null;
  return {
    kind: "status",
    group: group as AeTriageGroup,
    status: AE_TRIAGE_STATUS[group as AeTriageGroup],
  };
}

/**
 * Upstream's `pointerWithin`, minus the row-order targets a drop cannot use:
 * those of other lists, except where `aeCrossMove` takes the row. A row in no
 * list (pinned or archived) sees none, so upstream's pin and filing drops
 * stand. A row target outranks the folder or Sessions target beneath it, so
 * the drop lands where the insertion line shows.
 */
export function aePointerWithin(args: Parameters<CollisionDetection>[0]) {
  const state = useAeSidebarStore.getState();
  const draggedId = String(args.active.id);
  const list = state.listOf.get(draggedId);
  const droppableContainers = args.droppableContainers.filter((container) => {
    const data = container.data.current;
    if (data?.type !== "ae-order") return true;
    if (list === undefined) return false;
    const targetId = String(data.id);
    return state.listOf.get(targetId) === list || aeCrossMove(state, draggedId, targetId) !== null;
  });
  const collisions = pointerWithin({ ...args, droppableContainers });
  const isRow = (collision: { id: unknown }) => String(collision.id).startsWith("ae-order:");
  return [...collisions.filter(isRow), ...collisions.filter((c) => !isRow(c))];
}

function pointerY({ activatorEvent, active, delta }: DragMoveEvent): number | null {
  if (activatorEvent instanceof MouseEvent) return activatorEvent.clientY + delta.y;
  if (typeof TouchEvent !== "undefined" && activatorEvent instanceof TouchEvent) {
    const touch = activatorEvent.touches[0] ?? activatorEvent.changedTouches[0];
    if (touch) return touch.clientY + delta.y;
  }
  const rect = active.rect.current.translated;
  return rect ? rect.top + rect.height / 2 : null;
}

/**
 * Track which half of another list's row the pointer is on, so the insertion
 * line and the drop agree. Within one list the side comes from the drag's
 * direction instead (`aeInsertionSide`).
 */
export function aeTrackDragMove(event: DragMoveEvent): void {
  const state = useAeSidebarStore.getState();
  const data = event.over?.data.current;
  let next: AeSidebarState["crossSide"] = null;
  if (event.over && data?.type === "ae-order") {
    const targetId = String(data.id);
    const y = pointerY(event);
    if (y !== null && aeCrossMove(state, String(event.active.id), targetId)) {
      const { top, height } = event.over.rect;
      next = { id: targetId, side: y < top + height / 2 ? "before" : "after" };
    }
  }
  const current = state.crossSide;
  if (current?.id !== next?.id || current?.side !== next?.side) {
    useAeSidebarStore.setState({ crossSide: next });
  }
}

/** Clear the drag's insertion side; a cancelled drag calls it, a drop does through `aeHandleOrderDrop`. */
export function aeEndDrag(): AeSidebarState["crossSide"] {
  const { crossSide } = useAeSidebarStore.getState();
  if (crossSide) useAeSidebarStore.setState({ crossSide: null });
  return crossSide;
}

/**
 * Set the status a drop into another Triage group means, then place the row,
 * chained behind any move still waiting so moves apply in the order made. The
 * new group is held under the pointer from the start, so the write's own
 * render draws it there; a refused or unchanged status (Working at the slot
 * limit, a row Blocked by an open question) puts the hold back.
 */
function aeDropIntoGroup(
  draggedId: string,
  move: Extract<AeCrossMove, { kind: "status" }>,
  to: AeMoveTo,
  list: string,
): void {
  later(async (current) => {
    const { queryClient, frozenTriage } = useAeSidebarStore.getState();
    if (!queryClient) return;
    const row = aeCachedRow(queryClient, draggedId) ?? { id: draggedId, labels: {} };
    const held = frozenTriage?.get(draggedId);
    frozenTriage?.set(draggedId, move.group);
    if (!(await applyAeStatus(queryClient, row, move.status))) {
      if (held === undefined) frozenTriage?.delete(draggedId);
      else frozenTriage?.set(draggedId, held);
      return;
    }
    if (current()) aeMoveRow(draggedId, to, list);
  });
}

/**
 * Handle a drop on a row-order target. True for every such target, the row
 * itself and a no-op included: upstream reads any target it does not know as
 * the Sessions list, which would take a filed session out of its folder. A
 * row of another list files the dragged row there through `fileTo` (a
 * project name, "" for Sessions) or sets its Triage status, then places it on
 * the side the insertion line showed.
 */
export function aeHandleOrderDrop(
  draggedId: string,
  over: Over | null,
  fileTo: (project: string) => void = () => {},
): boolean {
  const crossSide = aeEndDrag();
  const data = over?.data.current;
  if (data?.type !== "ae-order") return false;
  const targetId = String(data.id);
  if (targetId === draggedId) return true;
  const state = useAeSidebarStore.getState();
  const cross = aeCrossMove(state, draggedId, targetId);
  const side = cross
    ? crossSide?.id === targetId
      ? crossSide.side
      : "before"
    : aeInsertionSide(draggedId, targetId);
  if (!side) return true;
  const to = side === "after" ? { after: targetId } : { before: targetId };
  const list = state.listOf.get(targetId);
  if (cross?.kind === "status" && list !== undefined) {
    aeDropIntoGroup(draggedId, cross, to, list);
    return true;
  }
  if (cross?.kind === "project") fileTo(cross.project);
  aeMoveRow(draggedId, to, list);
  return true;
}
