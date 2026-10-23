// Settings > Roles: the preset row. Collapsed, it shows the open preset by
// name, then the default, pinned and other presets as icons, as many as fit
// the measured width, then "+N" for the rest.
// "All presets" (or "+N") opens the list: Pinned, then Others, in the saved
// order, sortable by their grips (a grip's Up and Down arrows move it too),
// searchable past eight presets.

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  GripVerticalIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AE_PRESET_SEARCH_FROM,
  AE_PRESET_SHORTCUTS,
  type AeRolePreset,
  aeRowIconCount,
  aeRowOrder,
} from "@/lib/aeRoles";
import { cn } from "@/lib/utils";
import { AeRolePresetTile } from "./AeRolesControls";

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** The new-preset button and the gap before it, in px. */
const NEW_BUTTON_PX = 34;

/** Longest the open chip grows, px (its max-w-[14rem]). */
const OPEN_CHIP_MAX_PX = 224;

/**
 * The open chip's natural width: its shown width plus whatever its title lost
 * to truncation, so a chip that shrank to fit does not make room for more icons.
 */
function openChipWidth(chip: HTMLElement | null): number {
  if (!chip) return 0;
  const title = chip.querySelector<HTMLElement>("span.truncate");
  const cut = title ? Math.max(0, title.scrollWidth - title.clientWidth) : 0;
  return Math.min(chip.offsetWidth + cut, OPEN_CHIP_MAX_PX);
}

/**
 * The inner row's width and the open chip's, measured as the window resizes
 * and again whenever the open preset or its title changes (`chipKey`).
 */
function useRowWidths(chipKey: string) {
  const rowRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const [widths, setWidths] = useState({ row: 0, open: 0 });
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let rowWidth = Math.floor(row.clientWidth);
    const measure = () =>
      setWidths((old) => {
        const next = { row: rowWidth, open: openChipWidth(openRef.current) + 6 };
        return next.row === old.row && next.open === old.open ? old : next;
      });
    measure();
    const rowObserver = new ResizeObserver((entries) => {
      rowWidth = Math.floor(entries[0]?.contentRect.width ?? row.clientWidth);
      measure();
    });
    rowObserver.observe(row);
    // The open chip can shrink, so its own resize changes how many icons fit.
    const chip = openRef.current;
    const chipObserver = chip ? new ResizeObserver(() => measure()) : null;
    if (chip) chipObserver?.observe(chip);
    return () => {
      rowObserver.disconnect();
      chipObserver?.disconnect();
    };
  }, [chipKey]);
  return { rowRef, openRef, widths };
}

export function AeRolesCollapsedRow({
  presets,
  openId,
  defaultId,
  listOpen,
  onOpen,
  onToggleList,
  onNew,
  canAdd,
}: {
  presets: readonly AeRolePreset[];
  openId: string;
  defaultId: string;
  listOpen: boolean;
  onOpen: (id: string) => void;
  onToggleList: () => void;
  onNew: () => void;
  canAdd: boolean;
}) {
  const ordered = aeRowOrder(presets, openId, defaultId);
  const open = ordered[0]?.id === openId ? ordered[0] : undefined;
  const { rowRef, openRef, widths } = useRowWidths(open ? `${open.id}\u0000${open.title}` : "");
  const others = open ? ordered.slice(1) : ordered;
  const fit = aeRowIconCount(widths.row, widths.open + NEW_BUTTON_PX, others.length);
  const icons = others.slice(0, fit);
  const hidden = others.length - icons.length;
  return (
    <div
      data-testid="ae-roles-row"
      className="flex min-w-0 items-center gap-1.5 rounded-xl border border-border bg-muted/30 p-1.5"
    >
      <div ref={rowRef} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {open && (
          <button
            ref={openRef}
            type="button"
            aria-current="true"
            aria-label={`${open.title}${open.id === defaultId ? ", your default" : ""}, open`}
            onClick={() => onOpen(open.id)}
            className="flex max-w-[14rem] min-w-0 shrink items-center gap-2 rounded-lg border border-foreground/60 bg-background py-0.5 pr-2.5 pl-0.5 text-sm font-semibold"
          >
            <AeRolePresetTile icon={open.icon} color={open.color} dot={open.id === defaultId} />
            <span className="truncate">{open.title}</span>
          </button>
        )}
        {icons.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-label={`${preset.title}${preset.id === defaultId ? ", your default" : ""}`}
            title={preset.title}
            onClick={() => onOpen(preset.id)}
            className="shrink-0 rounded-lg"
          >
            <AeRolePresetTile
              icon={preset.icon}
              color={preset.color}
              dot={preset.id === defaultId}
            />
          </button>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            aria-label={`${hidden} more presets`}
            aria-expanded={listOpen}
            onClick={onToggleList}
            className="h-7 shrink-0 rounded-lg bg-muted px-2 text-xs font-semibold"
          >
            +{hidden}
          </button>
        )}
        <button
          type="button"
          aria-label="New preset"
          title="New preset"
          disabled={!canAdd}
          onClick={onNew}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
      <button
        type="button"
        aria-expanded={listOpen}
        onClick={onToggleList}
        className="flex shrink-0 items-center gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        {listOpen ? "Collapse" : "All presets"}
        {listOpen ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
      </button>
    </div>
  );
}

function ListRow({
  preset,
  index,
  total,
  isOpen,
  isDefault,
  sortable,
  busy,
  onOpen,
  onPin,
  onMove,
}: {
  preset: AeRolePreset;
  index: number;
  total: number;
  isOpen: boolean;
  isDefault: boolean;
  sortable: boolean;
  busy: boolean;
  onOpen: () => void;
  onPin: () => void;
  onMove: (to: number) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: preset.id, disabled: !sortable || busy });
  const style: CSSProperties = {
    transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
    transition,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`ae-preset-item-${preset.id}`}
      className={cn(
        "flex items-center gap-2 rounded-lg border px-1.5 py-1.5",
        isOpen ? "border-foreground/50 bg-muted/40" : "border-transparent",
        isDragging && "relative z-10 bg-background shadow-md",
      )}
    >
      <button
        ref={setActivatorNodeRef}
        data-ae-grip={preset.id}
        type="button"
        aria-label={`Move ${preset.title}: drag, or press Up or Down`}
        disabled={!sortable}
        {...attributes}
        {...listeners}
        aria-disabled={busy || !sortable || undefined}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          if (busy) return;
          const to = index + (e.key === "ArrowUp" ? -1 : 1);
          if (to >= 0 && to < total) onMove(to);
        }}
        className="flex h-8 w-5 shrink-0 touch-none cursor-grab items-center justify-center text-muted-foreground disabled:cursor-default disabled:opacity-30"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onOpen}
        aria-current={isOpen ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <AeRolePresetTile icon={preset.icon} color={preset.color} size="sm" />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm">
            <span className="truncate">{preset.title}</span>
            {isDefault && (
              <span className="shrink-0 rounded-full bg-teal-500/20 px-1.5 text-[10px] font-semibold text-teal-400">
                Default
              </span>
            )}
          </span>
          {preset.description && (
            <span className="block truncate text-xs text-muted-foreground">
              {preset.description}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        aria-pressed={preset.pinned}
        aria-label={preset.pinned ? `Unpin ${preset.title}` : `Pin ${preset.title}`}
        title={preset.pinned ? "Pinned: stays in the row" : "Pin to the row"}
        disabled={busy}
        onClick={onPin}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-muted",
          preset.pinned ? "text-teal-400" : "text-muted-foreground/60",
        )}
      >
        <PinIcon className={cn("size-3.5", preset.pinned && "fill-current")} />
      </button>
      <span className="w-4 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {index < AE_PRESET_SHORTCUTS ? index + 1 : ""}
      </span>
    </li>
  );
}

export function AeRolesPresetList({
  presets,
  openId,
  defaultId,
  missingStarters,
  busy,
  onOpen,
  onPin,
  onMove,
  onDrop,
  onRestore,
}: {
  presets: readonly AeRolePreset[];
  openId: string;
  defaultId: string;
  missingStarters: number;
  busy: boolean;
  onOpen: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onMove: (id: string, to: number) => void;
  onDrop: (id: string, overId: string) => void;
  onRestore: () => void;
}) {
  const [query, setQuery] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const searchable = presets.length > AE_PRESET_SEARCH_FROM;
  const words = searchable ? query.toLowerCase().trim().split(/\s+/).filter(Boolean) : [];
  const matches = (p: AeRolePreset) =>
    words.every((w) => `${p.title} ${p.description}`.toLowerCase().includes(w));
  // While a save runs the grip is aria-disabled and ignores keys and drags, never `disabled`:
  // that would drop its focus.
  const sortable = words.length === 0;
  const listRef = useRef<HTMLDivElement>(null);
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-ae-grip="${CSS.escape(id)}"]`)?.focus();
  }, [presets]);
  const pinned = presets.filter((p) => p.pinned);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (busy) return;
    if (over && active.id !== over.id) onDrop(String(active.id), String(over.id));
  };
  const group = (title: string, rows: readonly AeRolePreset[]) => {
    const visible = rows.filter(matches);
    if (visible.length === 0) return null;
    return (
      <div>
        <div className="flex justify-between px-1.5 pt-2 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          <span>{title}</span>
          <span>Alt</span>
        </div>
        <ul aria-label={title} className="flex flex-col">
          {visible.map((preset) => {
            const index = presets.indexOf(preset);
            return (
              <ListRow
                key={preset.id}
                preset={preset}
                index={index}
                total={presets.length}
                isOpen={preset.id === openId}
                isDefault={preset.id === defaultId}
                sortable={sortable}
                busy={busy}
                onOpen={() => onOpen(preset.id)}
                onPin={() => onPin(preset.id, !preset.pinned)}
                onMove={(to) => {
                  refocus.current = preset.id;
                  onMove(preset.id, to);
                }}
              />
            );
          })}
        </ul>
      </div>
    );
  };
  return (
    <div ref={listRef} data-testid="ae-roles-list" className="rounded-xl border border-border p-2">
      {searchable && (
        <label className="flex items-center gap-2 rounded-md border border-input px-2 py-1.5">
          <SearchIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${presets.length} presets`}
            aria-label={`Search ${presets.length} presets`}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[verticalOnly]}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={presets.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          {group("Pinned · stay in the row", pinned)}
          {group(
            pinned.length > 0 ? "Others" : "Presets",
            presets.filter((p) => !p.pinned),
          )}
        </SortableContext>
      </DndContext>
      {words.length > 0 && !presets.some(matches) && (
        <p className="px-1.5 py-3 text-sm text-muted-foreground">No preset matches “{query}”.</p>
      )}
      {missingStarters > 0 && (
        <p className="px-1.5 pt-2 text-xs text-muted-foreground">
          Removed a starter?{" "}
          <button
            type="button"
            disabled={busy}
            onClick={onRestore}
            className="text-teal-400 hover:underline disabled:opacity-50"
          >
            Restore starters
          </button>
        </p>
      )}
    </div>
  );
}
