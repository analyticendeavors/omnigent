// The PR cards' icons: Tabler outline icons (@tabler/icons 3.46.0), inlined as
// their paths so a card loads no icon set. Drawn with `AeTablerSvg`. The
// Dashboard's Open PRs card inlines the same paths (2026-10-14).

import type { AeTablerIconNode } from "@/lib/aeTablerIconData";

const paths = (...d: string[]): AeTablerIconNode => d.map((value) => ["path", { d: value }]);

const RINGS = [
  "M4 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
  "M4 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
  "M16 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
];

/** `git-pull-request`: an open pull request. */
export const AE_ICON_PR_OPEN = paths(
  ...RINGS,
  "M6 8l0 8",
  "M11 6h5a2 2 0 0 1 2 2v8",
  "M14 9l-3 -3l3 -3",
);

/** `git-pull-request-draft`. */
export const AE_ICON_PR_DRAFT = paths(...RINGS, "M6 8v8", "M18 11h.01", "M18 6h.01");

/** `git-pull-request-closed`: closed without merging. */
export const AE_ICON_PR_CLOSED = paths(...RINGS, "M6 8v8", "M18 11v5", "M16 4l4 4m0 -4l-4 4");

/** `git-merge`: a merged pull request, and the Merge button. */
export const AE_ICON_MERGE = paths(
  "M5 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
  "M5 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
  "M15 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
  "M7 8l0 8",
  "M7 8a4 4 0 0 0 4 4h4",
);

export const AE_ICON_CIRCLE_CHECK = paths("M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M9 12l2 2l4 -4");

export const AE_ICON_CIRCLE_X = paths(
  "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
  "M10 10l4 4m0 -4l-4 4",
);

export const AE_ICON_ALERT_CIRCLE = paths(
  "M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0",
  "M12 8v4",
  "M12 16h.01",
);

export const AE_ICON_CLOCK = paths("M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0", "M12 7v5l3 3");

export const AE_ICON_CIRCLE_DASHED = paths(
  "M8.56 3.69a9 9 0 0 0 -2.92 1.95",
  "M3.69 8.56a9 9 0 0 0 -.69 3.44",
  "M3.69 15.44a9 9 0 0 0 1.95 2.92",
  "M8.56 20.31a9 9 0 0 0 3.44 .69",
  "M15.44 20.31a9 9 0 0 0 2.92 -1.95",
  "M20.31 15.44a9 9 0 0 0 .69 -3.44",
  "M20.31 8.56a9 9 0 0 0 -1.95 -2.92",
  "M15.44 3.69a9 9 0 0 0 -3.44 -.69",
);

/** `loader-2`, spun with `animate-spin` while a request runs. */
export const AE_ICON_LOADER = paths("M12 3a9 9 0 1 0 9 9");

export const AE_ICON_EXTERNAL_LINK = paths(
  "M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6",
  "M11 13l9 -9",
  "M15 4h5v5",
);

/** `check`: ticks the chosen merge method. */
export const AE_ICON_CHECK = paths("M5 12l5 5l10 -10");
