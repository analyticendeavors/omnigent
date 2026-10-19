// The sidebar's Triage grouping and Manual ordering (omnigent-ae, 2026-10-19),
// as the session list wires them in. The list publishes which list each row
// sits in to a small module store once per change; rows, project folders, the
// drag handlers and the Move menu read it through selectors, so a refresh
// re-renders only the rows whose list changed. One session list mounts at a
// time (the peek sidebar is the same instance), so the store is not keyed.

import { type CollisionDetection, type Over, pointerWithin } from "@dnd-kit/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import type { Conversation } from "@/hooks/useConversations";
import {
  type AeOrderOp,
  useAeLoadAllPages,
  useAeOrderMover,
  useAeSidebarOrder,
} from "@/hooks/useAeSidebarOrder";
import type { SidebarListQuery } from "@/hooks/useSidebarData";
import { type AeMoveTo, aeApplyManualOrder, aeIsOrderId } from "@/lib/aeSessionOrder";
import { type AeTriageGroup, aeTriageGroupOf } from "@/lib/aeTriage";
import type { SessionFilter } from "@/lib/sessionFilterPreferences";
import type { SidebarViewPreferences } from "@/lib/sidebarViewPreferences";
import {
  type ActiveChatOverride,
  dedupeConversationsById,
  sortByUpdatedAtDesc,
} from "./sidebarNav";

interface AeSidebarState {
  /** Manual ordering is on, outside search and the Archived display. */
  manual: boolean;
  /** The saved order while Manual is on, else `null`. */
  order: readonly string[] | null;
  /** Each list's row ids as shown, by list key (`sessions`, `shared`, `group:…`, `folder:…`). */
  lists: ReadonlyMap<string, readonly string[]>;
  /** Each listed row's list key. */
  listOf: ReadonlyMap<string, string>;
  /** Every loaded row, in the lists' own (updated) order. */
  loadedIds: readonly string[];
  /** Applies and queues a change to the order. */
  move: ((op: AeOrderOp) => boolean) | null;
}

const IDLE: AeSidebarState = {
  manual: false,
  order: null,
  lists: new Map(),
  listOf: new Map(),
  loadedIds: [],
  move: null,
};

export const useAeSidebarStore = create<AeSidebarState>(() => IDLE);

const NO_ORDER: readonly string[] = [];

/** What the session list needs from the AE view options. */
export interface AeSidebarView {
  manual: boolean;
  triage: boolean;
  order: readonly string[] | null;
  /** Triage groups held while the pointer is in the list. */
  frozenTriage: Map<string, AeTriageGroup> | null;
  /** Rows in the saved order while Manual is on; `rows` itself otherwise. */
  applyOrder: <T extends { id: string }>(rows: T[]) => T[];
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
}: {
  view: SidebarViewPreferences;
  orderFrozen: boolean;
  conversationsQuery: SidebarListQuery;
  searchQuery: string;
  activeTab: SessionFilter;
}): AeSidebarView {
  // Search results and archived rows keep upstream's order.
  const listed = !searchQuery && activeTab !== "archived";
  const manualOn = view.ordering === "manual" && listed;
  const triage = view.grouping === "triage";
  const { data } = useAeSidebarOrder(manualOn);
  const order = manualOn ? (data?.order ?? NO_ORDER) : null;
  useAeLoadAllPages(conversationsQuery, listed && (manualOn || triage));
  // Like the Status grouping's frozen buckets: cleared once no hold remains.
  const frozenRef = useRef(new Map<string, AeTriageGroup>());
  useEffect(() => {
    if (!orderFrozen) frozenRef.current.clear();
  }, [orderFrozen]);
  const frozenTriage = orderFrozen ? frozenRef.current : null;
  const archivedGroup = triage && listed && activeTab !== "shared";
  return useMemo(
    () => ({
      manual: order !== null,
      triage,
      order,
      frozenTriage,
      applyOrder: <T extends { id: string }>(rows: T[]) =>
        order ? aeApplyManualOrder(rows, order) : rows,
      triageTitle: (conversation: Conversation) =>
        triage ? aeTriageGroupOf(conversation, frozenTriage) : null,
      archivedGroup,
    }),
    [order, triage, frozenTriage, archivedGroup],
  );
}

interface PublishedSections {
  shared: Conversation[];
  sessions: Conversation[];
  projectGroups: { name: string; conversations: Conversation[] }[];
  groupTitles: ReadonlyMap<string, string> | null;
}

/**
 * Publish each list's rows to the store while Manual is on: Shared, Sessions
 * or each of its groups, and each project folder with its own loaded pages.
 */
export function useAePublishSidebarScopes(
  ae: AeSidebarView,
  sections: PublishedSections,
  folderConversations: ReadonlyMap<string, Conversation[]>,
  activeOverride: ActiveChatOverride | null,
  frozenKeys: Map<string, number> | null,
): void {
  const move = useAeOrderMover();
  useLayoutEffect(() => {
    if (!ae.manual) {
      if (useAeSidebarStore.getState().manual) useAeSidebarStore.setState(IDLE);
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
    const rows = dedupeConversationsById([
      ...sections.shared,
      ...sections.sessions,
      ...sections.projectGroups.flatMap((group) => group.conversations),
      ...[...folderConversations.values()].flat(),
    ]);
    // A provisional `temp:` row (a session still being created) never enters the order.
    const loadedIds = sortByUpdatedAtDesc(rows, activeOverride, frozenKeys)
      .map((row) => row.id)
      .filter(aeIsOrderId);
    useAeSidebarStore.setState({ manual: true, order: ae.order, lists, listOf, loadedIds, move });
  }, [ae.manual, ae.order, sections, folderConversations, activeOverride, frozenKeys, move]);
  useLayoutEffect(() => () => useAeSidebarStore.setState(IDLE), []);
}

/** A project folder's rows in the saved order while Manual is on. */
export function useAeFolderOrder(): <T extends { id: string }>(rows: T[]) => T[] {
  const order = useAeSidebarStore((s) => s.order);
  return useCallback(
    <T extends { id: string }>(rows: T[]) => (order ? aeApplyManualOrder(rows, order) : rows),
    [order],
  );
}

/** Move a row within its list. False when it is in no list or the move changes nothing. */
export function aeMoveRow(id: string, to: AeMoveTo): boolean {
  const state = useAeSidebarStore.getState();
  const list = state.listOf.get(id);
  const scopeIds = list === undefined ? undefined : state.lists.get(list);
  if (!state.manual || !state.move || !scopeIds) return false;
  return state.move({ kind: "move", id, to, scopeIds, loadedIds: state.loadedIds });
}

/** Where a row sits in its list, for the Move menu; `null` outside Manual or any list. */
export type AeRowPlace = "only" | "first" | "last" | "middle";

export function aePlaceOf(state: AeSidebarState, id: string): AeRowPlace | null {
  const list = state.manual ? state.listOf.get(id) : undefined;
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
 * folder, Pinned or Sessions target beneath it, as it does outside Manual.
 */
export function aePointerWithin(args: Parameters<CollisionDetection>[0]) {
  const state = useAeSidebarStore.getState();
  const list = state.manual ? state.listOf.get(String(args.active.id)) : undefined;
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
