// Layout state for the split view (omnigent-ae patches P5 and P9): which
// sessions sit in which pane, which preset arranges them (P9, 2026-09-24: side
// by side, stacked, 2+1 and its mirror, a 2x2 grid), how big each column and
// stacked pane is, and how that round-trips through the URL
// (`/split?s=a,b&l=rows2`) and local storage. Pure helpers, no React, so the page, the
// sidebar menu item and the shell's pane check share one definition.
//
// Each pane is an iframe of the ordinary `/c/:id` route. The chat store is a
// module-scope singleton with one foreground conversation, so ChatPage cannot
// render twice in one React tree; a frame gives every pane its own store,
// streams and keyboard focus without touching upstream's store.

/** At most this many panes; the Claude desktop app's multi-panel layout tops out at four. */
export const AE_SPLIT_MAX_PANES = 4;

/** Below this viewport width the split route falls back to a single session. */
export const AE_SPLIT_MIN_VIEWPORT_PX = 1024;

/** No pane may be narrower than this fraction of the row while resizing. */
export const AE_SPLIT_MIN_FRACTION = 0.15;

/** Local storage key for the remembered layout. */
export const AE_SPLIT_STORAGE_KEY = "ae.splitView.v1";

/** Every pane frame's window name starts with this, so the shell can tell it is one. */
export const AE_SPLIT_PANE_NAME_PREFIX = "ae-split-pane";

/** The URL token for a pane with no session yet (it shows the new-session page). */
const NEW_PANE_TOKEN = "new";

/** One pane: a session id, or `null` for a pane still on the new-session page. */
export type AeSplitPane = string | null;

/**
 * The arrangements the picker offers (2026-09-24, after the Claude Code desktop
 * app's layouts), plus `one` for a lone pane. A preset is a list of columns,
 * each holding one or two panes stacked; panes fill the slots column by column,
 * top to bottom.
 */
export type AeSplitPresetId =
  "one" | "cols2" | "rows2" | "stack-left" | "stack-right" | "grid" | "cols3" | "cols4";

export interface AeSplitPreset {
  id: AeSplitPresetId;
  /** The picker's tooltip and accessible name. */
  label: string;
  /** Panes per column, left to right. */
  shape: readonly number[];
}

/** Every preset in the order the picker shows them; `one` is not offered there. */
export const AE_SPLIT_PRESETS: readonly AeSplitPreset[] = [
  { id: "cols2", label: "2 side by side", shape: [1, 1] },
  { id: "rows2", label: "2 stacked", shape: [2] },
  { id: "stack-left", label: "2 stacked, 1 beside them", shape: [2, 1] },
  { id: "stack-right", label: "1, then 2 stacked beside it", shape: [1, 2] },
  { id: "grid", label: "2 by 2 grid", shape: [2, 2] },
  { id: "cols3", label: "3 side by side", shape: [1, 1, 1] },
  { id: "cols4", label: "4 side by side", shape: [1, 1, 1, 1] },
];

const ONE: AeSplitPreset = { id: "one", label: "1 pane", shape: [1] };

/** The preset for *id*; unknown ids are `undefined`. */
export function presetById(id: unknown): AeSplitPreset | undefined {
  if (id === ONE.id) return ONE;
  return AE_SPLIT_PRESETS.find((p) => p.id === id);
}

/** How many panes *preset* holds. */
export function slotCount(preset: AeSplitPresetId): number {
  return (presetById(preset) ?? ONE).shape.reduce((a, b) => a + b, 0);
}

/** The preset whose shape is *shape*, if any. */
function presetForShape(shape: readonly number[]): AeSplitPreset | undefined {
  const key = shape.join(",");
  if (key === ONE.shape.join(",")) return ONE;
  return AE_SPLIT_PRESETS.find((p) => p.shape.join(",") === key);
}

/**
 * The preset a pane count opens with when nothing says otherwise: side by
 * side, which is what the split view did before presets. The URL leaves out a
 * layout that is this default, so a link from before presets means the same.
 */
export function defaultPreset(count: number): AeSplitPresetId {
  if (count <= 1) return "one";
  if (count === 2) return "cols2";
  if (count === 3) return "cols3";
  return "cols4";
}

/**
 * Where a new pane goes when a pane is added past *preset*'s slots: the next
 * preset that fits, keeping the arrangement's character (stacked stays
 * stacked, side by side stays side by side), and the column that gains the
 * slot. `null` at four panes.
 */
const GROW: Record<AeSplitPresetId, { to: AeSplitPresetId; column: number } | null> = {
  one: { to: "cols2", column: 1 },
  cols2: { to: "cols3", column: 2 },
  rows2: { to: "stack-left", column: 1 },
  "stack-left": { to: "grid", column: 1 },
  "stack-right": { to: "grid", column: 0 },
  cols3: { to: "cols4", column: 3 },
  grid: null,
  cols4: null,
};

/** The preset adding a pane to *preset* switches to, or `null` when it is full. */
export function nextPreset(preset: AeSplitPresetId): AeSplitPresetId | null {
  return GROW[preset]?.to ?? null;
}

export interface AeSplitLayout {
  preset: AeSplitPresetId;
  /** Sessions in slot order: column by column, top to bottom. As many as the preset has slots. */
  panes: AeSplitPane[];
  /** Column widths, fractions of the row summing to 1. */
  cols: number[];
  /** Per column, the heights of its panes, fractions of the column summing to 1. */
  rows: number[][];
}

/** Equal fractions for *count* parts. */
export function equalSizes(count: number): number[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, () => 1 / count);
}

/**
 * Coerce *sizes* to *count* positive fractions summing to 1; anything that
 * does not fit (wrong length, a zero, NaN) becomes equal parts.
 */
export function normalizeSizes(sizes: readonly unknown[] | undefined, count: number): number[] {
  if (!Array.isArray(sizes) || sizes.length !== count || count === 0) return equalSizes(count);
  if (sizes.some((s) => typeof s !== "number" || !Number.isFinite(s) || s <= 0)) {
    return equalSizes(count);
  }
  const nums = sizes as number[];
  const total = nums.reduce((a, b) => a + b, 0);
  return nums.map((s) => s / total);
}

/** Equal columns and rows for *preset*. */
export function equalGrid(preset: AeSplitPresetId): Pick<AeSplitLayout, "cols" | "rows"> {
  const shape = (presetById(preset) ?? ONE).shape;
  return { cols: equalSizes(shape.length), rows: shape.map((n) => equalSizes(n)) };
}

/** A layout of *panes* in *preset* (the default for their count when omitted), equal sizes. */
export function makeLayout(panes: AeSplitPane[], preset?: AeSplitPresetId): AeSplitLayout {
  const id = preset && slotCount(preset) === panes.length ? preset : defaultPreset(panes.length);
  return { preset: id, panes, ...equalGrid(id) };
}

/** *cols* and *rows* coerced to fit *preset*; what does not fit becomes equal. */
function fitGrid(
  preset: AeSplitPresetId,
  cols: readonly unknown[] | undefined,
  rows: readonly unknown[] | undefined,
): Pick<AeSplitLayout, "cols" | "rows"> {
  const shape = (presetById(preset) ?? ONE).shape;
  return {
    cols: normalizeSizes(cols, shape.length),
    rows: shape.map((n, c) => normalizeSizes(Array.isArray(rows) ? rows[c] : undefined, n)),
  };
}

/** *layout* with its sizes coerced to fit its preset (what does not fit becomes equal). */
export function fitLayout(layout: AeSplitLayout): AeSplitLayout {
  return { ...layout, ...fitGrid(layout.preset, layout.cols, layout.rows) };
}

/** Where each slot sits, as fractions of the page's pane area. */
export interface AeSplitRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The slot's column and its row within that column. */
  column: number;
  row: number;
}

/** One rectangle per slot of *layout*, in slot order. */
export function slotRects(layout: AeSplitLayout): AeSplitRect[] {
  const shape = (presetById(layout.preset) ?? ONE).shape;
  const out: AeSplitRect[] = [];
  let x = 0;
  shape.forEach((n, c) => {
    const w = layout.cols[c] ?? 0;
    let y = 0;
    for (let r = 0; r < n; r++) {
      const h = layout.rows[c]?.[r] ?? 0;
      out.push({ x, y, w, h, column: c, row: r });
      y += h;
    }
    x += w;
  });
  return out;
}

/** The slot index of *column*'s first pane. */
export function columnStart(preset: AeSplitPresetId, column: number): number {
  const shape = (presetById(preset) ?? ONE).shape;
  return shape.slice(0, column).reduce((a, b) => a + b, 0);
}

/**
 * Drop duplicate sessions and cap at the maximum. Empty panes are kept (each
 * is its own new-session page), duplicates of a session are not: two frames on
 * one session would race each other's composer.
 */
export function cleanPanes(panes: readonly AeSplitPane[]): AeSplitPane[] {
  const seen = new Set<string>();
  const out: AeSplitPane[] = [];
  for (const pane of panes) {
    if (pane !== null) {
      if (seen.has(pane)) continue;
      seen.add(pane);
    }
    out.push(pane);
    if (out.length === AE_SPLIT_MAX_PANES) break;
  }
  return out;
}

/** `?s=a,new,b` to panes; `null` when the parameter is absent or empty. */
export function parseSplitParam(value: string | null): AeSplitPane[] | null {
  if (value === null) return null;
  const tokens = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (tokens.length === 0) return null;
  return cleanPanes(tokens.map((t) => (t === NEW_PANE_TOKEN ? null : t)));
}

/** Panes to the `s` parameter's value. */
export function formatSplitParam(panes: readonly AeSplitPane[]): string {
  return panes.map((p) => p ?? NEW_PANE_TOKEN).join(",");
}

/**
 * The `l` parameter's value for *preset* with *count* panes: the preset id,
 * or `null` when it is the default for that count (the URL then has no `l`).
 */
export function formatLayoutParam(preset: AeSplitPresetId, count: number): string | null {
  return preset === defaultPreset(count) ? null : preset;
}

/** The `l` parameter back to a preset, when it names one that holds *count* panes. */
export function parseLayoutParam(value: string | null, count: number): AeSplitPresetId | null {
  const preset = presetById(value);
  return preset && slotCount(preset.id) === count ? preset.id : null;
}

/** The split route for *panes* in *preset*, e.g. `/split?s=a,b` or `/split?s=a,b&l=rows2`. */
export function splitHref(panes: readonly AeSplitPane[], preset?: AeSplitPresetId): string {
  const l = preset ? formatLayoutParam(preset, panes.length) : null;
  return `/split?s=${formatSplitParam(panes)}${l ? `&l=${l}` : ""}`;
}

/** The session a pane frame is showing, from its pathname; `undefined` for any non-chat page. */
export function paneSessionFromPath(pathname: string): AeSplitPane | undefined {
  if (pathname === "/" || pathname === "") return null;
  const match = /\/c\/([^/?#]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

/** The URL a pane frame loads. */
export function paneSrc(pane: AeSplitPane): string {
  return pane === null ? "/" : `/c/${encodeURIComponent(pane)}`;
}

/**
 * A stored value to a layout. Version 2 (2026-09-24, layout presets) is
 * `{v: 2, preset, panes, cols, rows}`. Version 1, from before presets, is
 * `{panes, sizes}` with one width per pane in a row; it reads as the side by
 * side preset for its pane count with those widths, so a remembered layout
 * survives the upgrade. Anything else is `null`.
 */
export function migrateStoredLayout(parsed: unknown): AeSplitLayout | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (!Array.isArray(value.panes)) return null;
  const panes = cleanPanes(
    value.panes.filter((p): p is AeSplitPane => p === null || typeof p === "string"),
  );
  if (panes.length === 0) return null;
  if (value.v === 2) {
    const stored = presetById(value.preset);
    const preset =
      stored && slotCount(stored.id) === panes.length ? stored.id : defaultPreset(panes.length);
    const cols = Array.isArray(value.cols) ? value.cols : undefined;
    const rows = Array.isArray(value.rows) ? value.rows : undefined;
    return { preset, panes, ...fitGrid(preset, cols, rows) };
  }
  // Version 1: a row of panes, one width each.
  const preset = defaultPreset(panes.length);
  const sizes = Array.isArray(value.sizes) ? value.sizes : undefined;
  return { preset, panes, ...fitGrid(preset, sizes, undefined) };
}

/** The remembered layout, or `null` when there is none or storage is unreadable. */
export function readStoredLayout(
  storage: Storage | undefined = safeStorage(),
): AeSplitLayout | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(AE_SPLIT_STORAGE_KEY);
    if (!raw) return null;
    return migrateStoredLayout(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Remember *layout* (always as version 2, under the key version 1 used, so the
 * upgrade needs no second key); a full or blocked storage is not an error
 * worth surfacing.
 */
export function writeStoredLayout(
  layout: AeSplitLayout,
  storage: Storage | undefined = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(AE_SPLIT_STORAGE_KEY, JSON.stringify({ v: 2, ...layout }));
  } catch {
    // Quota or privacy mode: the URL still carries the panes.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * *layout* in *preset*. Sessions keep their slots in order; extra slots open on
 * the new-session page; with fewer slots, empty panes go first, then the last
 * sessions (their sessions keep running). Sizes become equal.
 */
export function applyPreset(layout: AeSplitLayout, preset: AeSplitPresetId): AeSplitLayout {
  const want = slotCount(preset);
  const panes = keptSlots(layout.panes, want).map((i): AeSplitPane => layout.panes[i] ?? null);
  while (panes.length < want) panes.push(null);
  return { preset, panes, ...equalGrid(preset) };
}

/**
 * Which of *panes* survive a preset with *want* slots, as their indices in
 * order: all of them when they fit, else empty panes are dropped last first,
 * then the last sessions. The page keeps its frame keys with the same list.
 */
export function keptSlots(panes: readonly AeSplitPane[], want: number): number[] {
  const kept = panes.map((_, i) => i);
  while (kept.length > want) {
    let drop = -1;
    for (let k = kept.length - 1; k >= 0; k--) {
      if (panes[kept[k]!] === null) {
        drop = k;
        break;
      }
    }
    kept.splice(drop === -1 ? kept.length - 1 : drop, 1);
  }
  return kept;
}

/**
 * Add *pane* past the current preset's slots: the layout switches to the next
 * preset that fits (see `nextPreset`) and the pane goes to the slot that preset
 * adds, so the panes already open stay where they are on screen. A no-op at
 * the maximum. Sizes become equal.
 */
export function addPane(layout: AeSplitLayout, pane: AeSplitPane = null): AeSplitLayout {
  const at = addedSlot(layout);
  const to = GROW[layout.preset]?.to;
  if (at < 0 || !to) return layout;
  const panes = [...layout.panes];
  panes.splice(at, 0, pane);
  return { preset: to, panes, ...equalGrid(to) };
}

/** The slot index *addPane* puts a new pane at, or -1 when the layout is full. */
export function addedSlot(layout: AeSplitLayout): number {
  const grow = GROW[layout.preset];
  if (!grow || layout.panes.length >= AE_SPLIT_MAX_PANES) return -1;
  const shape = (presetById(grow.to) ?? ONE).shape;
  return columnStart(grow.to, grow.column) + shape[grow.column]! - 1;
}

/** Append an empty pane (the new-session page); kept for P5's callers. */
export function addEmptyPane(layout: AeSplitLayout): AeSplitLayout {
  return addPane(layout, null);
}

/**
 * Remove pane *index*. Its column loses a slot (or goes, when that was its
 * only pane) and the layout becomes the preset of the shape that is left: a
 * grid minus one is a 2+1, a 2+1 minus its lone pane is 2 stacked. Survivors
 * keep their proportions. The last pane is never removed.
 */
export function removePane(layout: AeSplitLayout, index: number): AeSplitLayout {
  if (layout.panes.length <= 1 || index < 0 || index >= layout.panes.length) return layout;
  const rect = slotRects(layout)[index];
  if (!rect) return layout;
  const shape = [...(presetById(layout.preset) ?? ONE).shape];
  let cols = [...layout.cols];
  let rows = layout.rows.map((r) => [...r]);
  shape[rect.column]! -= 1;
  if (shape[rect.column] === 0) {
    shape.splice(rect.column, 1);
    cols.splice(rect.column, 1);
    rows.splice(rect.column, 1);
  } else {
    rows[rect.column]!.splice(rect.row, 1);
  }
  const preset = presetForShape(shape)?.id ?? defaultPreset(layout.panes.length - 1);
  cols = normalizeSizes(cols, cols.length);
  rows = rows.map((r) => normalizeSizes(r, r.length));
  return {
    preset,
    panes: layout.panes.filter((_, i) => i !== index),
    ...fitGrid(preset, cols, rows),
  };
}

/** Swap the sessions in slots *a* and *b*; the slots keep their sizes. */
export function swapPanes(layout: AeSplitLayout, a: number, b: number): AeSplitLayout {
  const n = layout.panes.length;
  if (a === b || a < 0 || b < 0 || a >= n || b >= n) return layout;
  const panes = [...layout.panes];
  [panes[a], panes[b]] = [panes[b]!, panes[a]!];
  return { ...layout, panes };
}

/**
 * The layout to open when the user picks "Open in split view" on *sessionId*:
 * the remembered panes (or, with none, the session being viewed), plus the
 * chosen one, which grows the preset as "Add pane" does. Already present, it
 * stays where it is; at the maximum, it replaces the last pane.
 */
export function layoutWithSession(
  stored: AeSplitLayout | null,
  sessionId: string,
  currentSessionId: string | null,
): AeSplitLayout {
  const layout: AeSplitLayout | null = stored?.panes.length
    ? stored
    : currentSessionId
      ? makeLayout([currentSessionId])
      : null;
  if (!layout) return makeLayout([sessionId]);
  if (layout.panes.includes(sessionId)) return layout;
  if (layout.panes.length >= AE_SPLIT_MAX_PANES) {
    const panes = [...layout.panes];
    panes[panes.length - 1] = sessionId;
    return { ...layout, panes: cleanPanes(panes) };
  }
  return addPane(layout, sessionId);
}

/**
 * Move the divider after part *index* of *sizes* by *delta* (a fraction of
 * the row or column), clamped so neither neighbour shrinks below *min*. The
 * other parts keep their size. Used for both axes: column widths and the
 * heights of the panes stacked in one column.
 */
export function resizeAt(
  sizes: readonly number[],
  index: number,
  delta: number,
  min: number = AE_SPLIT_MIN_FRACTION,
): number[] {
  const left = sizes[index];
  const right = sizes[index + 1];
  if (left === undefined || right === undefined) return [...sizes];
  const pair = left + right;
  const nextLeft = Math.min(Math.max(left + delta, min), pair - min);
  const out = [...sizes];
  out[index] = nextLeft;
  out[index + 1] = pair - nextLeft;
  return out;
}

/** Move the divider after column *index* by *delta* of the row's width. */
export function resizeColumn(layout: AeSplitLayout, index: number, delta: number): AeSplitLayout {
  return { ...layout, cols: resizeAt(layout.cols, index, delta) };
}

/** Move the divider after row *index* of *column* by *delta* of the column's height. */
export function resizeRow(
  layout: AeSplitLayout,
  column: number,
  index: number,
  delta: number,
): AeSplitLayout {
  const rows = layout.rows.map((r, c) => (c === column ? resizeAt(r, index, delta) : r));
  return { ...layout, rows };
}

/**
 * True inside a split-view pane frame. The frame's window name survives
 * navigation inside it, so this stays true after the pane moves to another
 * session. The shell reads it to start with its sidebar closed.
 */
export function isAeSplitPane(win: Window | undefined = globalThis.window): boolean {
  if (!win) return false;
  try {
    return win.parent !== win && win.name.startsWith(AE_SPLIT_PANE_NAME_PREFIX);
  } catch {
    return false;
  }
}
