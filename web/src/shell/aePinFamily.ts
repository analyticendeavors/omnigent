// Pin and unpin a family with its lead (omnigent-ae, 2026-10-26). With
// Settings > Chat > "Pin a lead's family" on (lib/aePinFamily.ts), pinning a
// session that leads a family also pins its open sessions (not reference or
// archived ones), lead first so the family lists together in Pinned; a family
// that needs more pin spots than are free pins nothing and says so. Unpinning
// the lead unpins every pinned session of the family, with one Undo. With the
// setting off, or for a session that leads no family, `alone` runs the single
// pin or unpin as before. The family comes from a fresh read (lib/aeFamilyRead.ts).

import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { showToast } from "@/components/ui/toast";
import {
  PINNED_CONVERSATIONS_KEY,
  type Conversation,
  type PinnedConversationsResult,
} from "@/hooks/useConversations";
import { aeFamilyParent } from "@/lib/aeFamily";
import { aeIsClosedMember } from "@/lib/aeFamilyClosed";
import { aeFamilyOf, aeReadFamilySessions } from "@/lib/aeFamilyRead";
import { readAePinFamily } from "@/lib/aePinFamily";
import { getCurrentUserId } from "@/lib/identity";
import { PINNED_LABEL_KEY } from "@/lib/sessionListCache";
import { sessionVisibility } from "@/lib/sessionVisibility";
import { readPinnedConversationIds } from "./sidebarNav";

/** The pin toggle's `mutateAsync` (`useTogglePinnedConversation`). */
type WritePin = (vars: { id: string; pinned: boolean; pinnedAt?: number }) => Promise<unknown>;

/** As long as the single unpin's Undo, and under its id, so a newer unpin replaces the pill. */
const UNDO_MS = 5000;
const UNDO_TOAST_ID = "unpin-undo";

const BACKFILL = "conversation-backfill";

/** A session's row in the pinned cache, a loaded list or project page, or the backfill cache. */
function cachedRow(queryClient: QueryClient, id: string): Conversation | undefined {
  const pins = queryClient.getQueryData<PinnedConversationsResult>(PINNED_CONVERSATIONS_KEY);
  const pinned = pins?.conversations.find((c) => c.id === id);
  if (pinned) return pinned;
  for (const queryKey of [["conversations"], ["project-sessions"]]) {
    for (const [, data] of queryClient.getQueriesData<{ pages?: { data?: Conversation[] }[] }>({
      queryKey,
    })) {
      const row = data?.pages?.flatMap((page) => page.data ?? []).find((c) => c.id === id);
      if (row) return row;
    }
  }
  return queryClient.getQueryData<Conversation | null>([BACKFILL, id]) ?? undefined;
}

/** Sessions pinned now, in the server pinned cache or legacy local pins, with their pin value. */
function pinnedNow(queryClient: QueryClient): Map<string, number | undefined> {
  const pins = queryClient.getQueryData<PinnedConversationsResult>(PINNED_CONVERSATIONS_KEY);
  const out = new Map<string, number | undefined>();
  for (const id of readPinnedConversationIds()) out.set(id, undefined);
  for (const c of pins?.conversations ?? []) {
    const value = Number(c.labels?.[PINNED_LABEL_KEY]);
    out.set(c.id, Number.isFinite(value) && value > 0 ? value : undefined);
  }
  return out;
}

/**
 * The pins that count against the cap, counted as the pin toggle counts them:
 * without shared pins, only the viewer's own sessions.
 */
function pinsCounted(queryClient: QueryClient, includeShared: boolean): number {
  const viewerId = getCurrentUserId();
  const mine = (row: Conversation | undefined) =>
    includeShared || (row !== undefined && sessionVisibility(row, viewerId) === "mine");
  const pins = queryClient.getQueryData<PinnedConversationsResult>(PINNED_CONVERSATIONS_KEY);
  const ids = new Set((pins?.conversations ?? []).filter((c) => mine(c)).map((c) => c.id));
  for (const id of readPinnedConversationIds()) {
    if (mine(cachedRow(queryClient, id))) ids.add(id);
  }
  return ids.size;
}

/** Writes one pin after another (the app refuses overlapping pin writes); stops at the first failure. */
async function writeEach(
  writePin: WritePin,
  writes: { id: string; pinned: boolean; pinnedAt?: number }[],
): Promise<string[]> {
  const done: string[] = [];
  for (const write of writes) {
    try {
      // eslint-disable-next-line no-await-in-loop -- pin writes must not overlap
      await writePin(write);
    } catch {
      // The toggle's own onError rolled that row back and said why.
      break;
    }
    done.push(write.id);
  }
  return done;
}

async function pinFamily(
  queryClient: QueryClient,
  writePin: WritePin,
  family: Conversation[],
  id: string,
  pinCap: number,
  includeShared: boolean,
): Promise<void> {
  const viewerId = getCurrentUserId();
  // Read again now: the lead or a member may have been pinned while the family was read.
  const pinned = pinnedNow(queryClient);
  const targets = family.filter(
    (c) =>
      !pinned.has(c.id) &&
      (c.id === id ||
        (c.archived !== true &&
          !aeIsClosedMember(c) &&
          // Without shared pins the toggle refuses another person's session.
          (includeShared || sessionVisibility(c, viewerId) === "mine"))),
  );
  if (targets.length === 0) return;
  const free = Math.max(pinCap - pinsCounted(queryClient, includeShared), 0);
  if (targets.length > free) {
    showToast(
      `Not enough pin spots for this family (${targets.length} needed, ${free} free). Nothing was pinned.`,
    );
    return;
  }
  // The toggle builds its optimistic Pinned row from the cache; a member past
  // the sidebar's loaded pages is there only once this read seeds it.
  for (const c of targets) {
    if (!cachedRow(queryClient, c.id)) queryClient.setQueryData([BACKFILL, c.id], c);
  }
  // Lead first: Pinned sorts by pin time, so the family lists together under it.
  const ordered = [...targets.filter((c) => c.id === id), ...targets.filter((c) => c.id !== id)];
  const done = await writeEach(
    writePin,
    ordered.map((c) => ({ id: c.id, pinned: true })),
  );
  if (done.length > 0 && done.length < ordered.length) {
    showToast(
      `Pinned ${done.length} of ${ordered.length} family sessions; the rest did not save. Pin them again to retry.`,
    );
  }
}

async function unpinFamily(
  queryClient: QueryClient,
  writePin: WritePin,
  family: Conversation[],
  lead: Pick<Conversation, "id" | "title">,
): Promise<void> {
  const pinned = pinnedNow(queryClient);
  const members = [lead.id, ...family.map((c) => c.id).filter((m) => m !== lead.id)].filter((m) =>
    pinned.has(m),
  );
  const done = await writeEach(
    writePin,
    members.map((m) => ({ id: m, pinned: false })),
  );
  if (done.length === 0) return;
  toast(`Unpinned ${done.length} session${done.length === 1 ? "" : "s"}`, {
    id: UNDO_TOAST_ID,
    description: lead.title || undefined,
    duration: UNDO_MS,
    action: {
      label: "Undo",
      onClick: () => {
        // Re-pin at the old values, so the family returns to its old Pinned
        // slots; skip any pinned again meanwhile.
        const now = pinnedNow(queryClient);
        void writeEach(
          writePin,
          done
            .filter((m) => !now.has(m))
            .map((m) => ({ id: m, pinned: true, pinnedAt: pinned.get(m) })),
        );
      },
    },
    testId: "unpin-undo-toast-item",
  });
}

// A second click on the same lead while its family is read does nothing.
const reading = new Set<string>();

/**
 * Pin or unpin *session*, with its family when the setting is on and it leads
 * one; otherwise `alone` does the single pin or unpin.
 */
export function aeTogglePinFamily({
  queryClient,
  writePin,
  session,
  pinned,
  pinCap,
  includeShared,
  alone,
}: {
  queryClient: QueryClient;
  writePin: WritePin;
  session: Pick<Conversation, "id"> & Partial<Pick<Conversation, "labels" | "title">>;
  /** Pinned now: the toggle unpins. */
  pinned: boolean;
  pinCap: number;
  /** Whether Pinned holds shared sessions, as the pin toggle reads it. */
  includeShared: boolean;
  alone: () => void;
}): void {
  if (!readAePinFamily()) {
    alone();
    return;
  }
  // A session started by or forked from another leads no family: no read.
  const labels = session.labels ?? cachedRow(queryClient, session.id)?.labels;
  if (labels && aeFamilyParent(labels) !== null) {
    alone();
    return;
  }
  if (reading.has(session.id)) return;
  reading.add(session.id);
  aeReadFamilySessions(queryClient)
    .finally(() => reading.delete(session.id))
    .then(
      (rows) => {
        const family = aeFamilyOf(rows, session.id);
        const lead = family.find((c) => c.id === session.id);
        const others = family.filter((c) => c.id !== session.id);
        // No family under it: the single toggle, as with the setting off.
        if (!lead || others.length === 0) {
          alone();
          return undefined;
        }
        if (pinned) {
          const now = pinnedNow(queryClient);
          if (!others.some((c) => now.has(c.id))) {
            alone();
            return undefined;
          }
          return unpinFamily(queryClient, writePin, family, lead);
        }
        const open = others.filter((c) => c.archived !== true && !aeIsClosedMember(c));
        if (open.length === 0) {
          alone();
          return undefined;
        }
        return pinFamily(queryClient, writePin, family, session.id, pinCap, includeShared);
      },
      () =>
        showToast(
          `Couldn't read the family's sessions, so nothing was ${pinned ? "unpinned" : "pinned"}. Try again.`,
        ),
    );
}

/** Resets the read guard between tests. */
export function resetAePinFamilyForTests(): void {
  reading.clear();
}
