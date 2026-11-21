// An approval message folded to about three lines with a Show more toggle, so the Approve
// and Reject buttons stay on screen on a phone (omnigent-ae, 2026-11-20: policy messages
// ran 15 lines and pushed the buttons below the fold). The clamp is always on while
// collapsed; the toggle appears only when the text really overflows three lines (measured,
// so a wide screen or a short message shows no toggle).
//
// The fold is visual only: the full text stays in the accessibility tree, so the toggle
// carries no aria-expanded or aria-controls (a screen reader would otherwise hear a
// collapsed control over text it can already read). It is a plain button, still
// keyboard-reachable; aria-hidden is not used because it must never sit on a focusable element.

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ElicitationMessage } from "./ElicitationMessage";

export function AeClampedMessage({ message }: { message: string }) {
  const text = message.replace(/\s+$/, "");
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [seen, setSeen] = useState(text);
  const bodyRef = useRef<HTMLDivElement>(null);

  // A new message starts folded again.
  if (seen !== text) {
    setSeen(text);
    setOpen(false);
  }

  // Measured only while collapsed: an open body has no clamp to overflow.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || open) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open]);

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={bodyRef}
        data-testid="ae-clamped-message"
        data-clamped={open ? "false" : "true"}
        className={cn("break-words whitespace-pre-wrap", !open && "line-clamp-3")}
      >
        <ElicitationMessage message={text} />
      </div>
      {(overflows || open) && (
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          data-testid="ae-clamped-message-toggle"
          className="-mx-1 inline-flex min-h-6 w-fit items-center rounded-md px-1 py-0.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
