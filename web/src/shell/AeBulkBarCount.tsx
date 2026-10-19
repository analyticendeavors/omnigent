// The bulk-select bar in a narrow sidebar (omnigent-ae, 2026-10-19): below
// the width that fits "N selected" beside the exit button and the four
// actions, the bar shows the bare count instead, and screen readers still
// hear "N selected". The pill is the `@container/bulk` query container; the
// threshold lives only here, sized at the sidebar's 220 px minimum.

/** The "N selected" label: read aloud always, shown where it fits. */
export const AE_BULK_LABEL_CLASS = "sr-only @[13rem]/bulk:not-sr-only";

/** The bare count shown in place of the label in a narrow bar. */
export function AeBulkBarCount({ count }: { count: number }) {
  return (
    <span
      aria-hidden="true"
      data-testid="ae-bulk-count"
      className="sidebar-compact-text shrink-0 font-medium tabular-nums @[13rem]/bulk:hidden"
    >
      {count}
    </span>
  );
}
