// The sidebar's manual session order (omnigent-ae, 2026-10-19): one saved list
// of session ids per user (`GET` and `PUT /v1/ae/sidebar`) ranks every list the
// sidebar shows, Sessions, Shared, each project folder and each group alike.
// A session the saved order does not hold sorts above the ranked ones when it
// is newer than all of them (a new session lands on top of its list), else
// below them (an older row that loaded late stays under the arranged ones).

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

/** What ranking needs from a row. */
export interface AeOrderRow {
  id: string;
  created_at?: number | null;
}

/**
 * Rows in manual order. With no row ranked, `rows` itself. Otherwise the
 * unranked rows created after the newest ranked one first, then the ranked
 * rows by rank, then the other unranked rows; unranked rows keep their
 * incoming order.
 */
export function aeApplyManualOrder<T extends AeOrderRow>(rows: T[], order: readonly string[]): T[] {
  if (order.length === 0) return rows;
  const rank = rankOf(order);
  const ranked = rows
    .filter((row) => rank.has(row.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  if (ranked.length === 0) return rows;
  const newest = Math.max(...ranked.map((row) => row.created_at ?? 0));
  const isNew = (row: T) => !rank.has(row.id) && (row.created_at ?? 0) > newest;
  const isOld = (row: T) => !rank.has(row.id) && (row.created_at ?? 0) <= newest;
  return [...rows.filter(isNew), ...ranked, ...rows.filter(isOld)];
}

/**
 * `order` with every row of `units` ranked where it shows now, so applying the
 * result shows each unit as before. A unit is one set of rows the sidebar
 * ranks in one call (the session list, each project folder), in its incoming
 * order.
 */
function materialize(order: readonly string[], units: readonly (readonly AeOrderRow[])[]) {
  const full = [...order];
  const placed = new Set(order);
  for (const unit of units) {
    // A copy: the rank cache is keyed by array, and `full` grows in place.
    const shown = aeApplyManualOrder([...unit], [...full]).map((row) => row.id);
    const firstRanked = shown.findIndex((rowId) => placed.has(rowId));
    if (firstRanked < 0) {
      full.unshift(...shown.filter((rowId) => !placed.has(rowId)));
      for (const rowId of shown) placed.add(rowId);
      continue;
    }
    // New rows above the first ranked one; each other row right after its predecessor.
    const above = shown.slice(0, firstRanked).filter((rowId) => !placed.has(rowId));
    full.splice(full.indexOf(shown[firstRanked]), 0, ...above);
    for (const rowId of above) placed.add(rowId);
    for (let index = firstRanked + 1; index < shown.length; index += 1) {
      const rowId = shown[index];
      if (placed.has(rowId)) continue;
      full.splice(full.indexOf(shown[index - 1]) + 1, 0, rowId);
      placed.add(rowId);
    }
  }
  return full;
}

/**
 * The saved order after moving `id` within its list. `units` holds every
 * loaded row (see `materialize`); each is ranked where it shows first, so no
 * other row moves. `scopeIds` are the members of the moved row's list, in any
 * order: the list as shown is derived from the order, so a move replayed on a
 * fresh order lands where it would have on that order. The moved id then sits
 * next to its new neighbour in the list, which changes no other list. Returns
 * `order` itself when the move changes nothing, unless `keep`: a row landing in
 * another list is always ranked, or it would show there by recency.
 */
export function aeMoveInOrder({
  order,
  units,
  scopeIds,
  id,
  to,
  keep = false,
}: {
  order: readonly string[];
  units: readonly (readonly AeOrderRow[])[];
  scopeIds: readonly string[];
  id: string;
  to: AeMoveTo;
  keep?: boolean;
}): readonly string[] {
  const full = materialize(order, units);
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
  if ((dest === from && !keep) || dest < 0 || dest >= shown.length) return order;

  const moved = shown.filter((rowId) => rowId !== id);
  moved.splice(dest, 0, id);
  const next = full.filter((rowId) => rowId !== id);
  if (dest > 0) next.splice(next.indexOf(moved[dest - 1]) + 1, 0, id);
  else next.splice(next.indexOf(moved[1]), 0, id);
  const loaded = new Set(units.flatMap((unit) => unit.map((row) => row.id)));
  return aeTrimOrder(next, loaded, id);
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
