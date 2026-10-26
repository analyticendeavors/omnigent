// A fresh read of a session family (omnigent-ae, 2026-10-25, moved here
// 2026-10-26): the archive and pin cascades (shell/AeFamilyArchive.tsx,
// shell/aePinFamily.ts) read the session list rather than trusting the
// sidebar's rows, which stop at the loaded pages and a search.

import type { QueryClient } from "@tanstack/react-query";
import { type Conversation, fetchConversationsPage } from "@/hooks/useConversations";
import { aeFamilies } from "@/lib/aeFamily";

const READ_LIMIT = 200;
const READ_PAGES = 5;

/** One slice of the session list, newest first, up to `READ_PAGES` pages. */
async function readSlice(queryClient: QueryClient, archived: boolean): Promise<Conversation[]> {
  const rows: Conversation[] = [];
  let after: string | undefined;
  for (let page = 0; page < READ_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop -- each page needs the previous cursor
    const got = await fetchConversationsPage({
      searchQuery: "",
      includeArchived: archived,
      visibility: archived ? "archived" : undefined,
      queryClient,
      limit: READ_LIMIT,
      after,
    });
    rows.push(...got.data);
    if (!got.has_more || got.last_id === null) break;
    after = got.last_id ?? undefined;
  }
  return rows;
}

/**
 * The open sessions, plus the archived ones so that a session started by an
 * archived helper still traces back to its lead. Archived rows only link the
 * family; callers leave them out of what they act on.
 */
export async function aeReadFamilySessions(queryClient: QueryClient): Promise<Conversation[]> {
  const [open, archived] = await Promise.all([
    readSlice(queryClient, false),
    readSlice(queryClient, true),
  ]);
  const byId = new Map<string, Conversation>();
  for (const c of [...archived, ...open]) byId.set(c.id, c);
  return [...byId.values()];
}

/**
 * The family *id* leads among *rows*, lead first; empty when *id* is no family's
 * top session (it was started by or forked from another one).
 */
export function aeFamilyOf(rows: readonly Conversation[], id: string): Conversation[] {
  return aeFamilies(rows, true).byRoot.get(id)?.members ?? [];
}
