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

/** `gauge`: an account near its usage limit. */
export const AE_ICON_GAUGE = paths(
  "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
  "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  "M13.41 10.59l2.59 -2.59",
  "M7 12a5 5 0 0 1 5 -5",
);

/** `sparkles`: switch model. */
export const AE_ICON_SPARKLES = paths(
  "M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6",
);

/** `user-share`: switch account. */
export const AE_ICON_USER_SHARE = paths(
  "M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0",
  "M6 21v-2a4 4 0 0 1 4 -4h3",
  "M16 22l5 -5",
  "M21 21.5v-4.5h-4.5",
);

/** `message-plus`: a new chat. */
export const AE_ICON_MESSAGE_PLUS = paths(
  "M8 9h8",
  "M8 13h6",
  "M12.01 18.594l-4.01 2.406v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v5.5",
  "M16 19h6",
  "M19 16v6",
);
