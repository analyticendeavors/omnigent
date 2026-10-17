// Tabler outline icons (tabler.io/icons) used by the session rail, copied from
// @tabler/icons so the rail draws without loading the whole set.
// To add one, copy its nodes from node_modules/@tabler/icons/tabler-nodes-outline.json.

import type { AeTablerIconNode } from "@/lib/aeTablerIconData";

export const AE_RAIL_ICONS = {
  // grip-vertical
  grip: [
    ["path", { d: "M8 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" }],
    ["path", { d: "M8 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" }],
    ["path", { d: "M8 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" }],
    ["path", { d: "M14 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" }],
    ["path", { d: "M14 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" }],
    ["path", { d: "M14 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" }],
  ],
  // chevron-down
  chevronDown: [["path", { d: "M6 9l6 6l6 -6" }]],
  // chevron-right
  chevronRight: [["path", { d: "M9 6l6 6l-6 6" }]],
  // dots-vertical
  dots: [
    ["path", { d: "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" }],
    ["path", { d: "M11 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" }],
    ["path", { d: "M11 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" }],
  ],
  // arrow-up
  arrowUp: [
    ["path", { d: "M12 5l0 14" }],
    ["path", { d: "M18 11l-6 -6" }],
    ["path", { d: "M6 11l6 -6" }],
  ],
  // arrow-down
  arrowDown: [
    ["path", { d: "M12 5l0 14" }],
    ["path", { d: "M18 13l-6 6" }],
    ["path", { d: "M6 13l6 6" }],
  ],
  // arrow-bar-to-up
  arrowToTop: [
    ["path", { d: "M12 10l0 10" }],
    ["path", { d: "M12 10l4 4" }],
    ["path", { d: "M12 10l-4 4" }],
    ["path", { d: "M4 4l16 0" }],
  ],
  // restore
  restore: [
    ["path", { d: "M3.06 13a9 9 0 1 0 .49 -4.087" }],
    ["path", { d: "M3 4.001v5h5" }],
    ["path", { d: "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" }],
  ],
  // refresh
  refresh: [
    ["path", { d: "M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" }],
    ["path", { d: "M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" }],
  ],
  // info-circle
  info: [
    ["path", { d: "M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" }],
    ["path", { d: "M12 9h.01" }],
    ["path", { d: "M11 12h1v4h1" }],
  ],
  // server
  server: [
    ["path", { d: "M3 7a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-2" }],
    [
      "path",
      { d: "M3 15a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3l0 -2" },
    ],
    ["path", { d: "M7 8l0 .01" }],
    ["path", { d: "M7 16l0 .01" }],
  ],
  // folder
  folder: [
    [
      "path",
      { d: "M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2" },
    ],
  ],
  // git-branch
  gitBranch: [
    ["path", { d: "M5 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M5 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M15 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M7 8l0 8" }],
    ["path", { d: "M9 18h6a2 2 0 0 0 2 -2v-5" }],
    ["path", { d: "M14 14l3 -3l3 3" }],
  ],
  // shield-check
  shield: [
    [
      "path",
      {
        d: "M11.46 20.846a12 12 0 0 1 -7.96 -14.846a12 12 0 0 0 8.5 -3a12 12 0 0 0 8.5 3a12 12 0 0 1 -.09 7.06",
      },
    ],
    ["path", { d: "M15 19l2 2l4 -4" }],
  ],
  // plug-connected
  plug: [
    ["path", { d: "M7 12l5 5l-1.5 1.5a3.536 3.536 0 1 1 -5 -5l1.5 -1.5" }],
    ["path", { d: "M17 12l-5 -5l1.5 -1.5a3.536 3.536 0 1 1 5 5l-1.5 1.5" }],
    ["path", { d: "M3 21l2.5 -2.5" }],
    ["path", { d: "M18.5 5.5l2.5 -2.5" }],
    ["path", { d: "M10 11l-2 2" }],
    ["path", { d: "M13 14l-2 2" }],
  ],
  // plug-connected-x
  plugX: [
    ["path", { d: "M20 16l-4 4" }],
    ["path", { d: "M7 12l5 5l-1.5 1.5a3.536 3.536 0 1 1 -5 -5l1.5 -1.5" }],
    ["path", { d: "M17 12l-5 -5l1.5 -1.5a3.536 3.536 0 1 1 5 5l-1.5 1.5" }],
    ["path", { d: "M3 21l2.5 -2.5" }],
    ["path", { d: "M18.5 5.5l2.5 -2.5" }],
    ["path", { d: "M10 11l-2 2" }],
    ["path", { d: "M13 14l-2 2" }],
    ["path", { d: "M16 16l4 4" }],
  ],
  // file
  file: [
    ["path", { d: "M14 3v4a1 1 0 0 0 1 1h4" }],
    ["path", { d: "M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" }],
  ],
  // file-text
  fileText: [
    ["path", { d: "M14 3v4a1 1 0 0 0 1 1h4" }],
    ["path", { d: "M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" }],
    ["path", { d: "M9 9l1 0" }],
    ["path", { d: "M9 13l6 0" }],
    ["path", { d: "M9 17l6 0" }],
  ],
  // file-code
  fileCode: [
    ["path", { d: "M14 3v4a1 1 0 0 0 1 1h4" }],
    ["path", { d: "M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" }],
    ["path", { d: "M10 13l-1 2l1 2" }],
    ["path", { d: "M14 13l1 2l-1 2" }],
  ],
  // file-diff
  fileDiff: [
    ["path", { d: "M14 3v4a1 1 0 0 0 1 1h4" }],
    ["path", { d: "M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" }],
    ["path", { d: "M12 10l0 4" }],
    ["path", { d: "M10 12l4 0" }],
    ["path", { d: "M10 17l4 0" }],
  ],
  // photo
  photo: [
    ["path", { d: "M15 8h.01" }],
    [
      "path",
      { d: "M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12" },
    ],
    ["path", { d: "M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5" }],
    ["path", { d: "M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3" }],
  ],
  // paperclip
  paperclip: [
    [
      "path",
      {
        d: "M15 7l-6.5 6.5a1.5 1.5 0 0 0 3 3l6.5 -6.5a3 3 0 0 0 -6 -6l-6.5 6.5a4.5 4.5 0 0 0 9 9l6.5 -6.5",
      },
    ],
  ],
  // git-pull-request
  prOpen: [
    ["path", { d: "M4 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M4 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M16 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M6 8l0 8" }],
    ["path", { d: "M11 6h5a2 2 0 0 1 2 2v8" }],
    ["path", { d: "M14 9l-3 -3l3 -3" }],
  ],
  // git-merge
  prMerged: [
    ["path", { d: "M5 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M5 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M15 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M7 8l0 8" }],
    ["path", { d: "M7 8a4 4 0 0 0 4 4h4" }],
  ],
  // git-pull-request-closed
  prClosed: [
    ["path", { d: "M4 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M4 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M16 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M6 8v8" }],
    ["path", { d: "M18 11v5" }],
    ["path", { d: "M16 4l4 4m0 -4l-4 4" }],
  ],
  // git-pull-request-draft
  prDraft: [
    ["path", { d: "M4 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M4 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M16 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" }],
    ["path", { d: "M6 8v8" }],
    ["path", { d: "M18 11h.01" }],
    ["path", { d: "M18 6h.01" }],
  ],
  // robot
  robot: [
    ["path", { d: "M6 6a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -4" }],
    ["path", { d: "M12 2v2" }],
    ["path", { d: "M9 12v9" }],
    ["path", { d: "M15 12v9" }],
    ["path", { d: "M5 16l4 -2" }],
    ["path", { d: "M15 14l4 2" }],
    ["path", { d: "M9 18h6" }],
    ["path", { d: "M10 8v.01" }],
    ["path", { d: "M14 8v.01" }],
  ],
  // alarm
  alarm: [
    ["path", { d: "M5 13a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" }],
    ["path", { d: "M12 10l0 3l2 0" }],
    ["path", { d: "M7 4l-2.75 2" }],
    ["path", { d: "M17 4l2.75 2" }],
  ],
  // clock
  clock: [
    ["path", { d: "M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" }],
    ["path", { d: "M12 7v5l3 3" }],
  ],
  // arrow-fork
  fork: [
    ["path", { d: "M16 3h5v5" }],
    ["path", { d: "M8 3h-5v5" }],
    ["path", { d: "M21 3l-7.536 7.536a5 5 0 0 0 -1.464 3.534v6.93" }],
    ["path", { d: "M3 3l7.536 7.536a5 5 0 0 1 1.464 3.534v.93" }],
  ],
  // layout-sidebar-right
  rail: [
    [
      "path",
      { d: "M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12" },
    ],
    ["path", { d: "M15 4l0 16" }],
  ],
  // layout-sidebar-right-collapse
  railCollapse: [
    [
      "path",
      { d: "M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12" },
    ],
    ["path", { d: "M15 4v16" }],
    ["path", { d: "M9 10l2 2l-2 2" }],
  ],
  // layout-sidebar-right-expand
  railExpand: [
    [
      "path",
      { d: "M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12" },
    ],
    ["path", { d: "M15 4v16" }],
    ["path", { d: "M10 10l-2 2l2 2" }],
  ],
  // list-details
  listDetails: [
    ["path", { d: "M13 5h8" }],
    ["path", { d: "M13 9h5" }],
    ["path", { d: "M13 15h8" }],
    ["path", { d: "M13 19h5" }],
    ["path", { d: "M3 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" }],
    [
      "path",
      { d: "M3 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4" },
    ],
  ],
  // x
  close: [
    ["path", { d: "M18 6l-12 12" }],
    ["path", { d: "M6 6l12 12" }],
  ],
  // external-link
  external: [
    ["path", { d: "M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6" }],
    ["path", { d: "M11 13l9 -9" }],
    ["path", { d: "M15 4h5v5" }],
  ],
  // player-pause
  pause: [
    [
      "path",
      { d: "M6 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12" },
    ],
    [
      "path",
      { d: "M14 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12" },
    ],
  ],
  // player-play
  play: [["path", { d: "M7 4v16l13 -8l-13 -8" }]],
  // circle-check
  circleCheck: [
    ["path", { d: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" }],
    ["path", { d: "M9 12l2 2l4 -4" }],
  ],
  // alert-triangle
  warning: [
    ["path", { d: "M12 9v4" }],
    [
      "path",
      {
        d: "M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0",
      },
    ],
    ["path", { d: "M12 16h.01" }],
  ],
  // arrows-minimize
  compact: [
    ["path", { d: "M5 9l4 0l0 -4" }],
    ["path", { d: "M3 3l6 6" }],
    ["path", { d: "M5 15l4 0l0 4" }],
    ["path", { d: "M3 21l6 -6" }],
    ["path", { d: "M19 9l-4 0l0 -4" }],
    ["path", { d: "M15 9l6 -6" }],
    ["path", { d: "M19 15l-4 0l0 4" }],
    ["path", { d: "M15 15l6 6" }],
  ],
  // loader-2
  loader: [["path", { d: "M12 3a9 9 0 1 0 9 9" }]],
} satisfies Record<string, AeTablerIconNode>;

export type AeRailIconName = keyof typeof AE_RAIL_ICONS;
