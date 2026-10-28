// The action dock's limit icon, with a card of every usage window on the
// chat's login. Hover opens it on a desktop; a tap does on a phone, which has
// no hover. omnigent-ae, 2026-10-28.

import { type ReactNode, useId, useRef, useState } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { AeLimitWindow } from "@/components/AePlanLimits";
import { aeLimitResetClock, type AeLimitGate } from "@/lib/aeLimitGate";
import { type AeLimitLevel, aeLimitHoverRows } from "@/lib/aeLimitHover";
import { cn } from "@/lib/utils";

const BAR: Record<AeLimitLevel, string> = {
  warn: "bg-red-500",
  mid: "bg-amber-500",
  ok: "bg-emerald-500",
};

export function AeLimitHoverCard({
  gate,
  windows,
  children,
}: {
  gate: AeLimitGate;
  windows: readonly AeLimitWindow[] | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const cardId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  // A touch opens or closes on pointer-up: Radix's trigger cancels touchstart, which can swallow the click.
  const touched = useRef(false);
  const rows = aeLimitHoverRows(windows ?? [], gate);
  if (rows.length === 0) return <>{children}</>;
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-expanded={open}
          aria-controls={open ? cardId : undefined}
          className="flex shrink-0 items-center rounded-md p-0.5 hover:bg-muted"
          aria-label={`Usage for ${gate.label}`}
          onPointerUp={(e) => {
            if (e.pointerType !== "touch") return;
            touched.current = true;
            setOpen((o) => !o);
          }}
          // A mouse already opened it on hover, so its click never closes it; a touch handled the tap above.
          onClick={() => {
            if (touched.current) touched.current = false;
            else setOpen(true);
          }}
          data-testid="ae-dock-limit-icon"
        >
          {children}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        id={cardId}
        role="region"
        aria-label={`Usage for ${gate.label}`}
        side="top"
        align="start"
        className="w-72"
        // The icon's own tap toggles; an outside press on it must not close the card first.
        onPointerDownOutside={(e) => {
          if (e.target instanceof Node && trigger.current?.contains(e.target)) e.preventDefault();
        }}
        data-testid="ae-dock-limit-card"
      >
        <div className="mb-2 text-xs font-semibold">{gate.label}</div>
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id} data-testid="ae-dock-limit-row" data-level={row.level}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="min-w-0 truncate">
                  {row.label}
                  {row.isGate && (
                    <span className="ml-1.5 rounded border border-red-500/60 px-1 text-[10px] text-red-400">
                      limit
                    </span>
                  )}
                </span>
                <span className="font-semibold tabular-nums">{row.percent}%</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("h-full rounded-full", BAR[row.level])}
                  style={{ width: `${Math.min(100, row.percent)}%` }}
                />
              </div>
              {row.resetsAt && Number.isFinite(Date.parse(row.resetsAt)) && (
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  resets {aeLimitResetClock(row.resetsAt, Date.now())}
                </div>
              )}
            </li>
          ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  );
}
