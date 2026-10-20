// The sidebar's Triage grouping and Manual ordering (omnigent-ae, 2026-10-19),
// as the session list wires them in. The list publishes which list each row
// sits in to a small module store once per change; rows, project folders, the
// drag handlers and the Move menu read it through selectors, so a refresh
// re-renders only the rows whose list changed. One session list mounts at a
// time (the peek sidebar is the same instance), so the store is not keyed.
// In any Ordering, a drop on a row of the same list or a Move item reorders;
// outside Manual it first switches this device to Manual.

import { type CollisionDetection, type Over, pointerWithin } from "@dnd-kit/core";
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
import {
  type AeMoveTo,
  type AeOrderRow,
  aeApplyManualOrder,
  aeIsOrderId,
  aeMoveInOrder,
} from "@/lib/aeSessionOrder";
import { type AeTriageGroup, aeTriageGroupOf } from "@/lib/aeTriage";
import type { SessionFilter } from "@/lib/sessionFilterPreferences";
import type { SidebarViewPreferences } from "@/lib/sidebarViewPreferences";
import { type ActiveChatOverride, sortByUpdatedAtDesc } from "./sidebarNav";

interface AeSidebarState {
  /** The lists are published: the view options are on, not searching, not the Archived display. */
  listed: boolean;
  /** Manual ordering is on, outside search and the Archived display. */
  manual: boolean;
  /** The saved order while Manual is on, else `null`. */
  order: readonly string[] | null;
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

/** What the session list needs from the AE view options. */
export interface AeSidebarView {
  /** Rows are drop targets and offer Move: view options on, not searching, not Archived. */
  listed: boolean;
  manual: boolean;
  switchToManual: () => void;
  triage: boolean;
  order: readonly string[] | null;
  /** Triage groups held while the pointer is in the list. */
  frozenTriage: Map<string, AeTriageGroup> | null;
  /** Rows in the saved order while Manual is on; `rows` itself otherwise. */
  applyOrder: <T extends AeOrderRow>(rows: T[]) => T[];
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
  const triage = view.grouping === "triage";
  const { data } = useAeSidebarOrder(manualOn);
  const order = manualOn ? (data?.order ?? NO_ORDER) : null;
  const switchToManual = useCallback(() => onViewChange({ ordering: "manual" }), [onViewChange]);
  useAeLoadAllPages(conversationsQuery, listed && (manualOn || triage));
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
      frozenTriage,
      applyOrder: <T extends AeOrderRow>(rows: T[]) =>
        order ? aeApplyManualOrder(rows, order) : rows,
      triageTitle: (conversation: Conversation) =>
        triage ? aeTriageGroupOf(conversation, frozenTriage) : null,
      archivedGroup,
    }),
    [listed, order, switchToManual, triage, frozenTriage, archivedGroup],
  );
}

interface PublishedSections {
  shared: Conversation[];
  sessions: Conversation[];
  projectGroups: { name: string; conversations: Conversation[] }[];
  groupTitles: ReadonlyMap<string, string> | null;
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
      for (const row of sections.sessions) add(`group:${titles.get(row.id) ?? ""}`, [row]);
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
          .filter((row) => aeIsOrderId(row.id))
          .map(({ id, created_at }) => ({ id, created_at })),
      );
    useAeSidebarStore.setState({
      listed: true,
      manual,
      order: ae.order,
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

/** A project folder's rows in the saved order while Manual is on. */
export function useAeFolderOrder(): <T extends AeOrderRow>(rows: T[]) => T[] {
  const order = useAeSidebarStore((s) => s.order);
  return useCallback(
    <T extends AeOrderRow>(rows: T[]) => (order ? aeApplyManualOrder(rows, order) : rows),
    [order],
  );
}

/**
 * Move a row within its list. Outside Manual, switch to Manual and make the
 * move on a fresh read of the saved order. False when the row is in no list
 * or the move changes nothing.
 */
export function aeMoveRow(id: string, to: AeMoveTo): boolean {
  const state = useAeSidebarStore.getState();
  const { move, units, queryClient, switchToManual } = state;
  const list = state.listOf.get(id);
  const scopeIds = list === undefined ? undefined : state.lists.get(list);
  if (!state.listed || !move || !units || !scopeIds) return false;
  const op: AeOrderOp = { kind: "move", id, to, scopeIds, units: units() };
  if (state.manual) {
    if (waiting === 0) return move(op);
    later(() => {
      move(op);
    });
    return true;
  }
  if (!switchToManual || !queryClient) return false;
  // A move that would not change the list as shown switches nothing.
  if (aeMoveInOrder({ order: NO_ORDER, units: op.units, scopeIds, id, to }) === NO_ORDER) {
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

/**
 * Upstream's `pointerWithin`, minus the row-order targets of every list but
 * the dragged row's own, so a drop on a row elsewhere falls through to the
 * folder, Pinned or Sessions target beneath it. A row in no list (pinned or
 * archived) sees none, so upstream's pin and filing drops stand.
 */
export function aePointerWithin(args: Parameters<CollisionDetection>[0]) {
  const state = useAeSidebarStore.getState();
  const list = state.listOf.get(String(args.active.id));
  const droppableContainers = args.droppableContainers.filter((container) => {
    const data = container.data.current;
    if (data?.type !== "ae-order") return true;
    return list !== undefined && state.listOf.get(String(data.id)) === list;
  });
  return pointerWithin({ ...args, droppableContainers });
}

/**
 * Handle a drop on a row-order target. True for every such target, the row
 * itself and a no-op included: upstream reads any target it does not know as
 * the Sessions list, which would take a filed session out of its folder.
 */
export function aeHandleOrderDrop(draggedId: string, over: Over | null): boolean {
  const data = over?.data.current;
  if (data?.type !== "ae-order") return false;
  const targetId = String(data.id);
  const side = targetId === draggedId ? null : aeInsertionSide(draggedId, targetId);
  if (side) aeMoveRow(draggedId, side === "after" ? { after: targetId } : { before: targetId });
  return true;
}
