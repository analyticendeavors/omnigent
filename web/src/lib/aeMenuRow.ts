// The checkbox row of the session menu's one-column list (omnigent-ae,
// 2026-10-20): the check sits before the name, as desktop Claude Code draws it,
// which leaves the right edge for a shortcut digit or a tag. Shared by the model
// rows and the Account submenu so the indicators line up.
export const AE_MENU_ROW_CLASS =
  "min-h-8 pr-2! pl-7! whitespace-normal break-words [&>[data-slot=dropdown-menu-checkbox-item-indicator]]:right-auto [&>[data-slot=dropdown-menu-checkbox-item-indicator]]:left-1.5";

// The session menus (in a chat and on New Chat) and their Account, Effort and
// model submenus hug their widest row, with a shared floor and the viewport cap.
export const AE_MENU_WIDTH_CLASS = "w-max min-w-40 max-w-[calc(100vw-2rem)]";

// A note or error line wraps to the rows' width instead of setting it: width 0
// keeps it out of the menu's max-content size, min-width 100% lays it out.
export const AE_MENU_NOTE_CLASS = "w-0 min-w-full whitespace-normal";
