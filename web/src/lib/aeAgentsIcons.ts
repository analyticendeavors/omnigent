// The Agents pane's icons: Tabler outline icons (@tabler/icons 3.46.0),
// inlined as their paths and drawn with `AeTablerSvg` (2026-10-15).

import type { AeTablerIconNode } from "@/lib/aeTablerIconData";

const paths = (...d: string[]): AeTablerIconNode => d.map((value) => ["path", { d: value }]);

/** `player-stop`: stop a running agent. */
export const AE_ICON_STOP = paths(
  "M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2l0 -10",
);

/** `trash`: clear finished agents from the view. */
export const AE_ICON_TRASH = paths(
  "M4 7l16 0",
  "M10 11l0 6",
  "M14 11l0 6",
  "M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12",
  "M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3",
);

/** `arrow-back-up`: show cleared agents again. */
export const AE_ICON_RESTORE = paths("M9 14l-4 -4l4 -4", "M5 10h11a4 4 0 1 1 0 8h-1");

export const AE_ICON_CHEVRON_RIGHT = paths("M9 6l6 6l-6 6");
export const AE_ICON_CHEVRON_DOWN = paths("M6 9l6 6l6 -6");

/** `arrows-down`: the graph laid out top-down. */
export const AE_ICON_LAYOUT_TOP_DOWN = paths(
  "M7 21l0 -18",
  "M20 18l-3 3l-3 -3",
  "M4 18l3 3l3 -3",
  "M17 21l0 -18",
);

/** `arrows-right`: the graph laid out left to right. */
export const AE_ICON_LAYOUT_LEFT_RIGHT = paths(
  "M21 17l-18 0",
  "M18 4l3 3l-3 3",
  "M18 20l3 -3l-3 -3",
  "M21 7l-18 0",
);

/** `arrow-autofit-height`: the graph picks its direction from the pane's shape. */
export const AE_ICON_LAYOUT_AUTO = paths(
  "M12 20h-6a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h6",
  "M18 14v7",
  "M18 3v7",
  "M15 18l3 3l3 -3",
  "M15 6l3 -3l3 3",
);

/** `list-check`: the Plan section. */
export const AE_ICON_PLAN = paths(
  "M3.5 5.5l1.5 1.5l2.5 -2.5",
  "M3.5 11.5l1.5 1.5l2.5 -2.5",
  "M3.5 17.5l1.5 1.5l2.5 -2.5",
  "M11 6l9 0",
  "M11 12l9 0",
  "M11 18l9 0",
);
