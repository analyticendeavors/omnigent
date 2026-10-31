// Pin values for a pinned family's sessions (omnigent-ae, 2026-10-31). Pinned
// sorts by the `omnigent.pinned` label, and a family draws at its lead's slot
// with its pinned sessions under it. The sessions' own values must therefore
// sit just after the lead's, below the next top-level row, so that unpinning
// the lead alone, or an Undo, leaves them in the slots the tree showed.

import type { Conversation } from "@/hooks/useConversations";
import { PINNED_LABEL_KEY } from "@/lib/sessionListCache";

export interface AePinWrite {
  id: string;
  pinnedAt: number;
}

export const aePinValue = (c: Conversation | undefined): number =>
  Number(c?.labels?.[PINNED_LABEL_KEY]);

/** *count* values in order after *lead*, below *next* (or one apart when nothing follows). */
export function aeKidPinValues(lead: number, next: number | undefined, count: number): number[] {
  const step = next === undefined ? 1 : (next - lead) / (count + 1);
  return Array.from({ length: count }, (_, i) => lead + step * (i + 1));
}

/** The smallest value among *values* above *above*, if any. */
function nextAbove(values: Iterable<number>, above: number): number | undefined {
  let best: number | undefined;
  for (const v of values) if (v > above && (best === undefined || v < best)) best = v;
  return best;
}

/**
 * The value of the top-level row that follows a row placed at *at* once
 * *writes* are applied to *top*, ignoring *skip* (the row being placed).
 */
export function aeNextPinValue(
  top: readonly Conversation[],
  writes: readonly AePinWrite[],
  at: number,
  skip: string,
): number | undefined {
  const moved = new Map(writes.map((w) => [w.id, w.pinnedAt]));
  const values = top
    .filter((c) => c.id !== skip)
    .map((c) => moved.get(c.id) ?? aePinValue(c))
    .filter(Number.isFinite);
  return nextAbove(values, at);
}

/**
 * *writes* (a move over *top*, see `pinOrderWrites`) plus the writes that keep
 * every pinned family's sessions right after their lead: a lead whose sessions
 * no longer sit between its value and the next top-level row's gets them spread
 * there, in tree order.
 */
export function aePinWritesWithKids(
  top: readonly Conversation[],
  kids: ReadonlyMap<string, Conversation[]>,
  writes: readonly AePinWrite[],
): AePinWrite[] {
  const moved = new Map(writes.map((w) => [w.id, w.pinnedAt]));
  const valueOf = (c: Conversation) => moved.get(c.id) ?? aePinValue(c);
  const tops = top.map(valueOf).filter(Number.isFinite);
  const out = [...writes];
  for (const lead of top) {
    const members = kids.get(lead.id);
    const at = valueOf(lead);
    if (!members || !Number.isFinite(at)) continue;
    const next = nextAbove(tops, at);
    const have = members.map(aePinValue);
    const placed = have.every(
      (v, i) =>
        Number.isFinite(v) && v > (i === 0 ? at : have[i - 1]) && (next === undefined || v < next),
    );
    if (placed) continue;
    const values = aeKidPinValues(at, next, members.length);
    members.forEach((c, i) => out.push({ id: c.id, pinnedAt: values[i] }));
  }
  return out;
}
