// A long approval message folded to about three lines with a Show more toggle, so the
// Approve and Reject buttons stay on screen on a phone (omnigent-ae, 2026-11-20: policy
// messages ran 15 lines and pushed the buttons below the fold). A short message renders
// exactly as before: no clamp, no toggle.

import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { ElicitationMessage } from "./ElicitationMessage";

/** Messages longer than this many characters, or with more than three lines, fold. */
export const AE_CLAMP_MIN_CHARS = 200;
const AE_CLAMP_MAX_LINES = 3;

export function aeMessageNeedsClamp(message: string): boolean {
  return message.length > AE_CLAMP_MIN_CHARS || message.split("\n").length > AE_CLAMP_MAX_LINES;
}

export function AeClampedMessage({ message }: { message: string }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  if (!aeMessageNeedsClamp(message)) return <ElicitationMessage message={message} />;
  return (
    <div className="flex flex-col gap-1">
      <div
        id={regionId}
        data-testid="ae-clamped-message"
        data-clamped={open ? "false" : "true"}
        className={cn("break-words whitespace-pre-wrap", !open && "line-clamp-3")}
      >
        <ElicitationMessage message={message} />
      </div>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-controls={regionId}
        data-testid="ae-clamped-message-toggle"
        className="-mx-1 w-fit rounded-md px-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {open ? "Show less" : "Show more"}
      </button>
    </div>
  );
}
