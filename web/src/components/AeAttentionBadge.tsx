// The "Needs you" pill on the sidebar's Admin Center row (omnigent-ae, 2026-11-03, plan v1.5).
// Red when the number is urgent, neutral when it is the review count, nothing at zero. The text
// is white on the light theme's red and the dark theme's background colour on its lighter red,
// since white on that red is under AA contrast. A compact form (a filled dot for something to
// act on, a hollow ring when a source could not be read) serves narrow rails; the count is then
// in the tooltip and the aria-label spells out everything the colour says.

import { useAeAttention } from "@/lib/aeAttention";
import { cn } from "@/lib/utils";

export function AeAttentionBadge({ compact = false }: { compact?: boolean }) {
  const view = useAeAttention();
  if (view.kind === "none") return null;
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
        "ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-10 font-medium tabular-nums",
        red
          ? "bg-destructive text-white dark:text-background"
          : "bg-[var(--sidebar-active)] text-[var(--sidebar-active-foreground)]",
        view.kind === "unknown" && "border border-muted-foreground bg-transparent",
      )}
    >
      {view.text}
    </span>
  );
}
