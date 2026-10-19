// The Triage view's last group (omnigent-ae, 2026-10-19): archived sessions,
// collapsed until opened on this device. Opening it loads the newest archived
// page; "Show more" loads the next. The sidebar passes its own section
// component and row props in, so this file imports nothing from Sidebar.tsx.

import { type ComponentType, type MouseEvent, type ReactNode, useMemo, useState } from "react";
import type { Conversation } from "@/hooks/useConversations";
import { useArchivedSessions } from "@/hooks/useScopeCache";
import { AE_ICON_HISTORY, AE_ICON_LOADER } from "@/lib/aeSortIcons";
import { AeTablerSvg } from "@/lib/aeTablerIcon";

const STORAGE_KEY = "ae.sidebar.archivedOpen";

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "open";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    if (open) window.localStorage.setItem(STORAGE_KEY, "open");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A local view preference; losing it is harmless.
  }
}

/** The props the sidebar's `ConversationSection` takes that this group sets. */
export interface AeSectionProps {
  title?: string;
  titleContent?: ReactNode;
  conversations: Conversation[];
  activeConversationId: string | null;
  pinnedConversationIds: string[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onRowClick: (e: MouseEvent<HTMLAnchorElement>) => void;
  onTogglePinned: (conversationId: string) => void;
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelected: (conversationId: string, shiftKey?: boolean) => void;
  onProjectAssigned?: (projectName: string) => void;
  emptyMessage?: ReactNode;
  footer?: ReactNode;
}

type AeRowProps = Omit<
  AeSectionProps,
  | "title"
  | "titleContent"
  | "conversations"
  | "collapsed"
  | "onToggleCollapsed"
  | "emptyMessage"
  | "footer"
>;

export function AeArchivedGroup({
  show,
  Section,
  rowProps,
}: {
  /** Triage is on, outside search, selection, and the Shared and Archived displays. */
  show: boolean;
  Section: ComponentType<AeSectionProps>;
  rowProps: AeRowProps;
}) {
  const [open, setOpen] = useState(readOpen);
  const query = useArchivedSessions(show && open);
  const rows = useMemo(() => query.data?.pages.flatMap((page) => page.data) ?? [], [query.data]);
  if (!show) return null;
  const toggle = () => {
    writeOpen(!open);
    setOpen(!open);
  };
  let footer: ReactNode = null;
  if (query.isError) {
    footer = (
      <p role="status" className="px-2 py-1 text-destructive text-ui">
        Could not load archived sessions.{" "}
        <button type="button" onClick={() => void query.refetch()}>
          Retry
        </button>
      </p>
    );
  } else if (query.isLoading) {
    footer = <p className="px-2 py-1 text-muted-foreground text-sm">Loading…</p>;
  } else if (query.hasNextPage) {
    footer = (
      <button
        type="button"
        data-testid="ae-archived-show-more"
        disabled={query.isFetchingNextPage}
        onClick={() => void query.fetchNextPage()}
        className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-muted-foreground text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
      >
        {query.isFetchingNextPage ? (
          <>
            <AeTablerSvg node={AE_ICON_LOADER} className="size-3 animate-spin" />
            Loading…
          </>
        ) : (
          "Show more"
        )}
      </button>
    );
  }
  return (
    <Section
      title="Archived"
      titleContent={
        <span className="inline-flex items-center gap-1.5 align-middle">
          <AeTablerSvg node={AE_ICON_HISTORY} className="size-3.5 shrink-0" />
          Archived
        </span>
      }
      conversations={rows}
      collapsed={!open}
      onToggleCollapsed={toggle}
      emptyMessage={query.isLoading || query.isError ? undefined : "No archived sessions"}
      footer={footer}
      {...rowProps}
    />
  );
}
