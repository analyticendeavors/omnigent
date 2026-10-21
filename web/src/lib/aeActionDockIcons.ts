// The action dock's icons: Tabler outline icons (@tabler/icons 3.46.0),
// inlined as their paths like the PR cards' (aePrIcons.ts). Drawn with `AeTablerSvg`.

import type { AeTablerIconNode } from "@/lib/aeTablerIconData";

const paths = (...d: string[]): AeTablerIconNode => d.map((value) => ["path", { d: value }]);

/** `help-circle`: a question waiting. */
export const AE_ICON_HELP_CIRCLE = paths(
  "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
  "M12 16v.01",
  "M12 13a2 2 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483",
);

/** `rocket`: a merge on its way to the box. */
export const AE_ICON_ROCKET = paths(
  "M4 13a8 8 0 0 1 7 7a6 6 0 0 0 3 -5a9 9 0 0 0 6 -8a3 3 0 0 0 -3 -3a9 9 0 0 0 -8 6a6 6 0 0 0 -5 3",
  "M7 14a6 6 0 0 0 -3 6a6 6 0 0 0 6 -3",
  "M14 9a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
);

export const AE_ICON_X = paths("M18 6l-12 12", "M6 6l12 12");

export const AE_ICON_CHEVRON_UP = paths("M6 15l6 -6l6 6");

export const AE_ICON_ARROW_DOWN = paths("M12 5l0 14", "M18 13l-6 6", "M6 13l6 6");
