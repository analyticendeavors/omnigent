// One folding section of the session rail: a header (drag grip, title that
// folds it, summary, a menu with the moves a phone needs) over a body that
// renders only while unfolded.

import { createContext, type ReactNode, useContext, useId } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AE_RAIL_TITLES,
  type AeRailSectionId,
  useAeRailSectionOpen,
  useAeSessionRailStore,
} from "@/lib/aeSessionRail";
import { cn } from "@/lib/utils";
import { AeRailIcon } from "./aeRailUi";

/** What the rail's sortable list hands a section header to make its grip drag the section. */
export interface AeRailDragHandle {
  ref: (element: HTMLElement | null) => void;
  /** Spread on the grip: dnd-kit's attributes and listeners. */
  props: Record<string, unknown>;
  dragging: boolean;
}

export const AeRailDragHandleContext = createContext<AeRailDragHandle | null>(null);

export function AeRailSection({
  id,
  summary,
  foldedSummary,
  children,
}: {
  id: AeRailSectionId;
  /** Beside the title, folded or not ("5 running"). */
  summary?: ReactNode;
  /** Beside the title only while folded (the host and branch). */
  foldedSummary?: ReactNode;
  /** The body; rendered only while unfolded. */
  children: ReactNode;
}) {
  const open = useAeRailSectionOpen(id);
  const setFolded = useAeSessionRailStore((s) => s.setFolded);
  const handle = useContext(AeRailDragHandleContext);
  const bodyId = useId();
  const title = AE_RAIL_TITLES[id];
  const shownSummary = open ? summary : (foldedSummary ?? summary);
  return (
    <section
      aria-label={title}
      data-ae-rail-section={id}
      className={cn(
        "group/rail-section rounded-[10px] border border-border bg-card",
        handle?.dragging && "relative z-10 shadow-lg",
      )}
    >
      <div className="flex min-h-9 items-center gap-1 py-1.5 pr-1.5 pl-1">
        <button
          type="button"
          ref={handle?.ref}
          {...handle?.props}
          aria-label={`Drag to reorder ${title}`}
          className={cn(
            "flex h-6 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground",
            "opacity-0 group-hover/rail-section:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
            "active:cursor-grabbing",
            !handle && "invisible",
          )}
        >
          <AeRailIcon name="grip" className="size-3.5" />
        </button>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setFolded(id, open)}
          className="flex items-center gap-1 rounded px-1 py-0.5 font-semibold hover:bg-muted"
        >
          {title}
          <AeRailIcon
            name="chevronDown"
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              !open && "-rotate-90",
            )}
          />
        </button>
        {shownSummary != null && (
          <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
            {shownSummary}
          </span>
        )}
        <AeRailSectionMenu id={id} className={shownSummary == null ? "ml-auto" : undefined} />
      </div>
      {open && (
        <div id={bodyId} className="px-3 pb-2.5">
          {children}
        </div>
      )}
    </section>
  );
}

function AeRailSectionMenu({ id, className }: { id: AeRailSectionId; className?: string }) {
  const order = useAeSessionRailStore((s) => s.order);
  const moveBy = useAeSessionRailStore((s) => s.moveBy);
  const moveToTop = useAeSessionRailStore((s) => s.moveToTop);
  const resetOrder = useAeSessionRailStore((s) => s.resetOrder);
  const index = order.indexOf(id);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${AE_RAIL_TITLES[id]} options`}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground",
            "opacity-0 group-hover/rail-section:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100",
            className,
          )}
        >
          <AeRailIcon name="dots" className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={index <= 0} onSelect={() => moveBy(id, -1)}>
          <AeRailIcon name="arrowUp" className="size-3.5" />
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem disabled={index >= order.length - 1} onSelect={() => moveBy(id, 1)}>
          <AeRailIcon name="arrowDown" className="size-3.5" />
          Move down
        </DropdownMenuItem>
        <DropdownMenuItem disabled={index <= 0} onSelect={() => moveToTop(id)}>
          <AeRailIcon name="arrowToTop" className="size-3.5" />
          Move to top
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={resetOrder}>
          <AeRailIcon name="restore" className="size-3.5" />
          Reset order
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
