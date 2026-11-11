// The "Needs you" pill on the sidebar's Admin Center row (omnigent-ae, 2026-11-03, plan v1.5).
// Red when the number is urgent, grey when it is the review count, a green check at zero when every source read; the size and
// colours are the slots pill's (aeCountPill.ts). A compact form (a filled dot for something to
// act on, a hollow ring when a source could not be read) serves narrow rails; the count is then
// in the tooltip and the aria-label spells out everything the colour says.

import { Check } from "lucide-react";
import { useAeAttention } from "@/lib/aeAttention";
import { AE_COUNT_PILL, AE_COUNT_PILL_ALERT, AE_COUNT_PILL_QUIET } from "@/lib/aeCountPill";
import { cn } from "@/lib/utils";

export function AeAttentionBadge({ compact = false }: { compact?: boolean }) {
  const view = useAeAttention();
  if (view.kind === "none") return null;
  if (view.kind === "clear") {
    return (
      <span
        role="img"
        data-testid={compact ? "ae-attention-dot" : "ae-attention-pill"}
        data-kind="clear"
        aria-label={view.label}
        title={view.tooltip}
        className="ml-auto inline-flex text-success"
      >
        <Check aria-hidden strokeWidth={3} className={compact ? "size-3" : "size-4"} />
      </span>
    );
  }
  const red = view.kind === "urgent";
  if (compact) {
    return (
      <span
        role="img"
        data-testid="ae-attention-dot"
        data-kind={view.kind}
        aria-label={view.label}
        title={view.tooltip}
        className={cn(
          "ml-auto size-2 rounded-full",
          view.kind === "unknown"
            ? "border border-muted-foreground bg-transparent"
            : red
              ? "bg-destructive"
              : "bg-muted-foreground",
        )}
      />
    );
  }
  return (
    <span
      role="img"
      data-testid="ae-attention-pill"
      data-kind={view.kind}
      aria-label={view.label}
      title={view.tooltip}
      className={cn(
        // The Session Dashboard's slots pill shares this size and these colours (aeCountPill.ts).
        AE_COUNT_PILL,
        red ? AE_COUNT_PILL_ALERT : AE_COUNT_PILL_QUIET,
        view.kind === "unknown" && "border border-muted-foreground bg-transparent",
      )}
    >
      {view.text}
    </span>
  );
}
