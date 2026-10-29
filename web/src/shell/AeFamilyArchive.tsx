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
//
// A stand-in row (a family whose lead is archived or not loaded) archives the
// family's remaining sessions the same way since 2026-10-29: `useAeStandInArchive`.

import { useQueryClient } from "@tanstack/react-query";
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
  useBulkArchiveConversations,
} from "@/hooks/useConversations";
import { aeFamilyOf, aeReadFamilySessions } from "@/lib/aeFamilyRead";
import { aeIsClosedMember } from "@/lib/aeFamilyClosed";
import type { AeFamilyTree } from "@/lib/aeFamilyTree";
import { AeFamilyContext } from "@/lib/aeFamilyView";
import { useNavigate, useParams } from "@/lib/routing";
import { useArchiveWorktreePrompt } from "@/shell/ArchiveWorktreeDialog";
import { showArchiveUndoToast } from "@/shell/archiveUndoToast";

export const AE_FAMILY_ARCHIVE_CONFIRM =
  "Are you sure you would like to archive this? There are still open sessions.";

/** The sessions under a lead among *rows*, and how many are open (not in the closed group). */
export function aeFamilyArchiveTargets(
  rows: readonly Conversation[],
  id: string,
): { children: Conversation[]; open: number } {
  const children = aeFamilyOf(rows, id).filter((c) => c.id !== id && c.archived !== true);
  return { children, open: children.filter((c) => !aeIsClosedMember(c)).length };
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
 * The bulk archive and its open-session confirm, shared by a lead's archive and
 * a stand-in's. *activeId* is read when the archive runs, so it is the open
 * session then, not the one at the click.
 */
function useArchiveAll(requestArchive: RequestArchive, activeId: () => string | undefined) {
  const [pending, setPending] = useState<Conversation[] | null>(null);
  const bulkArchive = useBulkArchiveConversations();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const archiveAll = (all: Conversation[]) =>
    requestArchive(all, (deleteWorktreeIds) => {
      // The rows leave the list optimistically and this one unmounts; leave
      // and offer Undo now, as the bulk bar does.
      const active = activeId();
      if (active && all.some((c) => c.id === active)) navigate("/", { replace: true });
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
  return { archiveAll, ask: setPending, dialog };
}

/**
 * A stand-in's archive: every session of the family under *root* that is not
 * archived yet. The lead is among them only when it exists; an unknown lead id
 * is never sent. *shown* are the sessions the sidebar draws under the stand-in:
 * its tree is built from the loaded pages, so *root* can be a session that is
 * merely missing from them, and the fresh read then re-roots the family at that
 * session's own lead. Those sessions and *root* are archived too, never the
 * re-rooted lead's wider family. The caller renders `dialog` (the confirm and
 * the worktree prompt).
 */
export function useAeStandInArchive(
  root: string,
  shown: readonly Conversation[],
): {
  archiveFamily: () => void;
  dialog: ReactNode;
} {
  const worktreePrompt = useArchiveWorktreePrompt();
  const { conversationId } = useParams<{ conversationId: string }>();
  const activeId = useRef(conversationId);
  activeId.current = conversationId;
  const reading = useRef(false);
  const { archiveAll, ask, dialog } = useArchiveAll(
    worktreePrompt.requestArchive,
    () => activeId.current,
  );
  const queryClient = useQueryClient();

  const archiveFamily = () => {
    if (reading.current) return;
    reading.current = true;
    aeReadFamilySessions(queryClient)
      .finally(() => {
        reading.current = false;
      })
      .then(
        (rows) => {
          const ids = new Set([root, ...shown.map((c) => c.id)]);
          const found = [...aeFamilyOf(rows, root), ...rows.filter((c) => ids.has(c.id))];
          const all = [...new Map(found.map((c) => [c.id, c])).values()].filter(
            (c) => c.archived !== true,
          );
          if (all.length === 0) showToast("Nothing left to archive in this family.");
          else if (all.some((c) => !aeIsClosedMember(c))) ask(all);
          else archiveAll(all);
        },
        () => showToast("Couldn't read the family's sessions, so nothing was archived. Try again."),
      );
  };
  return {
    archiveFamily,
    dialog: (
      <>
        {worktreePrompt.dialog}
        {dialog}
      </>
    ),
  };
}

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
  const { archiveAll, ask, dialog } = useArchiveAll(requestArchive, () => seen.current.activeId);
  const queryClient = useQueryClient();

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
    aeReadFamilySessions(queryClient)
      .finally(() => {
        reading.current = false;
      })
      .then(
        (rows) => {
          const { children, open } = aeFamilyArchiveTargets(rows, lead.id);
          const all = [lead, ...children];
          if (open > 0) ask(all);
          else archiveAll(all);
        },
        () => showToast("Couldn't read the family's sessions, so nothing was archived. Try again."),
      );
  };

  return { archiveFamily, source: <Source into={seen} />, dialog };
}
