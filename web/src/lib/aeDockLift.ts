/** Pixels short of the end that still counts as pinned to the bottom. */
const AE_DOCK_BOTTOM_SLOP = 8;

export function aeDockPinnedToBottom(el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= AE_DOCK_BOTTOM_SLOP;
}

/** The transcript scroller beside the dock: the nearest ancestor that contains one. */
export function aeDockTranscriptScroller(from: HTMLElement): HTMLElement | null {
  for (let node = from.parentElement; node; node = node.parentElement) {
    const found = node.querySelector<HTMLElement>("[data-virtualized-transcript]");
    if (found) return found;
  }
  return null;
}
