// A family lead row's fixed right-hand slots (omnigent-ae, 2026-10-26). Reading
// right to left: the open/close chevron (20px, 4px from the edge), then the time or
// alert dot (the 34px AE_TIME_COLUMN). Each slot is absolutely placed from the
// row's right edge, so none moves when the pointer arrives; the hover actions
// overlay the time column and never reach the chevron. Rows: shell/Sidebar.tsx,
// AeFamilyTree.tsx.
//
// The thinking spinner (the lead's own turn, or a folded-away child's) takes the
// time's place, since "now" is all the time would say. It used to keep a 16px slot
// of its own on every lead row, which left about 28px of the title empty on an
// idle row (Reid, 2026-10-26). Only when the time slot holds another marker (an
// unseen dot, a draft, "Needs response") does the spinner sit left of it.

import { AE_TIME_COLUMN } from "@/lib/aeFamilyBadge";

/** The chevron's slot: 20px square, 4px from the row's right edge. */
export const AE_LEAD_CHEVRON_SLOT =
  "absolute right-1 flex size-5 shrink-0 items-center justify-center";

/** The time or alert-dot slot: the shared 34px column, right-aligned, left of the chevron. */
export const AE_LEAD_TIME_SLOT = `w-[34px] justify-end ${AE_TIME_COLUMN}`;

/** The thinking spinner's slot when the time slot holds another marker: 16px, left of it. */
export const AE_LEAD_SPINNER_SLOT = "w-4 justify-center";

// Geometry in px, measured from the row's right edge. Every number below comes from
// the one before it, so a slot cannot drift from its neighbour.
const GAP = 4;
const CHEVRON_RIGHT = 4;
const CHEVRON_W = 20;
const TIME_RIGHT = CHEVRON_RIGHT + CHEVRON_W + GAP; // 28
const TIME_W = 34;
const TIME_END = TIME_RIGHT + TIME_W; // 62
const SPINNER_W = 16;
const SHARED_W = 24;
const TITLE_GAP = 8;

/**
 * How wide a wide marker is, from the reserves the other rows give it (reserve minus
 * the 4px right offset and the 8px title gap): the "Needs response" pill pr-29 -> 104,
 * a scheduled time pr-20 -> 68, any other activity badge pr-14 -> 44.
 */
const WIDE_WIDTH = { pill: 104, scheduled: 68, badge: 44 } as const;
export type AeLeadWideMarker = keyof typeof WIDE_WIDTH;

export interface AeLeadRowGeometry {
  /** Right offset of the marker in the time slot, px. */
  markerRight: number;
  /**
   * Right offset of the spinner, px: the time slot's own offset when the spinner
   * takes it, else left of the marker there; null when no spinner shows.
   */
  spinnerRight: number | null;
  /** The spinner sits in the time slot, in place of the time. */
  spinnerInTime: boolean;
  /** Right offset of the "shared" icon, px; null when the row is not shared. */
  sharedRight: number | null;
  /** The row's right padding, px: the title ends here. */
  reserve: number;
}

/**
 * Where a lead's markers sit and how much padding the title keeps, decided by
 * (shared, wide marker, another marker in the time slot, spinner showing). The
 * spinner takes the time slot when nothing else is there; otherwise it sits left of
 * the marker (a wide one is right-anchored at the time slot and grows left). The
 * shared icon sits left of whatever is leftmost. An idle row keeps only the time
 * slot, so the title runs to it.
 */
export function aeLeadRowGeometry(opts: {
  shared: boolean;
  wide: AeLeadWideMarker | null;
  /** The time slot holds a marker of its own (a state badge or the draft pencil). */
  marker: boolean;
  spinner: boolean;
}): AeLeadRowGeometry {
  const markerLeft = opts.wide === null ? TIME_END : TIME_RIGHT + WIDE_WIDTH[opts.wide];
  const spinnerInTime = opts.spinner && !opts.marker;
  const spinnerBeside = opts.spinner && opts.marker;
  const spinnerRight = spinnerInTime ? TIME_RIGHT : spinnerBeside ? markerLeft + GAP : null;
  const left = spinnerBeside ? markerLeft + GAP + SPINNER_W : Math.max(markerLeft, TIME_END);
  const sharedRight = opts.shared ? left + GAP : null;
  const reserve = sharedRight === null ? left + TITLE_GAP : sharedRight + SHARED_W + TITLE_GAP;
  return { markerRight: TIME_RIGHT, spinnerRight, spinnerInTime, sharedRight, reserve };
}

/**
 * The hover actions' wrapper: right of the chevron's slot, left of nothing. It is
 * pointer-events-none, so the row link under it keeps every click (the buttons turn
 * pointer events back on), and md and up only, so a phone has no strip over the time.
 * The fade is a background that appears with the actions (hover, focus inside the
 * actions, or an open menu) and takes its colour from --ae-fade-color, which is the
 * row's own hover colour, or the active colour on the open row.
 */
export const AE_LEAD_ACTIONS_OVERLAY =
  "pointer-events-none right-[28px] pl-[22px] pr-0.5 hidden md:flex";

// Written out in full: Tailwind finds a class only as one literal token.
export const AE_LEAD_FADE_TRIGGERS = [
  "md:group-hover:bg-[linear-gradient(90deg,transparent,var(--ae-fade-color)_22px),linear-gradient(90deg,transparent,var(--sidebar)_22px)]",
  "md:group-has-[:focus-visible:not([data-testid=ae-family-fold])]:bg-[linear-gradient(90deg,transparent,var(--ae-fade-color)_22px),linear-gradient(90deg,transparent,var(--sidebar)_22px)]",
  "md:group-has-[[aria-expanded=true]]:bg-[linear-gradient(90deg,transparent,var(--ae-fade-color)_22px),linear-gradient(90deg,transparent,var(--sidebar)_22px)]",
].join(" ");

/** Hover colour of a plain row (dark mode halves it, as the row does). */
export const AE_LEAD_FADE_PLAIN =
  "[--ae-fade-color:var(--muted)] dark:[--ae-fade-color:color-mix(in_oklab,var(--muted)_50%,transparent)]";
/** The open row's colour, the same in both modes (SIDEBAR_ACTIVE_HIGHLIGHT). */
export const AE_LEAD_FADE_ACTIVE =
  "[--ae-fade-color:var(--sidebar-active)] dark:[--ae-fade-color:var(--sidebar-active)]";

/** The buttons inside the wrapper take clicks even though the wrapper does not. */
export const AE_LEAD_ACTION_BUTTON = "pointer-events-auto";

// A lead's chevron is focusable inside the row, so its focus must not swap the time
// and spinner for the actions: only focus elsewhere in the row (the actions, the link) does.
// Written out in full for Tailwind.
export const AE_LEAD_FOCUS_HIDE =
  "md:group-has-[:focus-visible:not([data-testid=ae-family-fold])]:opacity-0";
export const AE_LEAD_FOCUS_SHOW =
  "md:group-has-[:focus-visible:not([data-testid=ae-family-fold])]:opacity-100";
/** A lead's time, dot and spinner slots: fade out with hover, focus (not the chevron) or an open menu. */
export const AE_LEAD_SLOT_FADE_OUT =
  "-translate-y-1/2 pointer-events-none absolute flex h-5 items-center transition-opacity md:group-hover:opacity-0 md:group-has-[:focus-visible:not([data-testid=ae-family-fold])]:opacity-0 md:group-has-[[aria-expanded=true]]:opacity-0";
