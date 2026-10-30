// The Agents card's "Child chats" part (omnigent-ae, 2026-10-29): the family child
// sessions this chat started. A child waiting on the user is pinned first with its
// question and an Answer button; the rest are rows with a role badge, a status line and a
// time; closed ones fold under one toggle. The model: lib/aeRailChildChats.ts.

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { RunningDot } from "@/components/RunningDot";
import {
  type Conversation,
  fetchConversationsPage,
  useConversations,
} from "@/hooks/useConversations";
import { aeAgentRole } from "@/lib/aeAgentRole";
import { AE_CLOSED_CAPPED_NOTE, aeGroupArchived } from "@/lib/aeFamilyClosed";
import { aeFamilyPrompts } from "@/lib/aeFamilyPrompts";
import { AE_FAMILY_BADGES } from "@/lib/aeFamilyBadge";
import { aeRevealDock } from "@/lib/aeDockReveal";
import {
  type AeChildChat,
  type AeChildChatsModel,
  aeChildChatsOf,
  buildAeChildChats,
} from "@/lib/aeRailChildChats";
import { type AeSessionPeek, fetchAeSessionPeek } from "@/lib/aeSessionPeek";
import { aeDuration } from "@/lib/aeSessionActivity";
import { Link, useLocation } from "@/lib/routing";
import { sessionNavigationSearch } from "@/lib/sessionNavigation";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";
import { AE_RAIL_TONE_TEXT, AeRailIcon, AeRailMuted } from "./aeRailUi";

/** The peek's own cadence; the card never reads faster while it is showing. */
const PEEK_POLL_MS = 15_000;
const MAX_CLOSED = 8;
const CLOSED_OPEN_KEY = "ae.rail.agents.childClosedOpen";

function readClosedOpen(): boolean {
  try {
    return window.localStorage.getItem(CLOSED_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeClosedOpen(open: boolean): void {
  try {
    window.localStorage.setItem(CLOSED_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Blocked storage: the choice lasts until the page reloads.
  }
}

const EMPTY_MODEL: AeChildChatsModel = {
  open: [],
  closed: [],
  needs: [],
  working: 0,
  archivedNote: null,
};

const ARCHIVED_STALE_MS = 60_000;
const ARCHIVED_LIMIT = 200;
const ARCHIVED_PAGES = 3;

const ARCHIVED_KEY = ["ae-rail-child-chats-archived"] as const;

interface ArchivedRead {
  rows: Conversation[];
  /** The read stopped at its page cap with more left. */
  capped: boolean;
}

/**
 * The archived sessions, one read shared by every chat (the list endpoint cannot filter by
 * label, so the card groups them by lead itself). The open list never holds archived rows.
 * A failed refetch keeps the last good read.
 */
function useArchivedRead(active: boolean) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ARCHIVED_KEY,
    enabled: active,
    staleTime: ARCHIVED_STALE_MS,
    refetchOnWindowFocus: true,
    retry: false,
    queryFn: async ({ signal }): Promise<ArchivedRead> => {
      const rows: Conversation[] = [];
      let after: string | undefined;
      let more = false;
      for (let page = 0; page < ARCHIVED_PAGES; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- each page needs the previous cursor
        const got = await fetchConversationsPage({
          searchQuery: "",
          includeArchived: true,
          visibility: "archived",
          queryClient,
          signal,
          limit: ARCHIVED_LIMIT,
          after,
        });
        rows.push(...(got.data ?? []));
        more = got.has_more && got.last_id !== null;
        if (!more) break;
        after = got.last_id ?? undefined;
      }
      return { rows, capped: more };
    },
  });
}

/**
 * The chat's child chats, read from the conversation list the sidebar keeps loaded
 * (live through its stream and reconcile) plus a read of the archived ones.
 */
export function useAeRailChildChats(sessionId: string, active: boolean): AeChildChatsModel {
  // Folded, it only reads the cached lists, so the folded summary keeps its counts.
  const { data } = useConversations("", false, { enabled: active });
  const queryClient = useQueryClient();
  const archived = useArchivedRead(active);
  const archivedData = archived.data;
  const archivedFailed = archived.isError && !archivedData;
  const model = useMemo(() => {
    if (!data) return EMPTY_MODEL;
    const rows = new Map<string, Conversation>();
    for (const page of data.pages) for (const row of page.data ?? []) rows.set(row.id, row);
    // A live row is newer than any archived read: an unarchived child leaves the fold at once.
    const mine = aeGroupArchived(archivedData?.rows ?? [], new Set([sessionId]));
    for (const row of mine.get(sessionId) ?? []) {
      if (!rows.has(row.id)) rows.set(row.id, { ...row, archived: true });
    }
    const built = buildAeChildChats([...rows.values()], sessionId);
    const archivedNote: AeChildChatsModel["archivedNote"] = archivedFailed
      ? "failed"
      : archivedData?.capped
        ? "capped"
        : null;
    return archivedNote ? { ...built, archivedNote } : built;
  }, [data, archivedData, archivedFailed, sessionId]);
  // A child that leaves the open list was archived (or deleted): read the archived list
  // again so it lands in the fold instead of vanishing.
  const liveIds = useMemo(
    () => aeChildChatsOf(data?.pages.flatMap((page) => page.data ?? []) ?? [], sessionId),
    [data, sessionId],
  );
  const seen = useRef<{ session: string; ids: ReadonlySet<string> }>({
    session: sessionId,
    ids: new Set(),
  });
  useEffect(() => {
    const now = new Set(liveIds.map((row) => row.id));
    // Another chat's ids are not departures: a switch starts a fresh baseline.
    const left =
      seen.current.session === sessionId && [...seen.current.ids].some((id) => !now.has(id));
    seen.current = { session: sessionId, ids: now };
    if (left && active) void queryClient.invalidateQueries({ queryKey: ARCHIVED_KEY });
  }, [liveIds, sessionId, active, queryClient]);
  return model;
}

function usePeeks(open: readonly AeChildChat[], active: boolean) {
  const results = useQueries({
    queries: open.map(({ row, status }) => ({
      queryKey: ["ae-rail-child-peek", row.id, status, row.updated_at],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchAeSessionPeek(row.id, signal),
      enabled: active,
      staleTime: PEEK_POLL_MS,
      // A finished child's newest items no longer change.
      refetchInterval:
        active && (status === "working" || status === "needs") ? PEEK_POLL_MS : false,
      retry: false,
      placeholderData: (previous: AeSessionPeek | undefined) => previous,
    })),
  });
  const out = new Map<string, AeSessionPeek>();
  results.forEach((result, index) => {
    if (result.data) out.set(open[index].row.id, result.data);
  });
  return out;
}

function RoleBadge({ labels }: { labels: Record<string, string> }) {
  const role = aeAgentRole({ labels });
  const badge = role ? AE_FAMILY_BADGES[role] : undefined;
  if (!badge) return <span aria-hidden className="size-4 shrink-0" />;
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-bold",
        badge.className,
      )}
    >
      {badge.letter}
    </span>
  );
}

function useChildLink(childId: string) {
  const { search } = useLocation();
  return { pathname: `/c/${childId}`, search: sessionNavigationSearch(search) };
}

/** How long a working child has been on its turn, else how long ago it last changed. */
function childTime(child: AeChildChat, peek: AeSessionPeek | undefined, nowMs: number): string {
  if (child.status === "working" && peek?.turnStartedAt) {
    return aeDuration(nowMs - peek.turnStartedAt, true);
  }
  return `${aeDuration(nowMs - child.row.updated_at * 1000, true)} ago`;
}

function StatusLine({ child, peek }: { child: AeChildChat; peek: AeSessionPeek | undefined }) {
  if (child.status === "working") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <RunningDot className="size-2.5" />
        <span className="shrink-0 font-medium">Working</span>
        {peek?.step && <span className="truncate">{peek.step}</span>}
      </span>
    );
  }
  if (child.status === "error") {
    return (
      <span className="block truncate text-xs text-destructive">
        <span className="font-medium">Error</span>
        {peek?.lastError ? ` ${peek.lastError}` : ""}
      </span>
    );
  }
  return (
    <span className="block truncate text-xs text-muted-foreground">
      <span aria-hidden className="mr-1.5 inline-block size-1.5 rounded-full bg-emerald-500" />
      <span className="font-medium">Done</span>
      {peek?.lastReply ? ` ${peek.lastReply}` : ""}
    </span>
  );
}

function ChildRow({
  child,
  peek,
  nowMs,
}: {
  child: AeChildChat;
  peek: AeSessionPeek | undefined;
  nowMs: number;
}) {
  const to = useChildLink(child.row.id);
  const title = child.row.title ?? child.row.id;
  return (
    <Link
      to={to}
      componentId="rail.child_chats.open"
      title={`Open ${title}`}
      className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted"
      data-testid="ae-rail-child-chat"
      data-session={child.row.id}
      data-status={child.status}
    >
      <RoleBadge labels={child.row.labels} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {childTime(child, peek, nowMs)}
          </span>
        </span>
        <StatusLine child={child} peek={peek} />
      </span>
    </Link>
  );
}

const BUTTON =
  "rounded-md px-2.5 py-0.5 text-xs font-semibold focus-visible:outline focus-visible:outline-2";

function NeedsYou({
  child,
  peek,
  sessionId,
  nowMs,
}: {
  child: AeChildChat;
  peek: AeSessionPeek | undefined;
  sessionId: string;
  nowMs: number;
}) {
  const to = useChildLink(child.row.id);
  const title = child.row.title ?? child.row.id;
  // The parent mirrors the child's prompt into its action dock; without it, open the child.
  const inDock = useChatStore(
    (s) =>
      s.conversationId === sessionId &&
      aeFamilyPrompts(s.blocks).some((block) => block.targetSessionId === child.row.id),
  );
  return (
    <div
      className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2"
      data-testid="ae-rail-child-needs"
      data-session={child.row.id}
    >
      <div className="flex items-baseline gap-2">
        <span aria-hidden className="mt-1 size-2 shrink-0 self-center rounded-full bg-warning" />
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {childTime(child, peek, nowMs)}
        </span>
      </div>
      <p className={cn("mt-0.5 text-xs", peek?.question ? undefined : AE_RAIL_TONE_TEXT.warning)}>
        {peek?.question ?? "Waiting on you"}
      </p>
      <div className="mt-1.5 flex gap-1.5">
        {inDock ? (
          <button
            type="button"
            onClick={() => aeRevealDock("childPrompt", child.row.id)}
            aria-label={`Answer ${title}`}
            className={cn(BUTTON, "bg-amber-600 text-white hover:bg-amber-700")}
            data-testid="ae-rail-child-answer"
          >
            Answer
          </button>
        ) : (
          <Link
            to={to}
            componentId="rail.child_chats.answer"
            aria-label={`Answer ${title}`}
            className={cn(BUTTON, "bg-amber-600 text-white hover:bg-amber-700")}
            data-testid="ae-rail-child-answer"
          >
            Answer
          </Link>
        )}
        <Link
          to={to}
          componentId="rail.child_chats.open_needs"
          aria-label={`Open chat ${title}`}
          className={cn(BUTTON, "border border-border text-muted-foreground hover:bg-muted")}
          data-testid="ae-rail-child-open"
        >
          Open chat
        </Link>
      </div>
    </div>
  );
}

function ClosedRow({ title, id }: { title: string; id: string }) {
  const to = useChildLink(id);
  return (
    <Link
      to={to}
      componentId="rail.child_chats.open_closed"
      className="-mx-1.5 block w-[calc(100%+0.75rem)] truncate rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted"
      data-testid="ae-rail-child-closed-row"
    >
      {title}
    </Link>
  );
}

export function AeRailChildChats({
  sessionId,
  model,
  active,
  nowMs,
}: {
  sessionId: string;
  model: AeChildChatsModel;
  active: boolean;
  nowMs: number;
}) {
  const [closedOpen, setClosedOpen] = useState(readClosedOpen);
  const peeks = usePeeks(model.open, active);
  const toggleClosed = () => {
    writeClosedOpen(!closedOpen);
    setClosedOpen(!closedOpen);
  };
  // A failed archived read shows even with no other child: the chat's only children may be
  // archived. A capped read says nothing alone, since the cap is not about this chat.
  if (model.open.length === 0 && model.closed.length === 0 && model.archivedNote !== "failed") {
    return null;
  }
  // A child waiting on the user is pinned above; the list holds the rest.
  const listed = model.open.filter((c) => c.status !== "needs");
  return (
    <div className="flex flex-col gap-1.5" data-testid="ae-rail-child-chats">
      {model.needs.map((child) => (
        <NeedsYou
          key={child.row.id}
          child={child}
          peek={peeks.get(child.row.id)}
          sessionId={sessionId}
          nowMs={nowMs}
        />
      ))}
      {model.open.length > 0 && (
        <div className="flex items-center justify-between pt-1 text-xs uppercase tracking-wide text-muted-foreground">
          <span>Child chats</span>
          <span className="tabular-nums">{model.open.length}</span>
        </div>
      )}
      {listed.map((child) => (
        <ChildRow key={child.row.id} child={child} peek={peeks.get(child.row.id)} nowMs={nowMs} />
      ))}
      {model.closed.length > 0 && (
        <div className="flex flex-col border-t border-border/60 pt-1">
          <button
            type="button"
            onClick={toggleClosed}
            aria-expanded={closedOpen}
            data-testid="ae-rail-child-closed-toggle"
            className="-mx-1.5 flex min-h-7 w-[calc(100%+0.75rem)] items-center gap-1 rounded-md px-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
          >
            <AeRailIcon name={closedOpen ? "chevronDown" : "chevronRight"} className="size-3.5" />
            <span>{model.closed.length} closed</span>
          </button>
          {closedOpen &&
            model.closed
              .slice(0, MAX_CLOSED)
              .map((row) => <ClosedRow key={row.id} id={row.id} title={row.title ?? row.id} />)}
          {closedOpen && model.closed.length > MAX_CLOSED && (
            <AeRailMuted>{model.closed.length - MAX_CLOSED} more in the sidebar.</AeRailMuted>
          )}
        </div>
      )}
      {model.archivedNote && (
        <AeRailMuted data-testid="ae-rail-child-archived-note">
          {model.archivedNote === "failed"
            ? "Could not load archived chats."
            : `Archived chats: ${AE_CLOSED_CAPPED_NOTE.trim().replace(/^\(|\)$/g, "")}.`}
        </AeRailMuted>
      )}
    </div>
  );
}
