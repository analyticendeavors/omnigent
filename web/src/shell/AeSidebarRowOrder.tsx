// The row-level parts of the sidebar's Manual ordering and Triage grouping
// (omnigent-ae, 2026-10-19): each row as a drop target for reordering its own
// list, the row menu's Move items, and the Triage group headers.

import { useDroppable } from "@dnd-kit/core";
import { type ComponentType, type ReactNode, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { AE_STATUS_ICONS } from "@/components/AeStatusIcon";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import { getEmbedRoot } from "@/lib/host";
import type { AeMoveTo } from "@/lib/aeSessionOrder";
import {
  AE_ICON_ARROWS_SORT,
  AE_ICON_MOVE_BOTTOM,
  AE_ICON_MOVE_DOWN,
  AE_ICON_MOVE_TOP,
  AE_ICON_MOVE_UP,
  AE_ICON_NO_STATUS,
} from "@/lib/aeSortIcons";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import { AE_TRIAGE_STATUS, type AeTriageGroup, aeGroupCounts } from "@/lib/aeTriage";
import {
  type AeRowPlace,
  type AeSidebarView,
  aeInsertionSide,
  aeMoveRow,
  aePlaceOf,
  useAeSidebarStore,
} from "./aeSidebarStore";
import { AeMenuFold } from "./AeMenuFold";

/**
 * A row as a drop target for its list's order, in any Ordering (outside
 * Manual a drop switches to it), also for a row dragged in from another list
 * (`aeCrossMove`): on for listed rows outside Pinned, Archived
 * and selection. A pending save never
 * toggles it, since every toggle re-measures every target mid-drag. The
 * insertion line shows on the row under the pointer, never on the dragged one,
 * portaled above the drag preview, which sits on the pointer and hid it.
 */
export function useAeOrderRow(
  id: string,
  {
    isPinned,
    isArchived,
    selectionMode,
  }: { isPinned: boolean; isArchived: boolean; selectionMode: boolean },
): { setNodeRef: (node: HTMLElement | null) => void; insertion: ReactNode } {
  const listed = useAeSidebarStore((s) => s.listed && s.listOf.has(id));
  const enabled = listed && !isPinned && !isArchived && !selectionMode;
  const { setNodeRef, isOver, active } = useDroppable({
    id: `ae-order:${id}`,
    data: { type: "ae-order", id },
    disabled: !enabled,
  });
  const nodeRef = useRef<HTMLElement | null>(null);
  const setRef = useCallback(
    (node: HTMLElement | null) => {
      nodeRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );
  const crossSide = useAeSidebarStore((s) => (s.crossSide?.id === id ? s.crossSide.side : null));
  const draggedId = active ? String(active.id) : null;
  const side =
    enabled && isOver && draggedId !== null && draggedId !== id
      ? (aeInsertionSide(draggedId, id) ?? crossSide)
      : null;
  const rect = side ? nodeRef.current?.getBoundingClientRect() : undefined;
  // Same root as the DragOverlay (z-index 999), one layer above it. The accent
  // color and end dot keep it from reading as a strikethrough on the preview.
  const insertion =
    side && rect
      ? createPortal(
          <span
            data-testid="ae-order-insertion"
            className="pointer-events-none fixed z-[1000] h-0.5 rounded-full bg-sidebar-primary"
            style={{
              left: rect.left,
              width: rect.width,
              top: (side === "before" ? rect.top : rect.bottom) - 1,
            }}
          >
            <span className="-left-1 -top-[3px] absolute size-2 rounded-full border-2 border-sidebar-primary bg-background" />
          </span>,
          getEmbedRoot() ?? document.body,
        )
      : null;
  return { setNodeRef: setRef, insertion };
}

// ── the Move menu ────────────────────────────────────────────────────────

// The subset of the sidebar's menu-component bundle the Move items render,
// typed structurally so both the dropdown and the context-menu families fit.
interface AeMoveItemProps {
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  textValue?: string;
  onSelect?: (event: Event) => void;
  "data-testid"?: string;
  "data-move"?: string;
}

export interface AeMoveMenuComponents {
  Item: ComponentType<AeMoveItemProps>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{
    children?: ReactNode;
    className?: string;
    "data-testid"?: string;
  }>;
  SubContent: ComponentType<{ children?: ReactNode; className?: string }>;
}

const MOVES: {
  to: Extract<AeMoveTo, string>;
  label: string;
  icon: AeTablerIconNode;
  /** The places where the move would change nothing. */
  idleAt: readonly AeRowPlace[];
}[] = [
  { to: "top", label: "Move to top", icon: AE_ICON_MOVE_TOP, idleAt: ["only", "first"] },
  { to: "up", label: "Move up", icon: AE_ICON_MOVE_UP, idleAt: ["only", "first"] },
  { to: "down", label: "Move down", icon: AE_ICON_MOVE_DOWN, idleAt: ["only", "last"] },
  { to: "bottom", label: "Move to bottom", icon: AE_ICON_MOVE_BOTTOM, idleAt: ["only", "last"] },
];

/**
 * The row menu's Move items for a listed row, in any Ordering (outside Manual
 * they switch to it): a submenu on desktop, and one row that folds the
 * items open under it on a phone, like Status. Plain items rather than radio
 * items: they act, they hold no choice.
 */
export function AeMoveMenu({
  components: C,
  conversationId,
  onDone,
}: {
  components: AeMoveMenuComponents;
  conversationId: string;
  onDone?: () => void;
}) {
  const isMobile = useIsMobileViewport();
  const place = useAeSidebarStore((s) => aePlaceOf(s, conversationId));
  if (place === null) return null;
  const items = MOVES.map(({ to, label, icon, idleAt }) => (
    <C.Item
      key={to}
      data-testid="ae-move-item"
      data-move={to}
      disabled={idleAt.includes(place)}
      textValue={label}
      onSelect={() => {
        onDone?.();
        aeMoveRow(conversationId, to);
      }}
    >
      <AeTablerSvg node={icon} className="size-3.5" />
      {label}
    </C.Item>
  ));
  if (isMobile) {
    return (
      <AeMenuFold
        Item={C.Item}
        icon={<AeTablerSvg node={AE_ICON_ARROWS_SORT} className="size-3.5" />}
        label="Move"
        testId="ae-move-menu"
      >
        {items}
      </AeMenuFold>
    );
  }
  return (
    <C.Sub>
      <C.SubTrigger data-testid="ae-move-menu" className="whitespace-nowrap">
        <AeTablerSvg node={AE_ICON_ARROWS_SORT} className="size-3.5" />
        Move
      </C.SubTrigger>
      <C.SubContent className="min-w-40">{items}</C.SubContent>
    </C.Sub>
  );
}

// ── the Triage headers ───────────────────────────────────────────────────

/**
 * A Triage group's header text: the status glyph, the word and the row count.
 * The glyph is hidden from screen readers, so the header reads as the word; a
 * named status icon there would read it twice.
 */
export function AeTriageTitle({ title, count }: { title: string; count: number }) {
  const status = AE_TRIAGE_STATUS[title as AeTriageGroup] ?? null;
  const Icon = status ? AE_STATUS_ICONS[status] : null;
  return (
    <span
      data-testid="ae-triage-title"
      data-group={title}
      className="inline-flex max-w-full items-center gap-1.5 align-middle"
    >
      {Icon ? (
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <AeTablerSvg node={AE_ICON_NO_STATUS} className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{title}</span>
      <span className="shrink-0 tabular-nums opacity-70">{count}</span>
    </span>
  );
}

// Counted once per list update, shared by every group header.
const counted = new WeakMap<ReadonlyMap<string, string>, Map<string, number>>();

/** The header content for a Triage group; `undefined` keeps every other header as is. */
export function aeTriageTitle(
  ae: AeSidebarView,
  title: string,
  groupTitles: ReadonlyMap<string, string> | null,
): ReactNode {
  if (!ae.triage || !groupTitles) return undefined;
  let counts = counted.get(groupTitles);
  if (!counts) {
    counts = aeGroupCounts(groupTitles);
    counted.set(groupTitles, counts);
  }
  return <AeTriageTitle title={title} count={counts.get(title) ?? 0} />;
}
