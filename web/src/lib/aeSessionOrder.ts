// The sidebar's manual session order (omnigent-ae, 2026-10-19): one saved list
// of session ids per user (`GET` and `PUT /v1/ae/sidebar`) ranks every list the
// sidebar shows, Sessions, Shared, each project folder and each group alike.
// A session the saved order does not hold sorts above the ranked ones, in the
// list's own order, so a new session lands on top of its list.

/** The most ids the server keeps; it refuses a longer order. */
export const AE_ORDER_MAX = 500;

/** Session ids are 32 lowercase hex; a provisional `temp:` row's id never enters the order. */
const SESSION_ID_RE = /^[0-9a-f]{32}$/;

export function aeIsOrderId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/** Where a move puts the session, within its own list. */
export type AeMoveTo = "top" | "up" | "down" | "bottom" | { before: string } | { after: string };

// One rank map per saved order, shared by every list that applies it.
const ranks = new WeakMap<readonly string[], Map<string, number>>();

function rankOf(order: readonly string[]): Map<string, number> {
  let rank = ranks.get(order);
  if (!rank) {
    rank = new Map(order.map((id, index) => [id, index]));
    ranks.set(order, rank);
  }
  return rank;
}

/**
 * Rows in manual order: the ones `order` does not hold first, in their
 * incoming order, then the rest by rank. An empty order returns `rows` itself.
 */
export function aeApplyManualOrder<T extends { id: string }>(
  rows: T[],
  order: readonly string[],
): T[] {
  if (order.length === 0) return rows;
  const rank = rankOf(order);
  const unranked = rows.filter((row) => !rank.has(row.id));
  const ranked = rows
    .filter((row) => rank.has(row.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return [...unranked, ...ranked];
}

/**
 * The saved order after moving `id` within its list. `loadedIds` is every
 * loaded row (window and folder rows alike) in the lists' own order; the ones
 * the saved order lacks are written in first, in that order, so every list
 * still shows what it showed. `scopeIds` are the members of the moved row's
 * list, in any order: the list as shown is derived from the order, so a move
 * replayed on a fresh order lands where it would have on that order. The moved
 * id then sits next to its new neighbour in the list, which changes no other
 * list. Returns `order` itself when the move changes nothing.
 */
export function aeMoveInOrder({
  order,
  loadedIds,
  scopeIds,
  id,
  to,
}: {
  order: readonly string[];
  loadedIds: readonly string[];
  scopeIds: readonly string[];
  id: string;
  to: AeMoveTo;
}): readonly string[] {
  const known = new Set(order);
  const prepend = loadedIds.filter((rowId) => !known.has(rowId));
  const full = [...prepend, ...order];
  const members = new Set(scopeIds);
  const shown = full.filter((rowId) => members.has(rowId));
  const from = shown.indexOf(id);
  if (from < 0) return order;

  let dest: number;
  if (to === "top") dest = 0;
  else if (to === "bottom") dest = shown.length - 1;
  else if (to === "up") dest = from - 1;
  else if (to === "down") dest = from + 1;
  else {
    const target = shown.indexOf("before" in to ? to.before : to.after);
    if (target < 0) return order;
    if ("before" in to) dest = target > from ? target - 1 : target;
    else dest = target < from ? target + 1 : target;
  }
  if (dest === from || dest < 0 || dest >= shown.length) return order;

  const moved = shown.filter((rowId) => rowId !== id);
  moved.splice(dest, 0, id);
  const next = full.filter((rowId) => rowId !== id);
  if (dest > 0) next.splice(next.indexOf(moved[dest - 1]) + 1, 0, id);
  else next.splice(next.indexOf(moved[1]), 0, id);
  return aeTrimOrder(next, new Set(loadedIds), id);
}

/**
 * Cap an order at `AE_ORDER_MAX`, dropping ids no list has loaded from the end
 * first (archived, deleted, or past the loaded window), then the last ranks.
 * `keep` (the moved id) is never dropped.
 */
export function aeTrimOrder(
  order: readonly string[],
  loaded: ReadonlySet<string>,
  keep?: string,
): readonly string[] {
  if (order.length <= AE_ORDER_MAX) return order;
  let excess = order.length - AE_ORDER_MAX;
  const dropped = new Set<number>();
  // Two passes from the end: unloaded ids, then any id; never `keep`.
  for (const droppable of [(rowId: string) => !loaded.has(rowId), () => true]) {
    for (let index = order.length - 1; index >= 0 && excess > 0; index -= 1) {
      const rowId = order[index];
      if (rowId === keep || dropped.has(index) || !droppable(rowId)) continue;
      dropped.add(index);
      excess -= 1;
    }
  }
  return order.filter((_, index) => !dropped.has(index));
}
