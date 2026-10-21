// Digit shortcuts in the session menu (omnigent-ae, 2026-10-20): the numbered
// model rows can be picked with their digit from anywhere in the menu, as desktop
// Claude Code's picker allows.

export interface AeDigitKey {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
}

/**
 * The model row a digit picks, or null: no digit, a modifier held, the key typed
 * in a submenu (Radix renders those in portals outside `root`), no such row, a
 * disabled row, or the row already checked (re-picking the current model would
 * only issue a change the session never confirms).
 */
export function aeModelRowForDigit(root: HTMLElement, event: AeDigitKey): HTMLElement | null {
  if (!/^[1-9]$/.test(event.key) || event.altKey || event.ctrlKey || event.metaKey) return null;
  if (!(event.target instanceof Node) || !root.contains(event.target)) return null;
  return root.querySelector<HTMLElement>(
    `[data-model-shortcut="${event.key}"]:not([data-disabled]):not([aria-checked="true"])`,
  );
}
