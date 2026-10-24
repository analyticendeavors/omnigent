// A family's closed sessions (omnigent-ae, 2026-10-24): reference sessions and
// the lead's archived children fold into one "N closed" row under the family,
// so the list stops growing as helpers finish. A session marked review stays
// visible, because it waits for a read. This file holds the grouping, the
// archived read, and the per-device memory of which closed groups are open;
// the tree that places the rows: `aeFamilyTree.ts`; the rows: `shell/AeFamilyTree.tsx`.

import { useMemo, useSyncExternalStore } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Conversation, fetchConversationsPage } from "@/hooks/useConversations";
import { type AeFamilies, aeOrchParent } from "@/lib/aeFamily";
import { aeStatusOf } from "@/lib/aeLabels";

/** Closed sessions listed before "Show N more". */
export const AE_CLOSED_SHOWN = 5;
const ARCHIVED_LIMIT = 200;
const ARCHIVED_PAGES = 5;
/** Added to a lead's pill title when the archived read stopped at its page cap. */
export const AE_CLOSED_CAPPED_NOTE = " (older archived not counted)";
const ARCHIVED_STALE_MS = 60_000;

/** What the tree reads about closed sessions. */
export interface AeClosedInput {
  /** Archived sessions started by a shown lead, by the lead's id. */
  archived: ReadonlyMap<string, readonly Conversation[]>;
  /** Families whose closed group is open (remembered on this device). */
  open: ReadonlySet<string>;
  /** Families that revealed every closed row past the first few. */
  all: ReadonlySet<string>;
  /** The archived read hit its page cap with more left, so older ones are not counted. */
  capped?: boolean;
}

export const NO_CLOSED: AeClosedInput = {
  archived: new Map(),
  open: new Set(),
  all: new Set(),
};

/** A listed member is closed when it is marked reference or archived. */
export function aeIsClosedMember(c: Pick<Conversation, "labels" | "archived">): boolean {
  return c.archived === true || aeStatusOf(c.labels) === "reference";
}

/** Archived rows kept by the lead that started them, for the leads given. */
export function aeGroupArchived(
  rows: readonly Conversation[],
  roots: ReadonlySet<string>,
): Map<string, Conversation[]> {
  const out = new Map<string, Conversation[]>();
  for (const c of rows) {
    if (c.archived !== true) continue;
    const parent = aeOrchParent(c.labels);
    if (!parent || parent === c.id || !roots.has(parent)) continue;
    const list = out.get(parent);
    if (list) list.push(c);
    else out.set(parent, [c]);
  }
  return out;
}

/** A short stable hash of the listed members' ids, so a member leaving the list changes it. */
export function aeMembersKey(families: AeFamilies): string {
  let hash = 2166136261;
  let count = 0;
  const ids = [...families.byRow.keys()].sort();
  for (const id of ids) {
    for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
    hash = Math.imul(hash ^ 44, 16777619);
    count += 1;
  }
  return `${count}:${(hash >>> 0).toString(36)}`;
}

/** Newest first by `updated_at`. */
export function aeNewestFirst(rows: readonly Conversation[]): Conversation[] {
  return [...rows].sort((a, b) => b.updated_at - a.updated_at);
}

/** What the lead's pill and tooltip say about a family with closed sessions. */
export interface AeClosedSummary {
  /** Every session under the lead, listed or archived. */
  total: number;
  /** Members that are not closed. */
  open: number;
  closed: number;
  archived: number;
  /** Open members not marked review. */
  working: number;
  /** Open members marked review. */
  review: number;
}

export function aeClosedPill(s: AeClosedSummary): string {
  return `${s.total} · ${s.open} open`;
}

export function aeClosedTitle(s: AeClosedSummary): string {
  const parts: string[] = [];
  if (s.working > 0) parts.push(`${s.working} working`);
  if (s.review > 0) parts.push(`${s.review} done waiting for your read`);
  if (s.closed > 0) {
    parts.push(`${s.closed} closed${s.archived > 0 ? ` (${s.archived} archived)` : ""}`);
  }
  return `${s.total} session${s.total === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

// ── which closed groups are open, per device ────────────────────────────

const OPEN_KEY = "omnigent:ae-family-closed-open";
const OPEN_KEPT = 64;

function createSetStore(read: () => ReadonlySet<string>, write: (next: Set<string>) => void) {
  let value: ReadonlySet<string> | null = null;
  const listeners = new Set<() => void>();
  const snapshot = () => {
    if (value === null) value = read();
    return value;
  };
  return {
    snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(root: string, on: boolean) {
      const next = new Set(snapshot());
      if (on) next.add(root);
      else next.delete(root);
      value = new Set([...next].slice(-OPEN_KEPT));
      write(new Set(value));
      for (const listener of listeners) listener();
    },
    reset() {
      value = null;
    },
  };
}

const openStore = createSetStore(
  () => {
    if (typeof window === "undefined") return new Set();
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(OPEN_KEY) ?? "[]");
      return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  },
  (next) => {
    try {
      window.localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
    } catch {
      // A view nicety: a choice that does not survive a reload is harmless.
    }
  },
);
// "Show N more" is not remembered: a fresh load starts with the short list.
const allStore = createSetStore(
  () => new Set(),
  () => {},
);

/** Open or fold a family's closed group, and remember it on this device. */
export function toggleAeFamilyClosed(root: string, open: boolean): void {
  openStore.set(root, open);
}

/** Reveal the closed rows past the first few. */
export function revealAeFamilyClosed(root: string): void {
  allStore.set(root, true);
}

/** Forget cached state, so the next read comes from storage (tests). */
export function resetAeFamilyClosedCache(): void {
  openStore.reset();
  allStore.reset();
}

/**
 * The closed-session input for the tree: archived children of the shown leads
 * (read once, kept a minute, refreshed on focus, never polled) and the open
 * state per family. `enabled` is true only while Grouping is Family.
 */
export function useAeFamilyClosed(
  families: AeFamilies,
  enabled: boolean,
  searchQuery = "",
): AeClosedInput {
  const queryClient = useQueryClient();
  const open = useSyncExternalStore(openStore.subscribe, openStore.snapshot, openStore.snapshot);
  const all = useSyncExternalStore(allStore.subscribe, allStore.snapshot, allStore.snapshot);
  const rootsKey = useMemo(() => [...families.byRoot.keys()].sort().join(","), [families]);
  const membersKey = useMemo(() => aeMembersKey(families), [families]);
  // Its own key, never the conversations prefix: other lists share that cache shape.
  // The listed members are in the key, so archiving one refetches at once.
  const query = useQuery({
    queryKey: ["ae-family-closed-archived", searchQuery, membersKey],
    enabled: enabled && rootsKey !== "",
    staleTime: ARCHIVED_STALE_MS,
    refetchOnWindowFocus: true,
    refetchInterval: false,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const data: Conversation[] = [];
      let after: string | undefined;
      let more = false;
      for (let page = 0; page < ARCHIVED_PAGES; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- each page needs the previous cursor
        const got = await fetchConversationsPage({
          searchQuery,
          includeArchived: true,
          visibility: "archived",
          queryClient,
          signal,
          limit: ARCHIVED_LIMIT,
          after,
        });
        data.push(...got.data);
        more = got.has_more && got.last_id !== null;
        if (!more) break;
        after = got.last_id ?? undefined;
      }
      return { data, capped: more };
    },
  });
  const page = query.data;
  const capped = enabled && page?.capped === true;
  const archived = useMemo(
    () =>
      enabled && page
        ? aeGroupArchived(page.data, new Set(rootsKey.split(",")))
        : NO_CLOSED.archived,
    [enabled, page, rootsKey],
  );
  return useMemo(() => ({ archived, open, all, capped }), [archived, open, all, capped]);
}
