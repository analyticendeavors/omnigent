// Token defrag (omnigent-ae, 2026-10-18): the composer tray's compaction strip,
// its hidden Win98 window, the Settings switch, and the marker's token counts.
// The motion models live in lib/aeTokenDefrag; this file only draws them.

import {
  type RefObject,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as PopoverPrimitive from "radix-ui/popover";
import { categoryColor } from "@/components/aeContextUsage";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { Switch } from "@/components/ui/switch";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";
import {
  AE_DEFRAG_FIXED,
  AE_DEFRAG_MAP_COLUMNS,
  AE_DEFRAG_MAP_ROWS,
  AE_DEFRAG_MESSAGES,
  AE_DEFRAG_STALE_MS,
  type AeCompactionCounts,
  type AeDefragMap,
  type AeDefragPill,
  type AeDefragStrip,
  aeCompactionPhase,
  aeCompactionTotalsFor,
  aeCompactionTotalsVersion,
  aeCreateDefragMap,
  aeCreateDefragStrip,
  aeDefragEstimate,
  aeDefragShown,
  aeDefragStripDrained,
  aeDefragStripResting,
  aeHoldContextRing,
  aeLiveMarkerStamps,
  aeNotedCompactionTotals,
  aePulseContextRing,
  aeStepDefragStrip,
  aeTickDefragMap,
  parseAeCompactionPhase,
  subscribeAeCompactionTotals,
  useAeCompactionCounts,
  useAeTokenDefragEnabled,
  writeAeTokenDefrag,
} from "@/lib/aeTokenDefrag";
import { formatTokenCount } from "@/lib/formatCost";
import { getEmbedRoot } from "@/lib/host";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";
import "./AeTokenDefrag.css";

const CHECK: AeTablerIconNode = [["path", { d: "M5 12l5 5l10 -10" }]];
const MINIMIZE: AeTablerIconNode = [["path", { d: "M6 19h12" }]];
const MAXIMIZE: AeTablerIconNode = [["path", { d: "M4 4h16v16h-16z" }]];
const CLOSE: AeTablerIconNode = [
  ["path", { d: "M18 6l-12 12" }],
  ["path", { d: "M6 6l12 12" }],
];
const MAP_TICK_MS = 1000 / 12;
const FAIL_HOLD_MS = 3500;
const LEGEND = [
  ["message", "Message tokens"],
  ["summary", "Summary"],
  ["reading", "Being read"],
  ["writing", "Being written"],
  ["free", "Free space"],
  ["unmovable", "Will not be moved"],
  ["buffer", "Autocompact buffer"],
] as const;

type Mode = "idle" | "running" | "finishing" | "pouring" | "failed";
type Notice = "complete" | "failed" | null;

/** A loading block gone with no finish or failure stops the strip after this long. */
const QUIET_STOP_MS = 8000;

interface Machine {
  mode: Mode;
  strip: AeDefragStrip;
  map: AeDefragMap;
  mapMs: number;
  /** The estimate's anchor: the server's start when this clock agrees with it. */
  startedAtMs: number;
  /** When this page started showing the run, for the stale cutoff. */
  shownAtMs: number;
  before: number | null;
  /** The stream's completed and failed counts when the run started. */
  counts: AeCompactionCounts;
  percent: number;
  /** True until a run's first frame paints its starting layout. */
  fresh: boolean;
  /** The phase of a run given up as stale, so it does not restart. */
  stalePhase: string | null;
}

function createMachine(): Machine {
  return {
    mode: "idle",
    strip: aeCreateDefragStrip(),
    map: aeCreateDefragMap(),
    mapMs: 0,
    startedAtMs: 0,
    shownAtMs: 0,
    before: null,
    counts: { completed: 0, failed: 0 },
    percent: 0,
    fresh: true,
    stalePhase: null,
  };
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * The tray strip while the active conversation compacts. Renders nothing when
 * the Settings switch is off or no compaction is running.
 */
export function AeTokenDefrag() {
  const enabled = useAeTokenDefragEnabled();
  // Switched off, the selector returns a constant and skips the blocks scan.
  const phase = useChatStore((s) => (enabled ? aeCompactionPhase(s.blocks) : "idle"));
  const tokensUsed = useChatStore((s) => s.tokensUsed);
  const conversationId = useChatStore((s) => s.conversationId);
  const counts = useAeCompactionCounts(conversationId);
  if (!enabled) return null;
  return (
    <DefragStrip
      phase={phase}
      tokensUsed={tokensUsed}
      conversationId={conversationId}
      counts={counts}
    />
  );
}

function DefragStrip({
  phase,
  tokensUsed,
  conversationId,
  counts,
}: {
  phase: string;
  tokensUsed: number | null;
  conversationId: string | null;
  counts: AeCompactionCounts;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // How the last run ended, kept while its window stays open.
  const [ended, setEnded] = useState<Notice>(null);
  const [landed, setLanded] = useState(false);
  const [percent, setPercent] = useState(0);
  // One mutable machine per strip: the frame loop reads and writes it without renders.
  const [m] = useState(createMachine);
  const phaseRef = useRef(phase);
  const openRef = useRef(open);
  const stripRef = useRef<HTMLSpanElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const pills = useRef(new Map<number, HTMLElement>());

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const go = (next: Mode) => {
      m.mode = next;
      setMode(next);
    };
    const current = parseAeCompactionPhase(phase);
    if (mode === "idle") {
      // A run given up as stale stays down until its phase changes.
      if (current.kind !== "running" || phase === m.stalePhase) return;
      const now = Date.now();
      const serverStart = current.startedAtS === null ? null : current.startedAtS * 1000;
      // A skewed clock puts the server's start in the future or far in the past.
      m.startedAtMs =
        serverStart !== null && serverStart <= now && now - serverStart < AE_DEFRAG_STALE_MS
          ? serverStart
          : now;
      m.shownAtMs = now;
      m.strip = aeCreateDefragStrip();
      m.map = aeCreateDefragMap();
      m.mapMs = 0;
      m.before = tokensUsed;
      m.counts = counts;
      m.percent = 0;
      m.fresh = true;
      // A strip kept mounted by an open window still holds the last run's pills.
      stripRef.current?.replaceChildren();
      pills.current.clear();
      setPercent(0);
      setNotice(null);
      setEnded(null);
      setLanded(false);
      setOpen(false);
      aeHoldContextRing(m.before);
      go("running");
      return;
    }
    if (mode !== "running") return;
    // The stream's own events end a run: a reconnect can swap the blocks for history.
    if (counts.completed !== m.counts.completed) go("finishing");
    else if (counts.failed !== m.counts.failed) go("failed");
    // Usage moved without a finish, so the turn went on: show the live count.
    else if (tokensUsed !== m.before) aeHoldContextRing(null);
  }, [phase, mode, counts, tokensUsed, m]);

  useEffect(() => {
    if (mode !== "running" || parseAeCompactionPhase(phase).kind === "running") return undefined;
    // The loading block went with no finish or failure (a reconnect reloaded the
    // transcript): stop quietly unless the server announces the compaction again.
    const timer = setTimeout(() => {
      aeHoldContextRing(null);
      m.mode = "idle";
      setMode("idle");
    }, QUIET_STOP_MS);
    return () => clearTimeout(timer);
  }, [mode, phase, m]);

  // Release the ring if the strip goes away mid-run (switched off or another conversation).
  useEffect(() => () => aeHoldContextRing(null), []);

  useEffect(() => {
    if (mode !== "running" && mode !== "finishing") return undefined;
    const instant = prefersReducedMotion();
    let last = performance.now();
    let frame = 0;
    let nap: ReturnType<typeof setTimeout> | undefined;
    const tick = (now: number) => {
      const dt = Math.min(50, now - last);
      last = now;
      const finishing = m.mode === "finishing";
      if (!finishing && Date.now() - m.shownAtMs > AE_DEFRAG_STALE_MS) {
        // No finish or failure after this long (a stuck stream): stop holding the ring.
        aeHoldContextRing(null);
        m.stalePhase = phaseRef.current;
        m.mode = "idle";
        setMode("idle");
        return;
      }
      const target = finishing
        ? AE_DEFRAG_MESSAGES
        : Math.floor(aeDefragEstimate(Date.now() - m.startedAtMs) * AE_DEFRAG_MESSAGES);
      const step = aeStepDefragStrip(m.strip, dt, target, finishing, instant);
      // A frame that launched or landed a pill still paints, so a melted pill never lingers.
      const quiet =
        !finishing &&
        step.launched.length === 0 &&
        step.landed.length === 0 &&
        m.strip.next >= target &&
        aeDefragStripResting(m.strip);
      if (!quiet || m.fresh) {
        paintStrip(stripRef.current, pills.current, m.strip, step.launched, step.landed);
        m.fresh = false;
      }
      const shown = aeDefragShown(m.strip);
      const nextPercent = Math.floor(shown * 100);
      if (nextPercent !== m.percent) {
        m.percent = nextPercent;
        setPercent(nextPercent);
      }
      m.mapMs += dt;
      if (m.mapMs >= (instant ? 1000 : MAP_TICK_MS)) {
        m.mapMs = 0;
        const changed = aeTickDefragMap(m.map, Math.floor(shown * m.map.messages.length));
        paintMap(mapRef.current, m.map, changed);
      }
      if (finishing && aeDefragStripDrained(m.strip)) {
        // Read the rest, then settle the last reads and writes before the final paint.
        aeTickDefragMap(m.map, m.map.messages.length);
        aeTickDefragMap(m.map, m.map.messages.length);
        paintMap(mapRef.current, m.map, null);
        m.percent = 100;
        setPercent(100);
        if (openRef.current) setNotice("complete");
        m.mode = "pouring";
        setMode("pouring");
        return;
      }
      // Nothing moves while the estimate waits for the next pill: check back four times a second.
      if (quiet) {
        nap = setTimeout(() => {
          frame = requestAnimationFrame(tick);
        }, 250);
      } else {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(nap);
    };
  }, [mode, m]);

  useEffect(() => {
    if (mode === "failed") {
      aeHoldContextRing(null);
      setEnded("failed");
      if (openRef.current) setNotice("failed");
      const timer = setTimeout(() => {
        m.mode = "idle";
        setMode("idle");
      }, FAIL_HOLD_MS);
      return () => clearTimeout(timer);
    }
    if (mode !== "pouring") return undefined;
    const instant = prefersReducedMotion();
    const strip = stripRef.current;
    const edge = strip?.clientWidth ?? 0;
    const pouring = [...m.strip.fixed, ...m.strip.summaries.filter(Boolean)]
      .map((pill) => pills.current.get(pill.id))
      .filter((el): el is HTMLElement => el !== undefined)
      .reverse();
    const timers: ReturnType<typeof setTimeout>[] = [];
    pouring.forEach((el, index) => {
      timers.push(
        setTimeout(
          () => {
            el.classList.add("ae-defrag-pour");
            el.style.transform = `translate(${edge}px, 0)`;
            el.style.width = "0px";
            el.style.opacity = "0";
          },
          instant ? 0 : index * 45,
        ),
      );
    });
    const landMs = instant ? 0 : pouring.length * 45 + 520;
    timers.push(
      setTimeout(() => {
        aeHoldContextRing(null);
        aePulseContextRing();
        setLanded(true);
        setEnded("complete");
      }, landMs),
    );
    timers.push(
      setTimeout(() => {
        m.mode = "idle";
        setMode("idle");
      }, landMs + 1400),
    );
    return () => timers.forEach(clearTimeout);
  }, [mode, m]);

  // An open window keeps the strip, so its completion or failure box waits for OK.
  if (mode === "idle" && !open) return null;
  const failed = mode === "failed" || ended === "failed";
  const label = "Compacting conversation; click for the details";
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className="ae-defrag"
          data-state={failed ? "failed" : "running"}
          title="Defragmenting Context C:"
          aria-label={label}
          data-testid="ae-token-defrag"
        >
          <span ref={stripRef} className="ae-defrag-strip" aria-hidden="true" />
          <span
            className="ae-defrag-label"
            data-landed={landed ? "" : undefined}
            data-testid="ae-token-defrag-label"
          >
            {failed ? "Compaction failed, history unchanged" : `${percent}%`}
          </span>
          {landed && (
            <AeTablerSvg node={CHECK} className="ae-defrag-check size-3.5 text-brand-accent" />
          )}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal container={getEmbedRoot() ?? undefined}>
        <PopoverPrimitive.Content
          side="top"
          align="start"
          sideOffset={10}
          collisionPadding={8}
          aria-label="Defragmenting Context C:"
          className="z-50 outline-hidden"
        >
          <DefragWindow
            machine={m}
            mapRef={mapRef}
            percent={percent}
            mode={mode}
            ended={ended}
            notice={notice}
            totals={notice === "complete" ? aeNotedCompactionTotals(conversationId) : null}
            onClose={() => setOpen(false)}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function paintStrip(
  strip: HTMLSpanElement | null,
  elements: Map<number, HTMLElement>,
  model: AeDefragStrip,
  launched: AeDefragPill[],
  landed: AeDefragPill[],
) {
  if (!strip) return;
  for (const pill of launched) {
    if (pill.gone) continue;
    const ghost = document.createElement("i");
    ghost.className = "ae-defrag-ghost";
    ghost.style.width = `${pill.w}px`;
    ghost.style.transform = `translate(${pill.x}px, 0)`;
    strip.appendChild(ghost);
    requestAnimationFrame(() => {
      ghost.style.opacity = "0";
    });
    setTimeout(() => ghost.remove(), 800);
  }
  for (const pill of [...model.fixed, ...model.messages, ...model.summaries]) {
    if (!pill) continue;
    let el = elements.get(pill.id);
    if (pill.gone) {
      el?.remove();
      elements.delete(pill.id);
      continue;
    }
    if (!el) {
      el = document.createElement("i");
      el.className = "ae-defrag-pill";
      el.dataset.kind = pill.kind;
      if (pill.kind === "fixed") {
        el.classList.add(categoryColor(AE_DEFRAG_FIXED[pill.tone]?.category ?? ""));
      }
      strip.appendChild(el);
      elements.set(pill.id, el);
    }
    el.style.transform = `translate(${pill.x.toFixed(2)}px, ${pill.y.toFixed(2)}px)`;
    el.style.width = `${Math.max(0, pill.w).toFixed(2)}px`;
    el.toggleAttribute("data-flying", pill.flying);
    el.toggleAttribute("data-docked", pill.docked);
    if (pill.kind === "message" && pill.docked && pill.w < pill.w0) {
      const teal = Math.round((100 * Math.max(0, pill.w)) / pill.w0);
      el.style.background = `color-mix(in oklch, var(--ae-defrag-message) ${teal}%, var(--ae-defrag-summary))`;
    }
  }
  for (const summary of landed) {
    const el = elements.get(summary.id);
    if (!el) continue;
    el.setAttribute("data-gulp", "");
    setTimeout(() => el.removeAttribute("data-gulp"), 160);
  }
}

function paintMap(map: HTMLDivElement | null, model: AeDefragMap, changed: number[] | null) {
  if (!map) return;
  const indexes = changed ?? model.cells.map((_, index) => index);
  for (const index of indexes) {
    const cell = map.children[index];
    if (cell) cell.className = `ae-w98-${model.cells[index]}`;
  }
}

function DefragWindow({
  machine,
  mapRef,
  percent,
  mode,
  ended,
  notice,
  totals,
  onClose,
}: {
  machine: Machine;
  mapRef: RefObject<HTMLDivElement | null>;
  percent: number;
  mode: Mode;
  ended: Notice;
  notice: Notice;
  totals: { before: number; after: number } | null;
  onClose: () => void;
}) {
  const [legend, setLegend] = useState(false);
  // Paint the map as it stands now; the frame loop keeps it current from here.
  useLayoutEffect(() => {
    paintMap(mapRef.current, machine.map, null);
  }, [machine, mapRef]);
  const status =
    mode === "failed" || ended === "failed"
      ? "Stopped."
      : mode === "pouring" || ended === "complete"
        ? "Defragmentation complete."
        : "Defragmenting token system...";
  const counts = totals
    ? `\n${formatTokenCount(totals.before)} → ${formatTokenCount(totals.after)} tokens.`
    : "";
  return (
    <div className="ae-w98">
      <div className="ae-w98-title">
        <span>Defragmenting Context C:</span>
        <i className="ae-w98-tb" aria-hidden="true">
          <AeTablerSvg node={MINIMIZE} />
        </i>
        <i className="ae-w98-tb" aria-hidden="true">
          <AeTablerSvg node={MAXIMIZE} />
        </i>
        <button type="button" className="ae-w98-tb" aria-label="Close" onClick={onClose}>
          <AeTablerSvg node={CLOSE} />
        </button>
      </div>
      <div className="ae-w98-body">
        <div className="ae-w98-field">
          <div ref={mapRef} className="ae-w98-map" data-testid="ae-token-defrag-map">
            {Array.from({ length: AE_DEFRAG_MAP_COLUMNS * AE_DEFRAG_MAP_ROWS }, (_, index) => (
              <i key={index} />
            ))}
          </div>
        </div>
        {legend && (
          <div className="ae-w98-legend">
            {LEGEND.map(([cell, name]) => (
              <span key={cell}>
                <i className={`ae-w98-${cell}`} />
                {name}
              </span>
            ))}
          </div>
        )}
        <div className="ae-w98-foot">
          <div className="ae-w98-stat">
            <span>{status}</span>
            <div className="ae-w98-prog">
              <div className="ae-w98-fill" style={{ width: `${percent}%` }} />
            </div>
            <span>{percent}% Complete</span>
          </div>
          <div className="ae-w98-btns">
            <button type="button" disabled>
              Stop
            </button>
            <button type="button" disabled>
              Pause
            </button>
            <button type="button" onClick={() => setLegend((shown) => !shown)}>
              Legend
            </button>
            <button type="button" onClick={onClose}>
              Hide Details
            </button>
          </div>
        </div>
      </div>
      {notice && (
        <div className="ae-w98-boxwrap">
          <div className="ae-w98 ae-w98-box" role="alertdialog" aria-label="Disk Defragmenter">
            <div className="ae-w98-title">
              <span>Disk Defragmenter</span>
            </div>
            <div className="ae-w98-msg">
              <span className="ae-w98-ico" aria-hidden="true">
                i
              </span>
              <p>
                {notice === "complete"
                  ? `Defragmentation of Context C: is complete.${counts}`
                  : "Disk Defragmenter has stopped because the drive's contents changed.\nCompaction failed; history unchanged."}
              </p>
            </div>
            <div className="ae-w98-ok">
              <button type="button" onClick={onClose}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The marker's "before → after tokens", for a compaction this page watched finish. */
export function AeCompactionTotals({ itemId }: { itemId: string }) {
  // A side chat's bubbles index a filtered copy of the child's blocks, so its markers show none.
  const inSideChat = useContext(ConversationScopeContext) !== null;
  const conversationId = useChatStore((s) => s.conversationId);
  const createdAtS = useChatStore((s) =>
    inSideChat ? null : (aeLiveMarkerStamps(s.blocks).get(itemId) ?? null),
  );
  useSyncExternalStore(
    subscribeAeCompactionTotals,
    aeCompactionTotalsVersion,
    aeCompactionTotalsVersion,
  );
  const totals = conversationId ? aeCompactionTotalsFor(conversationId, createdAtS) : null;
  if (!totals) return null;
  return (
    <span data-testid="ae-compaction-totals" className="not-italic tabular-nums">
      · {formatTokenCount(totals.before)} → {formatTokenCount(totals.after)} tokens
    </span>
  );
}

/** Settings > Chat: the token defrag switch. */
export function AeTokenDefragSetting({ className }: { className?: string }) {
  const enabled = useAeTokenDefragEnabled();
  const labelId = useId();
  return (
    <div className={cn("flex items-start justify-between gap-6", className)}>
      <div className="flex min-w-0 flex-1 flex-col">
        <span id={labelId} className="text-ui font-medium">
          Token defrag
        </span>
        <span className="text-ui text-muted-foreground">
          While a conversation compacts, the bar above the composer packs its context like an old
          disk defragmenter. Click the bar for the full window.
        </span>
      </div>
      <Switch
        aria-labelledby={labelId}
        checked={enabled}
        onCheckedChange={writeAeTokenDefrag}
        data-testid="ae-token-defrag-toggle"
        className="mt-0.5 shrink-0"
        componentId="settings.chat.ae_token_defrag"
      />
    </div>
  );
}
