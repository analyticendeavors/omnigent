// The slot cap's "slots full" ask, laid out as a decision (omnigent-ae, 2026-10-29): the
// question, then the two buttons, then the park hint, with the holder list folded. It was
// one paragraph with the buttons under it, which pushed them off a 390 px phone.
// The text is parsed by lib/aeSlotsFull.ts.

import { CheckIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { AE_ICON_CHEVRON_RIGHT } from "@/lib/aeAgentsIcons";
import type { AeSlotsFull } from "@/lib/aeSlotsFull";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import { cn } from "@/lib/utils";

export function AeSlotsFullBody({
  slots,
  onApprove,
  onDecline,
}: {
  slots: AeSlotsFull;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const count = slots.rows.length;
  const numbered = slots.rows.map((row, index) => ({ ...row, n: index + 1 }));
  const noun = count === 1 ? "the holding slot" : `the ${count} holding slots`;
  return (
    <div className="flex flex-col gap-1.5" data-testid="ae-slots-full">
      <span className="font-medium text-foreground">{slots.headline}</span>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onApprove} componentId="approval.approve">
          <CheckIcon className="mr-1 size-3.5" />
          Run as overflow
        </Button>
        <Button size="sm" variant="outline" onClick={onDecline} componentId="approval.reject">
          <XIcon className="mr-1 size-3.5" />
          Decline
        </Button>
      </div>
      {slots.park && <span>{slots.park}</span>}
      {count === 0 &&
        slots.tail.map((line) => (
          <span key={line} className="break-words">
            {line}
          </span>
        ))}
      {count > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((was) => !was)}
            aria-expanded={open}
            aria-controls={regionId}
            data-testid="ae-slots-full-toggle"
            title="Which sessions hold the slots, and how to free one"
            className="-mx-1 flex w-fit items-center gap-1 rounded-md px-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <AeTablerSvg
              node={AE_ICON_CHEVRON_RIGHT}
              className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
            />
            {open ? `Hide ${noun}` : `Show ${noun}`}
          </button>
          <div id={regionId} hidden={!open} className="flex flex-col gap-1">
            {slots.rows.length > 0 && (
              <ol className="flex flex-col gap-0.5">
                {numbered.map((row) => (
                  <li key={row.n} className="break-words">
                    {row.n}. {row.title}
                    {row.detail && <span className="text-muted-foreground"> ({row.detail})</span>}
                  </li>
                ))}
              </ol>
            )}
            {slots.tail.map((line) => (
              <span key={line} className="break-words">
                {line}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
