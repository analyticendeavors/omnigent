// Archive a family's lead together with its sessions (omnigent-ae, 2026-10-25).
// In Grouping > Family, archiving a lead row archives every session under it.
// When one of them is still open (not in the family's closed group), a confirm
// asks first; Cancel archives nothing. The tree: lib/aeFamilyTree.ts. The chat
// header's Archive does the same since 2026-10-25 (`gate: "read"`): it has no
// sidebar tree, so it reads the family to learn whether the session leads one.
//
// The sessions to archive come from a fresh read of the session list, not the
// sidebar's rows: those stop at the loaded pages and a search, and the tree
// keeps its objects across updates that only change a worktree or a time.

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { showToast } from "@/components/ui/toast";
import {
  BulkConversationMutationError,
  type Conversation,
  fetchConversationsPage,
  useBulkArchiveConversations,
} from "@/hooks/useConversations";
import { aeFamilies } from "@/lib/aeFamily";
import { aeIsClosedMember } from "@/lib/aeFamilyClosed";
import type { AeFamilyTree } from "@/lib/aeFamilyTree";
import { AeFamilyContext } from "@/lib/aeFamilyView";
import { useNavigate, useParams } from "@/lib/routing";
import { showArchiveUndoToast } from "@/shell/archiveUndoToast";

export const AE_FAMILY_ARCHIVE_CONFIRM =
  "Are you sure you would like to archive this? There are still open sessions.";

const READ_LIMIT = 200;
const READ_PAGES = 5;

/** The sessions under a lead among *rows*, and how many are open (not in the closed group). */
export function aeFamilyArchiveTargets(
  rows: readonly Conversation[],
  id: string,
): { children: Conversation[]; open: number } {
  const members = aeFamilies(rows, true).byRoot.get(id)?.members ?? [];
  const children = members.filter((c) => c.id !== id && c.archived !== true);
  return { children, open: children.filter((c) => !aeIsClosedMember(c)).length };
}

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
 * family; `aeFamilyArchiveTargets` never archives them again.
 */
async function readSessions(queryClient: QueryClient): Promise<Conversation[]> {
  const [open, archived] = await Promise.all([
    readSlice(queryClient, false),
    readSlice(queryClient, true),
  ]);
  const byId = new Map<string, Conversation>();
  for (const c of [...archived, ...open]) byId.set(c.id, c);
  return [...byId.values()];
}

interface Seen {
  tree: AeFamilyTree | null | undefined;
  activeId: string | undefined;
}

/** Keeps the tree and the open session in reach, so the row itself does not re-render on them. */
function Source({ into }: { into: RefObject<Seen> }) {
  const { tree } = useContext(AeFamilyContext);
  const { conversationId } = useParams<{ conversationId: string }>();
  useLayoutEffect(() => {
    into.current = { tree, activeId: conversationId };
  }, [into, tree, conversationId]);
  return null;
}

type RequestArchive = (
  conversations: readonly Conversation[],
  proceed: (deleteWorktreeIds: ReadonlySet<string>) => void,
) => void;

/**
 * A lead's archive. `archiveFamily(alone)` archives the session with every one
 * under it. With `gate: "tree"` (a sidebar row) only a lead in Grouping >
 * Family's tree reads its family, and any other row calls `alone` at once; with
 * `gate: "read"` (the chat header) every archive reads it. Once a read is done
 * the archive runs here, never through `alone`: the caller's closure is from
 * the click, and by then another session may be open. The caller renders
 * `source` and `dialog`.
 */
export function useAeFamilyArchive(
  lead: Conversation,
  requestArchive: RequestArchive,
  { gate }: { gate: "tree" | "read" },
): { archiveFamily: (alone: () => void) => void; source: ReactNode; dialog: ReactNode } {
  const seen = useRef<Seen>({ tree: null, activeId: undefined });
  // A second Archive click while the read runs does nothing.
  const reading = useRef(false);
  const [pending, setPending] = useState<Conversation[] | null>(null);
  const bulkArchive = useBulkArchiveConversations();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const archiveAll = (all: Conversation[]) =>
    requestArchive(all, (deleteWorktreeIds) => {
      // The rows leave the list optimistically and this one unmounts; leave
      // and offer Undo now, as the bulk bar does.
      const { activeId } = seen.current;
      if (activeId && all.some((c) => c.id === activeId)) navigate("/", { replace: true });
      // mutateAsync's promise settles after this row unmounts; a mutate callback would not.
      bulkArchive
        .mutateAsync({ ids: all.map((c) => c.id), archived: true, deleteWorktreeIds })
        .catch((err: unknown) => {
          const failed =
            err instanceof BulkConversationMutationError ? err.failed.length : all.length;
          showToast(
            `Couldn't archive ${failed} of ${all.length} sessions; those are back in the list`,
          );
        });
      showArchiveUndoToast(queryClient, all, navigate);
    });

  const archiveFamily = (alone: () => void) => {
    if (gate === "tree") {
      const treeLead = seen.current.tree?.leads.get(lead.id);
      if (!treeLead || treeLead.standIn) {
        alone();
        return;
      }
    }
    if (reading.current) return;
    reading.current = true;
    readSessions(queryClient)
      .finally(() => {
        reading.current = false;
      })
      .then(
        (rows) => {
          const { children, open } = aeFamilyArchiveTargets(rows, lead.id);
          const all = [lead, ...children];
          if (open > 0) setPending(all);
          else archiveAll(all);
        },
        () => showToast("Couldn't read the family's sessions, so nothing was archived. Try again."),
      );
  };

  const dialog = (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      {pending !== null && (
        <DialogContent data-testid="ae-family-archive-confirm" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Archive family</DialogTitle>
            <DialogDescription>{AE_FAMILY_ARCHIVE_CONFIRM}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-t-0 bg-transparent">
            <Button type="button" variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                const all = pending;
                setPending(null);
                archiveAll(all);
              }}
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
  return { archiveFamily, source: <Source into={seen} />, dialog };
}
