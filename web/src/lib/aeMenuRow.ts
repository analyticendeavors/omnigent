// The checkbox row of the session menu's one-column list (omnigent-ae,
// 2026-10-20): the check sits before the name, as desktop Claude Code draws it,
// which leaves the right edge for a shortcut digit or a tag. Shared by the model
// rows and the Account submenu so the indicators line up.
export const AE_MENU_ROW_CLASS =
  "min-h-8 pr-2! pl-7! whitespace-normal break-words [&>[data-slot=dropdown-menu-checkbox-item-indicator]]:right-auto [&>[data-slot=dropdown-menu-checkbox-item-indicator]]:left-1.5";
