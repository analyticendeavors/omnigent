// A small info icon that opens a tooltip (omnigent-ae, 2026-10-26). Focus opens
// it for keyboard users, a tap opens it for touch (Radix closes it on the next
// pointer down, so a second tap closes it, as do a tap outside and Escape),
// hover opens it for a mouse. The hit area is 24px; the icon stays 16px. It sits on a line the control already has, so a section stays as tall
// as before. Text comes from lib/aeSettingHints.ts.

import { InfoIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AE_SETTING_HINTS, type AeSettingHintId } from "@/lib/aeSettingHints";
import { cn } from "@/lib/utils";

export function AeHint({ id, className }: { id: AeSettingHintId; className?: string }) {
  const [open, setOpen] = useState(false);
  // Radix closes an open tooltip on pointer down; the click that follows must not reopen it.
  const openAtPointerDown = useRef(false);
  const { label, hint } = AE_SETTING_HINTS[id];
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip open={open} onOpenChange={setOpen}>
        {/* The handlers sit on the trigger so Radix's own close-on-click is skipped by preventDefault. */}
        <TooltipTrigger
          asChild
          onPointerDownCapture={(event) => {
            // A mouse that hovered it open keeps it open on click; only touch and pen toggle.
            openAtPointerDown.current = open && event.pointerType !== "mouse";
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!openAtPointerDown.current) setOpen(true);
            openAtPointerDown.current = false;
          }}
        >
          <button
            type="button"
            aria-label={`About ${label}`}
            data-testid={`ae-hint-${id}`}
            className={cn(
              "relative -my-1 ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded-sm align-middle text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring after:absolute after:-inset-1 after:content-['']",
              className,
            )}
          >
            <InfoIcon className="size-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="max-w-[min(18rem,calc(100vw-2rem))] whitespace-normal font-normal normal-case leading-normal tracking-normal"
        >
          {hint}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
