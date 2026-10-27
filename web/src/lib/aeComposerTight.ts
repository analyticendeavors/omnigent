// Narrow split panes (omnigent-ae patch P212, 2026-10-27): a split pane is an
// iframe about 340 to 360 px wide, so the composer's action row cannot hold
// every control even with its text labels collapsed, and the Send or Interrupt
// button poked past the composer's border. When the icons alone still overflow
// the row's real gap, `useCollapsedComposerLabels` sets `data-tight` on the row
// and these classes hide the two secondary controls; if that is not enough
// (a control that must stay visible is still there) it sets `data-tighter` and
// the roles preset control goes too, so the primary button always stays inside.
//
// Nothing the user needs is hidden: the host badge stays while the host is not
// online (it carries Reconnect), and the mic stays while a take is starting or
// recording (it is the stop button). The dictation hotkey is bound to the
// mounted mic, so it keeps working while the button is hidden.

/** Hides the mic in a tight row unless a take is recording or starting. */
export const COMPOSER_TIGHT_MIC_CLASS =
  "group-data-[tight]/composer-actions:not-aria-pressed:not-aria-[busy=true]:hidden";

/** Wrapper (no layout of its own) that hides the host badge in a tight row while the host is online. */
export const COMPOSER_TIGHT_HOST_WRAPPER_CLASS =
  "contents group-data-[tight]/composer-actions:has-[[data-host-status=online]]:hidden";

/** Wrapper that hides the roles preset control only in the tighter tier. */
export const COMPOSER_TIGHTER_WRAPPER_CLASS = "contents group-data-[tighter]/composer-actions:hidden";

/** Tiers in the order the action row applies them: squeeze the gaps, hide the mic and host badge, then the roles preset. */
export const COMPOSER_TIGHT_TIERS = ["snug", "tight", "tighter"] as const;
