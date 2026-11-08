// One look for the sidebar's AE count pills: the Admin Center's Needs you count (AeAttentionBadge)
// and the Session Dashboard's slots (AeSlotsPill). One size with the text centred (`text-10` is not
// a size this theme defines), red only for something to act on now, grey for a plain count.

/** Size, font and centring shared by every AE count pill in the sidebar. */
export const AE_COUNT_PILL =
  "ml-auto inline-flex min-h-[19px] min-w-[19px] items-center justify-center rounded-full px-1.5 text-xs leading-none font-semibold tabular-nums";

/**
 * Something to act on now: an urgent Needs you item, or the slots at their limit. Solid red with
 * white text (the dark theme's background colour on its lighter red): a red tint failed AA on the
 * selected row's pink wash.
 */
export const AE_COUNT_PILL_ALERT = "bg-destructive text-white dark:text-background";

/** A plain count: items to review, or the slots in use under the limit. Muted text was 3.3:1 on the selected row. */
export const AE_COUNT_PILL_QUIET = "bg-muted-foreground/15 text-foreground/80";
