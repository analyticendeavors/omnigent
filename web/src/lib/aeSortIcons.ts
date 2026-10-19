// The sidebar's sort-mode icons: Tabler outline icons (@tabler/icons 3.46.0),
// inlined as their paths so the session list loads no icon set. Drawn with
// `AeTablerSvg`, like the PR cards' icons (`aePrIcons.ts`).

import { AE_ICON_CIRCLE_DASHED } from "@/lib/aePrIcons";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";

const paths = (...d: string[]): AeTablerIconNode => d.map((value) => ["path", { d: value }]);

/** `arrows-sort`: the row menu's Move submenu. */
export const AE_ICON_ARROWS_SORT = paths("M3 9l4 -4l4 4m-4 -4v14", "M21 15l-4 4l-4 -4m4 4v-14");

/** `arrow-bar-to-up`: Move to top. */
export const AE_ICON_MOVE_TOP = paths("M12 10l0 10", "M12 10l4 4", "M12 10l-4 4", "M4 4l16 0");

/** `arrow-up`: Move up. */
export const AE_ICON_MOVE_UP = paths("M12 5l0 14", "M18 11l-6 -6", "M6 11l6 -6");

/** `arrow-down`: Move down. */
export const AE_ICON_MOVE_DOWN = paths("M12 5l0 14", "M18 13l-6 6", "M6 13l6 6");

/** `arrow-bar-to-down`: Move to bottom. */
export const AE_ICON_MOVE_BOTTOM = paths(
  "M4 20l16 0",
  "M12 14l0 -10",
  "M12 14l4 -4",
  "M12 14l-4 -4",
);

/** `circle-dashed` (shared with the PR cards): the Triage group of sessions with no status. */
export const AE_ICON_NO_STATUS = AE_ICON_CIRCLE_DASHED;

/** `loader-2` (shared with the PR cards), spun while the Archived group loads more. */
export { AE_ICON_LOADER } from "@/lib/aePrIcons";

/** `history`: the Triage view's Archived group (unlike Reference's archive box). */
export const AE_ICON_HISTORY = paths("M12 8l0 4l2 2", "M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5");
