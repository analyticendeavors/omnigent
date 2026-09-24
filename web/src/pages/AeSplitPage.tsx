// The split view (omnigent-ae patch P5, 2026-09-24): two to four sessions side
// by side in one window, like the Claude desktop app's multi-panel layout.
// `/split?s=a,b` renders one pane per session in a resizable row; each pane is
// a frame of the ordinary `/c/:id` route (see `lib/aeSplitLayout.ts` for why a
// frame), with a strip carrying its title, a session switcher, "open alone"
// and close. The layout is remembered in local storage; with no `s` parameter
// the remembered one opens. Desktop only: below 1024px the route falls back to
// the first pane's session on its own.

import { Columns2Icon, Maximize2Icon, PlusIcon, SquareIcon, XIcon } from "lucide-react";
import {
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
  type AeSplitLayout,
  type AeSplitPane,
  addEmptyPane,
  equalSizes,
  formatSplitParam,
  isAeSplitPane,
  normalizeSizes,
  paneSessionFromPath,
  paneSrc,
  parseSplitParam,
  readStoredLayout,
  removePane,
  resizeAt,
  writeStoredLayout,
} from "@/lib/aeSplitLayout";
import { useNavigate, useSearchParams } from "@/lib/routing";

/** How often the page reads each frame's location and title (a frame's SPA navigation fires no event). */
export const AE_SPLIT_FRAME_POLL_MS = 1000;

/** One arrow-key press on a divider moves it by this fraction of the row. */
const KEYBOARD_STEP = 0.02;

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

/** The layout the page opens with: the URL's panes, else the remembered ones, else one empty pane. */
export function initialLayout(param: string | null, stored: AeSplitLayout | null): AeSplitLayout {
  const fromUrl = parseSplitParam(param);
  if (fromUrl) {
    const keep = stored && stored.panes.length === fromUrl.length ? stored.sizes : undefined;
    return { panes: fromUrl, sizes: normalizeSizes(keep, fromUrl.length) };
  }
  if (stored) return stored;
  return { panes: [null], sizes: [1] };
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

export function AeSplitPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const desktop = useIsSplitViewport();
  const param = searchParams.get("s");
  const [layout, setLayout] = useState<AeSplitLayout>(() =>
    initialLayout(param, readStoredLayout()),
  );
  const [frameTitles, setFrameTitles] = useState<Record<number, string>>({});
  const [dragging, setDragging] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const frameRefs = useRef<(HTMLIFrameElement | null)[]>([]);
  // Frames are keyed by a per-pane serial, not by index or session: closing a
  // pane must not reload its neighbours, and a pane that navigates inside its
  // own frame must not be remounted by the layout catching up with it.
  const serial = useRef(0);
  const [keys, setKeys] = useState<number[]>(() => layout.panes.map(() => serial.current++));

  const { data } = useConversations("", false, { enabled: desktop });
  const conversations = useMemo(() => data?.pages.flatMap((p) => p.data) ?? [], [data]);
  const byId = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations]);

  // Remember the layout and keep the URL on it, so a reload or a copied link
  // lands on the same panes.
  useEffect(() => {
    writeStoredLayout(layout);
    const next = formatSplitParam(layout.panes);
    if (next !== param) navigate(`/split?s=${next}`, { replace: true });
  }, [layout, navigate, param]);

  useEffect(() => {
    document.title = `Split view (${layout.panes.length})`;
  }, [layout.panes.length]);

  // Follow each frame: when the user opens another session (or creates one)
  // inside a pane, the pane now holds that session.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const titles: Record<number, string> = {};
      const seen: (AeSplitPane | undefined)[] = [];
      frameRefs.current.forEach((frame, i) => {
        try {
          const win = frame?.contentWindow;
          if (!win) return;
          seen[i] = paneSessionFromPath(win.location.pathname);
          const title = win.document.title;
          if (title) titles[i] = title;
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
  }, []);

  const setPaneSession = useCallback((index: number, session: AeSplitPane) => {
    setLayout((prev) => {
      if (session !== null && prev.panes.some((p, i) => p === session && i !== index)) return prev;
      const panes = [...prev.panes];
      panes[index] = session;
      return { ...prev, panes };
    });
    // A picked session is a new document in that frame.
    setKeys((prev) => prev.map((k, i) => (i === index ? serial.current++ : k)));
  }, []);

  const closePane = useCallback((index: number) => {
    setLayout((prev) => removePane(prev, index));
    setKeys((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addPane = useCallback(() => {
    setLayout((prev) => addEmptyPane(prev));
    setKeys((prev) => (prev.length >= AE_SPLIT_MAX_PANES ? prev : [...prev, serial.current++]));
  }, []);

  const startDrag = useCallback((index: number, event: ReactPointerEvent<HTMLDivElement>) => {
    const row = rowRef.current;
    if (!row) return;
    event.preventDefault();
    const width = row.getBoundingClientRect().width || 1;
    let lastX = event.clientX;
    setDragging(true);
    const onMove = (e: PointerEvent) => {
      const delta = (e.clientX - lastX) / width;
      lastX = e.clientX;
      setLayout((prev) => ({ ...prev, sizes: resizeAt(prev.sizes, index, delta) }));
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const nudge = useCallback((index: number, event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowLeft" ? -KEYBOARD_STEP : event.key === "ArrowRight" ? KEYBOARD_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    setLayout((prev) => ({ ...prev, sizes: resizeAt(prev.sizes, index, step) }));
  }, []);

  // A split page inside a pane would nest frames without end; show the session instead.
  if (isAeSplitPane()) return <Navigate to={paneSrc(layout.panes[0] ?? null)} replace />;
  if (!desktop)
    return <Navigate to={paneSrc(layout.panes.find((p) => p !== null) ?? null)} replace />;

  const first = layout.panes.find((p) => p !== null) ?? null;

  return (
    <div className="flex h-dvh flex-col bg-sidebar text-foreground" data-testid="ae-split-page">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <Columns2Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-sm font-medium">Split view</h1>
        <span className="text-xs text-muted-foreground" data-testid="ae-split-count">
          {layout.panes.length} of {AE_SPLIT_MAX_PANES} panes
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLayout((prev) => ({ ...prev, sizes: equalSizes(prev.panes.length) }))}
            data-testid="ae-split-equalize"
          >
            Equal widths
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={addPane}
            disabled={layout.panes.length >= AE_SPLIT_MAX_PANES}
            title={
              layout.panes.length >= AE_SPLIT_MAX_PANES
                ? `A split view holds at most ${AE_SPLIT_MAX_PANES} panes; close one first`
                : "Add a pane with a new session"
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
      <div ref={rowRef} className="flex min-h-0 flex-1" data-testid="ae-split-row">
        {layout.panes.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <p>Every pane is closed.</p>
            <Button variant="outline" size="sm" onClick={addPane}>
              <PlusIcon className="size-3.5" />
              Add pane
            </Button>
          </div>
        )}
        {layout.panes.map((pane, i) => (
          <div key={keys[i]} className="contents">
            {i > 0 && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize panes ${i} and ${i + 1}`}
                aria-valuenow={Math.round((layout.sizes[i - 1] ?? 0) * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                tabIndex={0}
                className="w-1.5 shrink-0 cursor-col-resize bg-border/60 outline-none hover:bg-primary/40 focus-visible:bg-primary/60"
                onPointerDown={(e) => startDrag(i - 1, e)}
                onKeyDown={(e) => nudge(i - 1, e)}
                data-testid="ae-split-divider"
              />
            )}
            <section
              className="flex min-w-0 flex-col bg-background"
              style={{ flexBasis: 0, flexGrow: layout.sizes[i] ?? 1 }}
              aria-label={sessionLabel(pane, frameTitles[i], byId)}
              data-testid="ae-split-pane"
              data-session={pane ?? ""}
            >
              <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
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
                  title="Close pane (the session keeps running)"
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
                  frameRefs.current[i] = el;
                }}
                name={`${AE_SPLIT_PANE_NAME_PREFIX}-${keys[i]}`}
                title={sessionLabel(pane, frameTitles[i], byId)}
                src={paneSrc(pane)}
                allow="clipboard-read; clipboard-write; microphone"
                // While a divider is dragged the frames would swallow the
                // pointer; let the page keep it.
                className={`min-h-0 w-full flex-1 border-0 ${dragging ? "pointer-events-none" : ""}`}
                data-testid="ae-split-frame"
              />
            </section>
          </div>
        ))}
      </div>
    </div>
  );
}

function sameTitles(a: Record<number, string>, b: Record<number, string>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[Number(k)] === b[Number(k)]);
}
