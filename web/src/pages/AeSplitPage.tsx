// The split view (omnigent-ae patch P5, 2026-09-24): two to four sessions in
// one window, like the Claude desktop app's multi-panel layout. `/split?s=a,b`
// renders one pane per session; each pane is a frame of the ordinary `/c/:id`
// route (see `lib/aeSplitLayout.ts` for why a frame), with a strip carrying a
// grip to move it, a session switcher, "open alone" and close. The layout is
// remembered in local storage; with no `s` parameter the remembered one opens.
// Desktop only: below 1024px the route falls back to the first pane's session
// on its own.
//
// Layout presets (patch P10, 2026-09-24): the top bar's picker arranges the
// panes side by side, stacked, 2+1 or its mirror, or in a 2x2 grid (`&l=` in
// the URL when not side by side). Dividers resize columns and stacked panes;
// a pane's grip swaps it with another by drag or arrow keys. Panes are laid out
// absolutely from the layout's rectangles and rendered in a fixed order, so a
// preset change or a swap moves a frame on screen without moving it in the
// DOM: a moved iframe reloads, which would drop a pane's stream and draft.

import {
  GripVerticalIcon,
  LayoutGridIcon,
  Maximize2Icon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { type Conversation, useConversations } from "@/hooks/useConversations";
import {
  AE_SPLIT_MAX_PANES,
  AE_SPLIT_MIN_VIEWPORT_PX,
  AE_SPLIT_PANE_NAME_PREFIX,
  AE_SPLIT_PRESETS,
  type AeSplitLayout,
  type AeSplitPane,
  type AeSplitPreset,
  type AeSplitPresetId,
  type AeSplitRect,
  addPane,
  addedSlot,
  applyPreset,
  equalGrid,
  fitLayout,
  formatLayoutParam,
  formatSplitParam,
  isAeSplitPane,
  keptSlots,
  makeLayout,
  nextPreset,
  paneSessionFromPath,
  paneSrc,
  parseLayoutParam,
  parseSplitParam,
  presetById,
  readStoredLayout,
  removePane,
  resizeColumn,
  resizeRow,
  slotCount,
  slotRects,
  swapPanes,
  writeStoredLayout,
} from "@/lib/aeSplitLayout";
import { useNavigate, useSearchParams } from "@/lib/routing";

/** How often the page reads each frame's location and title (a frame's SPA navigation fires no event). */
export const AE_SPLIT_FRAME_POLL_MS = 1000;

/** One arrow-key press on a divider moves it by this fraction of the row or column. */
const KEYBOARD_STEP = 0.02;

/** The gap between panes, in pixels; the divider fills it. */
const GAP_PX = 6;
const HALF_GAP = GAP_PX / 2;

const DESKTOP_QUERY = `(min-width: ${AE_SPLIT_MIN_VIEWPORT_PX}px)`;

function subscribeDesktop(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getDesktop(): boolean {
  if (typeof window === "undefined") return true;
  if (typeof window.matchMedia === "function") return window.matchMedia(DESKTOP_QUERY).matches;
  return window.innerWidth >= AE_SPLIT_MIN_VIEWPORT_PX;
}

/** True when the viewport is wide enough for panes (1024px and up). */
export function useIsSplitViewport(): boolean {
  return useSyncExternalStore(subscribeDesktop, getDesktop, () => true);
}

/**
 * The layout the page opens with: the URL's panes in the URL's preset (`l`,
 * side by side when absent), keeping the remembered sizes when the remembered
 * layout has the same preset and pane count; else the remembered layout; else
 * one empty pane.
 */
export function initialLayout(
  param: string | null,
  stored: AeSplitLayout | null,
  layoutParam: string | null = null,
): AeSplitLayout {
  const fromUrl = parseSplitParam(param);
  if (fromUrl) {
    const layout = makeLayout(fromUrl, parseLayoutParam(layoutParam, fromUrl.length) ?? undefined);
    if (stored && stored.preset === layout.preset && stored.panes.length === fromUrl.length) {
      return fitLayout({ ...layout, cols: stored.cols, rows: stored.rows });
    }
    return layout;
  }
  if (stored) return stored;
  return makeLayout([null]);
}

/** The split route's query for *layout*: `s=` always, `&l=` when not the default preset. */
function layoutQuery(layout: AeSplitLayout): string {
  const l = formatLayoutParam(layout.preset, layout.panes.length);
  return `s=${formatSplitParam(layout.panes)}${l ? `&l=${l}` : ""}`;
}

function sessionLabel(
  pane: AeSplitPane,
  frameTitle: string | undefined,
  byId: Map<string, Conversation>,
): string {
  if (pane === null) return "New session";
  const title = byId.get(pane)?.title?.trim();
  if (title) return title;
  if (frameTitle) return frameTitle;
  return pane;
}

/** A CSS length at *fraction* of the pane area, shifted by *px*. */
function at(fraction: number, px = 0): string {
  if (px === 0) return `${fraction * 100}%`;
  return `calc(${fraction * 100}% ${px < 0 ? "-" : "+"} ${Math.abs(px)}px)`;
}

/** Absolute placement for a slot, leaving half the gap on every inner edge. */
function rectStyle(rect: AeSplitRect, columns: number, rowsInColumn: number): CSSProperties {
  const left = rect.column === 0 ? 0 : HALF_GAP;
  const right = rect.column === columns - 1 ? 0 : HALF_GAP;
  const top = rect.row === 0 ? 0 : HALF_GAP;
  const bottom = rect.row === rowsInColumn - 1 ? 0 : HALF_GAP;
  return {
    position: "absolute",
    left: at(rect.x, left),
    width: at(rect.w, -(left + right)),
    top: at(rect.y, top),
    height: at(rect.h, -(top + bottom)),
  };
}

/** The preset's shape drawn small: one rectangle per pane, for the picker. */
function PresetIcon({ preset }: { preset: AeSplitPreset }) {
  const W = 18;
  const H = 14;
  const g = 1.5;
  const cols = preset.shape.length;
  const cw = (W - g * (cols - 1)) / cols;
  const rects: { id: string; x: number; y: number; w: number; h: number }[] = [];
  preset.shape.forEach((n, c) => {
    const rh = (H - g * (n - 1)) / n;
    for (let r = 0; r < n; r++) {
      rects.push({ id: `${c}-${r}`, x: c * (cw + g), y: r * (rh + g), w: cw, h: rh });
    }
  });
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="shrink-0">
      {rects.map((r) => (
        <rect
          key={r.id}
          x={r.x + 0.5}
          y={r.y + 0.5}
          width={r.w - 1}
          height={r.h - 1}
          rx={1}
          fill="currentColor"
          fillOpacity={0.2}
          stroke="currentColor"
          strokeWidth={1}
        />
      ))}
    </svg>
  );
}

/** Panes and the frame key of each slot; the keys follow their panes through every change. */
interface SplitState {
  layout: AeSplitLayout;
  keys: number[];
}

export function AeSplitPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const desktop = useIsSplitViewport();
  const param = searchParams.get("s");
  const layoutParam = searchParams.get("l");
  // Frames are keyed by a per-pane serial, not by slot or session: closing a
  // pane must not reload its neighbours, and a pane that navigates inside its
  // own frame must not be remounted by the layout catching up with it.
  const serial = useRef(0);
  const [state, setState] = useState<SplitState>(() => {
    const layout = initialLayout(param, readStoredLayout(), layoutParam);
    return { layout, keys: layout.panes.map(() => serial.current++) };
  });
  const { layout, keys } = state;
  const [frameTitles, setFrameTitles] = useState<Record<number, string>>({});
  const [dragging, setDragging] = useState(false);
  const [moving, setMoving] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const frameRefs = useRef(new Map<number, HTMLIFrameElement>());
  const keysRef = useRef(keys);
  keysRef.current = keys;

  const setLayout = useCallback((next: (prev: AeSplitLayout) => AeSplitLayout) => {
    setState((prev) => {
      const nextLayout = next(prev.layout);
      return nextLayout === prev.layout ? prev : { ...prev, layout: nextLayout };
    });
  }, []);

  const { data } = useConversations("", false, { enabled: desktop });
  const conversations = useMemo(() => data?.pages.flatMap((p) => p.data) ?? [], [data]);
  const byId = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations]);

  // Remember the layout and keep the URL on it, so a reload or a copied link
  // lands on the same panes in the same arrangement.
  useEffect(() => {
    writeStoredLayout(layout);
    const next = layoutQuery(layout);
    const current = `s=${param ?? ""}${layoutParam ? `&l=${layoutParam}` : ""}`;
    if (next !== current) navigate(`/split?${next}`, { replace: true });
  }, [layout, navigate, param, layoutParam]);

  useEffect(() => {
    document.title = `Split view (${layout.panes.length})`;
  }, [layout.panes.length]);

  // Follow each frame: when the user opens another session (or creates one)
  // inside a pane, the pane now holds that session.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const titles: Record<number, string> = {};
      const seen: (AeSplitPane | undefined)[] = [];
      keysRef.current.forEach((key, i) => {
        try {
          const win = frameRefs.current.get(key)?.contentWindow;
          if (!win) return;
          seen[i] = paneSessionFromPath(win.location.pathname);
          const title = win.document.title;
          if (title) titles[key] = title;
        } catch {
          // A frame mid-navigation, or one that left the origin; skip a beat.
        }
      });
      setFrameTitles((prev) => (sameTitles(prev, titles) ? prev : titles));
      setLayout((prev) => {
        let changed = false;
        const panes = prev.panes.map((pane, i) => {
          const now = seen[i];
          if (now === undefined || now === pane) return pane;
          // Never let two panes hold one session; the frame that moved onto
          // a session already open elsewhere keeps its old slot value.
          if (now !== null && prev.panes.includes(now)) return pane;
          changed = true;
          return now;
        });
        return changed ? { ...prev, panes } : prev;
      });
    }, AE_SPLIT_FRAME_POLL_MS);
    return () => window.clearInterval(timer);
  }, [setLayout]);

  const setPaneSession = useCallback((index: number, session: AeSplitPane) => {
    setState((prev) => {
      if (session !== null && prev.layout.panes.some((p, i) => p === session && i !== index)) {
        return prev;
      }
      const panes = [...prev.layout.panes];
      panes[index] = session;
      // A picked session is a new document in that frame.
      const nextKeys = prev.keys.map((k, i) => (i === index ? serial.current++ : k));
      return { layout: { ...prev.layout, panes }, keys: nextKeys };
    });
  }, []);

  const closePane = useCallback((index: number) => {
    setState((prev) => {
      const nextLayout = removePane(prev.layout, index);
      if (nextLayout === prev.layout) return prev;
      return { layout: nextLayout, keys: prev.keys.filter((_, i) => i !== index) };
    });
  }, []);

  const onAddPane = useCallback(() => {
    setState((prev) => {
      const slot = addedSlot(prev.layout);
      if (slot < 0) return prev;
      const nextKeys = [...prev.keys];
      nextKeys.splice(slot, 0, serial.current++);
      return { layout: addPane(prev.layout), keys: nextKeys };
    });
  }, []);

  const pickPreset = useCallback((preset: AeSplitPresetId) => {
    setState((prev) => {
      if (prev.layout.preset === preset) return prev;
      const kept = keptSlots(prev.layout.panes, slotCount(preset)).map((i) => prev.keys[i]!);
      while (kept.length < slotCount(preset)) kept.push(serial.current++);
      return { layout: applyPreset(prev.layout, preset), keys: kept };
    });
  }, []);

  const swap = useCallback((a: number, b: number) => {
    setState((prev) => {
      const nextLayout = swapPanes(prev.layout, a, b);
      if (nextLayout === prev.layout) return prev;
      const nextKeys = [...prev.keys];
      [nextKeys[a], nextKeys[b]] = [nextKeys[b]!, nextKeys[a]!];
      return { layout: nextLayout, keys: nextKeys };
    });
  }, []);

  const startDrag = useCallback(
    (
      axis: "x" | "y",
      apply: (prev: AeSplitLayout, delta: number) => AeSplitLayout,
      event: ReactPointerEvent<HTMLDivElement>,
    ) => {
      const area = areaRef.current;
      if (!area) return;
      event.preventDefault();
      const box = area.getBoundingClientRect();
      const span = (axis === "x" ? box.width : box.height) || 1;
      let last = axis === "x" ? event.clientX : event.clientY;
      setDragging(true);
      const onMove = (e: PointerEvent) => {
        const now = axis === "x" ? e.clientX : e.clientY;
        const delta = (now - last) / span;
        last = now;
        setLayout((prev) => apply(prev, delta));
      };
      const onUp = () => {
        setDragging(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [setLayout],
  );

  const nudge = useCallback(
    (
      axis: "x" | "y",
      apply: (prev: AeSplitLayout, delta: number) => AeSplitLayout,
      event: ReactKeyboardEvent<HTMLDivElement>,
    ) => {
      const [back, forward] = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
      const step = event.key === back ? -KEYBOARD_STEP : event.key === forward ? KEYBOARD_STEP : 0;
      if (step === 0) return;
      event.preventDefault();
      setLayout((prev) => apply(prev, step));
    },
    [setLayout],
  );

  const moveByKey = useCallback(
    (index: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const step =
        event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : event.key === "ArrowRight" || event.key === "ArrowDown"
            ? 1
            : 0;
      if (step === 0) return;
      event.preventDefault();
      swap(index, index + step);
    },
    [swap],
  );

  const endMove = useCallback(() => {
    setMoving(null);
    setDropTarget(null);
  }, []);

  // A split page inside a pane would nest frames without end; show the session instead.
  if (isAeSplitPane()) return <Navigate to={paneSrc(layout.panes[0] ?? null)} replace />;
  if (!desktop)
    return <Navigate to={paneSrc(layout.panes.find((p) => p !== null) ?? null)} replace />;

  const first = layout.panes.find((p) => p !== null) ?? null;
  const shape = presetById(layout.preset)?.shape ?? [1];
  const rects = slotRects(layout);
  const grows = nextPreset(layout.preset);
  const sessions = layout.panes.filter((p) => p !== null).length;
  // Render in key order, which never changes for a live frame (see the header).
  const order = keys.map((key, slot) => ({ key, slot })).sort((a, b) => a.key - b.key);
  const frozen = dragging || moving !== null;
  // A divider after every column but the last, and under every stacked pane but a column's last.
  const colDividers = rects
    .filter((r) => r.row === 0 && r.column < shape.length - 1)
    .map((r) => ({ id: `col-${r.column}`, column: r.column, x: r.x + r.w }));
  const rowDividers = rects
    .filter((r) => r.row < (shape[r.column] ?? 1) - 1)
    .map((r) => ({ id: `row-${r.column}-${r.row}`, rect: r }));

  return (
    <div className="flex h-dvh flex-col bg-sidebar text-foreground" data-testid="ae-split-page">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <LayoutGridIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-sm font-medium">Split view</h1>
        <span className="text-xs text-muted-foreground" data-testid="ae-split-count">
          {layout.panes.length} of {AE_SPLIT_MAX_PANES} panes
        </span>
        <div
          role="group"
          aria-label="Layout"
          className="ml-3 flex items-center gap-0.5 rounded-md border border-border p-0.5"
          data-testid="ae-split-presets"
        >
          {AE_SPLIT_PRESETS.map((preset) => {
            const active = preset.id === layout.preset;
            const slots = slotCount(preset.id);
            const drops = sessions - slots;
            const title =
              drops > 0
                ? `${preset.label}: keeps the first ${slots} sessions; the other ${drops} close here and keep running`
                : preset.label;
            return (
              <button
                key={preset.id}
                type="button"
                aria-label={preset.label}
                aria-pressed={active}
                title={title}
                onClick={() => pickPreset(preset.id)}
                className={`flex h-6 w-7 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active
                    ? "bg-accent text-foreground ring-1 ring-border"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                }`}
                data-testid={`ae-split-preset-${preset.id}`}
              >
                <PresetIcon preset={preset} />
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLayout((prev) => ({ ...prev, ...equalGrid(prev.preset) }))}
            data-testid="ae-split-equalize"
          >
            Equal sizes
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onAddPane}
            disabled={grows === null}
            title={
              grows === null
                ? `A split view holds at most ${AE_SPLIT_MAX_PANES} panes; close one first`
                : `Add a pane with a new session (layout: ${presetById(grows)?.label})`
            }
            data-testid="ae-split-add"
          >
            <PlusIcon className="size-3.5" />
            Add pane
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(paneSrc(first))}
            title="Leave the split view and show the first pane's session on its own"
            data-testid="ae-split-exit"
          >
            <SquareIcon className="size-3.5" />
            Single view
          </Button>
        </div>
      </header>
      <div
        ref={areaRef}
        className="relative min-h-0 flex-1"
        data-testid="ae-split-row"
        data-preset={layout.preset}
      >
        {order.map(({ key, slot: i }) => {
          const pane = layout.panes[i] ?? null;
          const rect = rects[i];
          if (!rect) return null;
          const label = sessionLabel(pane, frameTitles[key], byId);
          const target = moving !== null && dropTarget === i && moving !== i;
          return (
            <section
              key={key}
              className={`flex min-w-0 flex-col overflow-hidden bg-background ${
                target ? "ring-2 ring-primary ring-inset" : ""
              }`}
              style={rectStyle(rect, shape.length, shape[rect.column] ?? 1)}
              aria-label={label}
              data-testid="ae-split-pane"
              data-slot={i}
              data-session={pane ?? ""}
              onDragOver={(e: ReactDragEvent<HTMLElement>) => {
                if (moving === null) return;
                e.preventDefault();
                if (dropTarget !== i) setDropTarget(i);
              }}
              onDrop={(e: ReactDragEvent<HTMLElement>) => {
                if (moving === null) return;
                e.preventDefault();
                swap(moving, i);
                endMove();
              }}
            >
              <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
                <button
                  type="button"
                  draggable
                  aria-label={`Move pane ${i + 1}: drag onto another pane, or use the arrow keys`}
                  title="Drag onto another pane to swap, or focus and use the arrow keys"
                  className="flex h-6 w-4 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                  onKeyDown={(e) => moveByKey(i, e)}
                  onDragStart={(e) => {
                    try {
                      e.dataTransfer?.setData("text/plain", String(i));
                      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                    } catch {
                      // Some engines refuse data on a synthetic drag; the index lives in state.
                    }
                    setMoving(i);
                  }}
                  onDragEnd={endMove}
                  data-testid="ae-split-grip"
                >
                  <GripVerticalIcon className="size-3.5" />
                </button>
                <select
                  className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs"
                  aria-label={`Session in pane ${i + 1}`}
                  value={pane ?? ""}
                  onChange={(e) => setPaneSession(i, e.target.value === "" ? null : e.target.value)}
                  data-testid="ae-split-picker"
                >
                  <option value="">New session</option>
                  {pane !== null && !byId.has(pane) && <option value={pane}>{pane}</option>}
                  {conversations.map((c) => (
                    <option
                      key={c.id}
                      value={c.id}
                      disabled={c.id !== pane && layout.panes.includes(c.id)}
                    >
                      {c.title?.trim() || c.id}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Open this session alone"
                  title="Open this session alone"
                  onClick={() => navigate(paneSrc(pane))}
                  data-testid="ae-split-maximize"
                >
                  <Maximize2Icon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Close pane"
                  title={
                    layout.panes.length <= 1
                      ? "The last pane stays; use Single view to leave the split view"
                      : "Close pane (the session keeps running)"
                  }
                  disabled={layout.panes.length <= 1}
                  onClick={() => closePane(i)}
                  data-testid="ae-split-close"
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
              {/* No sandbox: the pane is this app on this origin, so it needs
                  scripts and same-origin together, which a sandbox cannot
                  constrain anyway (the lint rule's own reason). */}
              {/* oxlint-disable-next-line react/iframe-missing-sandbox */}
              <iframe
                ref={(el) => {
                  if (el) frameRefs.current.set(key, el);
                  else frameRefs.current.delete(key);
                }}
                name={`${AE_SPLIT_PANE_NAME_PREFIX}-${key}`}
                title={label}
                src={paneSrc(pane)}
                allow="clipboard-read; clipboard-write; microphone"
                // While a divider is dragged or a pane is moved the frames
                // would swallow the pointer; let the page keep it.
                className={`min-h-0 w-full flex-1 border-0 ${frozen ? "pointer-events-none" : ""}`}
                data-testid="ae-split-frame"
              />
            </section>
          );
        })}
        {colDividers.map(({ id, column: c, x }) => (
          <div
            key={id}
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize columns ${c + 1} and ${c + 2}`}
            aria-valuenow={Math.round((layout.cols[c] ?? 0) * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            tabIndex={0}
            className="absolute top-0 bottom-0 cursor-col-resize bg-border/60 outline-none hover:bg-primary/40 focus-visible:bg-primary/60"
            style={{ left: at(x, -HALF_GAP), width: GAP_PX }}
            onPointerDown={(e) => startDrag("x", (prev, d) => resizeColumn(prev, c, d), e)}
            onKeyDown={(e) => nudge("x", (prev, d) => resizeColumn(prev, c, d), e)}
            data-testid="ae-split-divider"
            data-axis="x"
          />
        ))}
        {rowDividers.map(({ id, rect }) => {
          const c = rect.column;
          const r = rect.row;
          const left = c === 0 ? 0 : HALF_GAP;
          const right = c === shape.length - 1 ? 0 : HALF_GAP;
          return (
            <div
              key={id}
              role="separator"
              aria-orientation="horizontal"
              aria-label={
                shape.length > 1
                  ? `Resize the stacked panes in column ${c + 1}`
                  : "Resize the stacked panes"
              }
              aria-valuenow={Math.round((layout.rows[c]?.[r] ?? 0) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              tabIndex={0}
              className="absolute cursor-row-resize bg-border/60 outline-none hover:bg-primary/40 focus-visible:bg-primary/60"
              style={{
                left: at(rect.x, left),
                width: at(rect.w, -(left + right)),
                top: at(rect.y + rect.h, -HALF_GAP),
                height: GAP_PX,
              }}
              onPointerDown={(e) => startDrag("y", (prev, d) => resizeRow(prev, c, r, d), e)}
              onKeyDown={(e) => nudge("y", (prev, d) => resizeRow(prev, c, r, d), e)}
              data-testid="ae-split-divider"
              data-axis="y"
            />
          );
        })}
      </div>
    </div>
  );
}

function sameTitles(a: Record<number, string>, b: Record<number, string>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[Number(k)] === b[Number(k)]);
}
