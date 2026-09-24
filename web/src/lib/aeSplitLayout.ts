// Layout state for the split view (omnigent-ae patch P5): which sessions sit in
// which pane, how wide each pane is, and how that round-trips through the URL
// (`/split?s=a,b`) and local storage. Pure helpers, no React, so the page, the
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

export interface AeSplitLayout {
  panes: AeSplitPane[];
  /** Fractions of the row, one per pane, summing to 1. */
  sizes: number[];
}

/** Equal widths for *count* panes. */
export function equalSizes(count: number): number[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, () => 1 / count);
}

/**
 * Coerce *sizes* to *count* positive fractions summing to 1; anything that
 * does not fit (wrong length, a zero, NaN) becomes equal widths.
 */
export function normalizeSizes(sizes: readonly number[] | undefined, count: number): number[] {
  if (!sizes || sizes.length !== count || count === 0) return equalSizes(count);
  if (sizes.some((s) => !Number.isFinite(s) || s <= 0)) return equalSizes(count);
  const total = sizes.reduce((a, b) => a + b, 0);
  return sizes.map((s) => s / total);
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

/** The split route for *panes*, e.g. `/split?s=conv_a,conv_b`. */
export function splitHref(panes: readonly AeSplitPane[]): string {
  return `/split?s=${formatSplitParam(panes)}`;
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

/** The remembered layout, or `null` when there is none or storage is unreadable. */
export function readStoredLayout(
  storage: Storage | undefined = safeStorage(),
): AeSplitLayout | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(AE_SPLIT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AeSplitLayout>;
    if (!Array.isArray(parsed.panes)) return null;
    const panes = cleanPanes(
      parsed.panes.filter((p): p is AeSplitPane => p === null || typeof p === "string"),
    );
    if (panes.length === 0) return null;
    return { panes, sizes: normalizeSizes(parsed.sizes, panes.length) };
  } catch {
    return null;
  }
}

/** Remember *layout*; a full or blocked storage is not an error worth surfacing. */
export function writeStoredLayout(
  layout: AeSplitLayout,
  storage: Storage | undefined = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(AE_SPLIT_STORAGE_KEY, JSON.stringify(layout));
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
 * The layout to open when the user picks "Open in split view" on *sessionId*:
 * the remembered panes (or, with none, the session being viewed), plus the
 * chosen one. Already present, it stays where it is; at the maximum, it
 * replaces the last pane.
 */
export function layoutWithSession(
  stored: AeSplitLayout | null,
  sessionId: string,
  currentSessionId: string | null,
): AeSplitLayout {
  let panes: AeSplitPane[] = stored?.panes.length
    ? [...stored.panes]
    : currentSessionId
      ? [currentSessionId]
      : [];
  if (!panes.includes(sessionId)) {
    if (panes.length >= AE_SPLIT_MAX_PANES) panes = panes.slice(0, AE_SPLIT_MAX_PANES - 1);
    panes.push(sessionId);
  }
  panes = cleanPanes(panes);
  const keepSizes = stored !== null && stored.panes.length === panes.length;
  return { panes, sizes: normalizeSizes(keepSizes ? stored.sizes : undefined, panes.length) };
}

/**
 * Move the divider after pane *index* by *delta* (a fraction of the row),
 * clamped so neither neighbour shrinks below *min*. Other panes keep their width.
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

/** Remove pane *index*; its width goes to the survivors in proportion. */
export function removePane(layout: AeSplitLayout, index: number): AeSplitLayout {
  const panes = layout.panes.filter((_, i) => i !== index);
  const sizes = normalizeSizes(
    layout.sizes.filter((_, i) => i !== index),
    panes.length,
  );
  return { panes, sizes };
}

/** Append an empty pane (the new-session page), equal widths; a no-op at the maximum. */
export function addEmptyPane(layout: AeSplitLayout): AeSplitLayout {
  if (layout.panes.length >= AE_SPLIT_MAX_PANES) return layout;
  const panes = [...layout.panes, null];
  return { panes, sizes: equalSizes(panes.length) };
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
