// The code under an approval card's message, behind "Show details" when the ask gates
// the person's own message (2026-10-22). Reid: on cards such as the rabbit-hole check he
// reads the sentence at the top, and the JSON under it is noise most of the time; he
// wanted it folded by default and opened only when needed. A request-phase ask (the
// rabbit-hole check, the slot cap) repeats the message just sent, so its code folds. Every
// other phase shows what the agent is about to do (a tool call's command, a response), so
// that code stays in view whoever wrote the policy.

import { useId, useState } from "react";
import { AE_ICON_CHEVRON_RIGHT } from "@/lib/aeAgentsIcons";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import { cn } from "@/lib/utils";

const PREVIEW_CLASS =
  "max-h-64 overflow-y-auto rounded bg-muted px-2 py-1 font-mono text-sm whitespace-pre-wrap break-words";

/** Whether a card folds its code: the ask gates the person's own message. */
export function aeFoldsApprovalPreview(phase: string): boolean {
  return phase === "request";
}

export function AeApprovalPreview({ text, fold }: { text: string; fold: boolean }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  if (!fold) return <pre className={PREVIEW_CLASS}>{text}</pre>;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-controls={regionId}
        data-testid="ae-approval-details-toggle"
        className="-mx-1 flex w-fit items-center gap-1 rounded-md px-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <AeTablerSvg
          node={AE_ICON_CHEVRON_RIGHT}
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        {open ? "Hide details" : "Show details"}
      </button>
      <pre id={regionId} hidden={!open} className={PREVIEW_CLASS}>
        {text}
      </pre>
    </div>
  );
}
