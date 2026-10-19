// The session rail's container: the sections in the saved order, sortable by
// their grips. Desktop docks it as a 304 px column (or floats it over the
// chat's right edge when docking would squeeze the chat, but never over an open
// panel); a phone shows it as a sheet.

import {
  type Announcements,
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  type Modifier,
  PointerSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type AeRailDragHandle, AeRailDragHandleContext } from "@/components/aeRail/AeRailSection";
import {
  AeRailActionsContext,
  type AeRailWorkspace,
  type AeRailWorkspaceTab,
} from "@/components/aeRail/aeRailActions";
import { AeRailIcon } from "@/components/aeRail/aeRailUi";
import { AE_RAIL_COMPONENTS } from "@/components/aeRail/registry";
import { Button } from "@/components/ui/button";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import {
  AE_RAIL_TITLES,
  AE_RAIL_WIDTH_PX as RAIL_WIDTH_PX,
  type AeRailFocus,
  type AeRailSectionId,
  aeRailFloats,
  aeRailIsPromotedSession,
  aeRailReservedWidth,
  useAeSessionRailStore,
} from "@/lib/aeSessionRail";
import { cn } from "@/lib/utils";

export { aeRailFloats, aeRailReservedWidth };

function subscribeToResize(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

/** Re-renders only when a window resize flips the decision, not on every pixel. */
function useRailFloats(reservedWidth: number): boolean {
  const getSnapshot = useCallback(
    () => aeRailFloats(window.innerWidth, reservedWidth),
    [reservedWidth],
  );
  return useSyncExternalStore(subscribeToResize, getSnapshot, () => false);
}

/**
 * One pane at a time: when the open rail would float over an open panel, the one
 * opened last stays and the other closes. A rail closed this way reopens once no
 * panel needs the room (as it was, floating or not); one the user closed stays closed.
 * With "open in every session" on, a session switch (not a new chat's id swap) opens the rail.
 */
function useOnePaneAtATime(
  sessionId: string,
  active: boolean,
  panelOpen: boolean,
  floating: boolean,
  closePanels: () => void,
) {
  const open = useAeSessionRailStore((s) => s.open);
  const closedForPanel = useAeSessionRailStore((s) => s.closedForPanel);
  const setClosedForPanel = useAeSessionRailStore((s) => s.setClosedForPanel);
  const setOpen = useAeSessionRailStore((s) => s.setOpen);
  const everySession = useAeSessionRailStore((s) => s.openInEverySession);
  const seenSession = useRef<string | null>(null);
  const previous = useRef({ open, panelOpen });
  // A layout effect settles the overlap before the browser paints it.
  useLayoutEffect(() => {
    const was = previous.current;
    previous.current = { open, panelOpen };
    const switched = seenSession.current !== sessionId;
    seenSession.current = sessionId;
    if (!active) return;
    if (switched && everySession && !open && !aeRailIsPromotedSession(sessionId)) {
      // The shell restores this session's panels after this commit, closed
      // when they would not fit (`aeRailRestoredPanelOpen`).
      setOpen(true);
      previous.current = { open: true, panelOpen };
      return;
    }
    const clash = panelOpen && floating;
    if (open && clash) {
      if (!was.open && was.panelOpen) closePanels();
      else setClosedForPanel(true);
    } else if (!open && closedForPanel && !clash) {
      setClosedForPanel(false);
      // Reopening on its own is not the user opening the rail over a panel.
      previous.current = { open: true, panelOpen };
    }
  });
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function AeSessionRail({
  sessionId,
  sidebarWidth = 0,
  workspacePanelWidth = 0,
  pushPanelOpen = false,
  hidden = false,
  workspace,
  closePushPanels,
}: {
  /** A real (server) session id; the shell skips the rail for `temp:` ids. */
  sessionId: string;
  /** The docked sidebar's width, 0 while it is closed. */
  sidebarWidth?: number;
  /** The open workspace panel's width, 0 while it is closed; it shares the chat's row. */
  workspacePanelWidth?: number;
  /** A files or logs push panel is open beside the chat. */
  pushPanelOpen?: boolean;
  /** The right panel is maximized over the chat. */
  hidden?: boolean;
  /** Lets the Changes and Agents rows open their workspace tabs. */
  workspace?: AeRailWorkspace;
  /** Closes the files and logs push panels. */
  closePushPanels?: () => void;
}) {
  const isMobile = useIsMobileViewport();
  // Push panels share one width store; this reads the width they open at.
  const { panelWidth: pushPanelWidth = 0 } = useResizablePanel(pushPanelOpen);
  const floating = useRailFloats(
    aeRailReservedWidth(sidebarWidth, workspacePanelWidth, pushPanelWidth),
  );
  const open = useAeSessionRailStore((s) => s.open);
  const sheetOpen = useAeSessionRailStore((s) => s.sheetOpen);
  const setSheetOpen = useAeSessionRailStore((s) => s.setSheetOpen);
  // The workspace closes through its own toggle even while a push panel hides it;
  // left open, it would reappear over the rail once the push panel closed.
  useOnePaneAtATime(
    sessionId,
    !isMobile && !hidden,
    workspacePanelWidth > 0 || pushPanelOpen,
    floating,
    () => {
      closePushPanels?.();
      if (workspace?.open) workspace.toggle();
    },
  );

  // A sheet left open while the window widens past the phone layout closes.
  useEffect(() => {
    if (!isMobile && sheetOpen) setSheetOpen(false);
  }, [isMobile, sheetOpen, setSheetOpen]);

  // AppShell builds a new `workspace` object every render; the opener reads the
  // latest one at click time so the context value only changes with these three.
  const workspaceRef = useRef(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  });
  const hasWorkspace = workspace !== undefined;
  const workspaceAvailable = workspace?.available ?? false;
  const actions = useMemo(() => {
    if (!hasWorkspace || (!isMobile && !workspaceAvailable)) return { openWorkspaceTab: undefined };
    return {
      openWorkspaceTab: (tab: AeRailWorkspaceTab) =>
        workspaceTabOpener(workspaceRef.current, isMobile, setSheetOpen)?.(tab),
    };
  }, [hasWorkspace, workspaceAvailable, isMobile, setSheetOpen]);
  if (!isMobile && (!open || hidden)) return null;
  return (
    <AeRailActionsContext.Provider value={actions}>
      {isMobile ? (
        <AeSessionRailSheet sessionId={sessionId} />
      ) : (
        <AeSessionRailColumn sessionId={sessionId} floating={floating} />
      )}
    </AeRailActionsContext.Provider>
  );
}

/** Opens a workspace tab; a phone first closes the rail's sheet, since its drawers are full screen. */
export function workspaceTabOpener(
  workspace: AeRailWorkspace | undefined,
  isMobile: boolean,
  setSheetOpen: (open: boolean) => void,
): ((tab: AeRailWorkspaceTab) => void) | undefined {
  if (!workspace) return undefined;
  if (isMobile) {
    return (tab) => {
      setSheetOpen(false);
      workspace.mobile[tab]();
    };
  }
  if (!workspace.available) return undefined;
  return (tab) => {
    if (!workspace.open) workspace.toggle();
    workspace.showTab(tab);
  };
}

function useEscapeToClose(active: boolean, root: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Menus inside the rail handle their own Escape first and mark it handled.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as Node | null;
      if (target !== document.body && !root.current?.contains(target)) return;
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, root, close]);
}

function AeSessionRailColumn({ sessionId, floating }: { sessionId: string; floating: boolean }) {
  const setOpen = useAeSessionRailStore((s) => s.setOpen);
  const rootRef = useRef<HTMLElement>(null);
  const close = useMemo(() => () => setOpen(false), [setOpen]);
  useEscapeToClose(floating, rootRef, close);
  return (
    <aside
      ref={rootRef}
      aria-label="Session rail"
      data-testid="ae-session-rail"
      data-floating={floating || undefined}
      style={{ width: RAIL_WIDTH_PX }}
      className={cn(
        "flex min-h-0 flex-col border-l border-border bg-background",
        floating ? "absolute inset-y-0 right-0 z-40 shadow-xl" : "shrink-0",
      )}
    >
      {floating && (
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
          <AeRailIcon name="rail" className="text-muted-foreground" />
          <h2 className="flex-1 font-medium text-ui">Session</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Hide session rail"
            onClick={close}
          >
            <AeRailIcon name="close" />
          </Button>
        </header>
      )}
      <AeSessionRailList sessionId={sessionId} className="min-h-0 flex-1 p-2" />
    </aside>
  );
}

function AeSessionRailSheet({ sessionId }: { sessionId: string }) {
  const sheetOpen = useAeSessionRailStore((s) => s.sheetOpen);
  const setSheetOpen = useAeSessionRailStore((s) => s.setSheetOpen);
  const rootRef = useRef<HTMLElement>(null);
  const close = useMemo(() => () => setSheetOpen(false), [setSheetOpen]);
  useEscapeToClose(sheetOpen, rootRef, close);
  return (
    <aside
      ref={rootRef}
      aria-label="Session rail"
      data-testid="ae-session-rail-sheet"
      data-state={sheetOpen ? "open" : "closed"}
      aria-hidden={!sheetOpen}
      inert={!sheetOpen}
      className={cn(
        // `mobile-panel-drawer` insets the sheet past the native shells' status bar.
        "mobile-panel-drawer fixed inset-0 z-50 flex flex-col overflow-hidden bg-background shadow-lg md:hidden",
        "transition-[translate] duration-150 ease-out",
        sheetOpen ? "translate-x-0" : "translate-x-full",
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border py-2 pr-2 pl-4">
        <AeRailIcon name="rail" className="text-muted-foreground" />
        <h2 className="flex-1 font-medium text-ui">Session</h2>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={close}>
          <AeRailIcon name="close" />
        </Button>
      </header>
      {sheetOpen && <AeSessionRailList sessionId={sessionId} className="min-h-0 flex-1 p-3" />}
    </aside>
  );
}

// Grips drag the section up and down only.
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function titleOf(id: UniqueIdentifier): string {
  return AE_RAIL_TITLES[id as AeRailSectionId] ?? String(id);
}

const ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}.`,
  onDragOver: ({ active, over }) =>
    over ? `${titleOf(active.id)} is over ${titleOf(over.id)}.` : `${titleOf(active.id)} moved.`,
  onDragEnd: ({ active, over }) =>
    over
      ? `${titleOf(active.id)} dropped in place of ${titleOf(over.id)}.`
      : `${titleOf(active.id)} dropped.`,
  onDragCancel: ({ active }) => `Move cancelled; ${titleOf(active.id)} stays where it was.`,
};

// The last focus request acted on. Module scope so reopening the rail does not
// replay an old request, and a request made as the rail opens still lands.
let handledFocus: AeRailFocus | null = null;

export function AeSessionRailList({
  sessionId,
  className,
}: {
  sessionId: string;
  className?: string;
}) {
  const order = useAeSessionRailStore((s) => s.order);
  const moveTo = useAeSessionRailStore((s) => s.moveTo);
  const focus = useAeSessionRailStore((s) => s.focus);
  const listRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<AeRailFocus | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (!focus || focus === handledFocus) return;
    // A frame later, so a section unfolded by the request has its body laid out.
    const frame = requestAnimationFrame(() => {
      handledFocus = focus;
      const item = listRef.current?.querySelector(`[data-ae-rail-item="${focus.id}"]`);
      item?.scrollIntoView({
        block: "nearest",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      setFlash(focus);
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 1000);
    return () => clearTimeout(timer);
  }, [flash]);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const index = order.indexOf(over.id as AeRailSectionId);
    if (index >= 0) moveTo(active.id as AeRailSectionId, index);
  };

  return (
    <div
      ref={listRef}
      data-testid="ae-session-rail-list"
      className={cn("flex flex-col gap-2 overflow-x-hidden overflow-y-auto", className)}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        accessibility={{ announcements: ANNOUNCEMENTS }}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          {order.map((id) => (
            <AeRailSortableItem
              key={id}
              id={id}
              sessionId={sessionId}
              flashing={flash?.id === id}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

function AeRailSortableItem({
  id,
  sessionId,
  flashing,
}: {
  id: AeRailSectionId;
  sessionId: string;
  flashing: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const handle = useMemo<AeRailDragHandle>(
    () => ({
      ref: setActivatorNodeRef,
      props: { ...attributes, ...listeners },
      dragging: isDragging,
    }),
    [setActivatorNodeRef, attributes, listeners, isDragging],
  );
  const Section = AE_RAIL_COMPONENTS[id];
  const style: CSSProperties = {
    transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
    transition,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-ae-rail-item={id}
      data-flashing={flashing || undefined}
      className={cn(
        "shrink-0 rounded-[10px] transition-shadow duration-300",
        isDragging && "relative z-10",
        flashing && "ring-2 ring-ring",
      )}
    >
      <AeRailDragHandleContext.Provider value={handle}>
        <Section sessionId={sessionId} />
      </AeRailDragHandleContext.Provider>
    </div>
  );
}
