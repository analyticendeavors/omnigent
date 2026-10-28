// AE: keep a menu's sub-flyout inside the screen on a phone. Radix flips a
// sub-menu to the side with more room but only shifts it along the other axis,
// so when neither side of the parent menu fits the flyout it ran off the screen
// edge (the composer model menu's Account, Effort and Previous models, 2026-10-28).
// The flyout is moved sideways after Radix places it; where it already fits the
// shift is 0. Kept out of the component file (the thin-fork rule).

import * as React from "react";

export const AE_SCREEN_MARGIN = 8;

/**
 * How far to move a box at `left` with `width` so it sits inside the visible band
 * `[origin, origin + viewport]` minus the margin.
 */
export function aeScreenShift(
  left: number,
  width: number,
  viewport: number,
  origin = 0,
  margin = AE_SCREEN_MARGIN,
): number {
  const fitted = Math.max(origin + margin, Math.min(left, origin + viewport - margin - width));
  return Math.round(fitted - left);
}

/** The band the user can see: under pinch-zoom on iOS the visual viewport shrinks and pans. */
function visibleBand(): { origin: number; width: number } {
  const vv = window.visualViewport;
  return vv ? { origin: vv.offsetLeft, width: vv.width } : { origin: 0, width: window.innerWidth };
}

/** Shift `node` inside the screen now and whenever Radix repositions its wrapper. */
export function aeKeepOnScreen(node: HTMLElement): () => void {
  const wrapper = node.parentElement;
  if (!wrapper) return () => {};
  const fit = () => {
    const box = wrapper.getBoundingClientRect();
    const { origin, width } = visibleBand();
    const shift = aeScreenShift(box.left, box.width, width, origin);
    node.style.position = "relative";
    node.style.left = shift === 0 ? "" : `${shift}px`;
  };
  fit();
  const frame = requestAnimationFrame(fit);
  const observer = new MutationObserver(fit);
  observer.observe(wrapper, { attributes: true, attributeFilter: ["style"] });
  window.addEventListener("resize", fit);
  window.visualViewport?.addEventListener("resize", fit);
  window.visualViewport?.addEventListener("scroll", fit);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener("resize", fit);
    window.visualViewport?.removeEventListener("resize", fit);
    window.visualViewport?.removeEventListener("scroll", fit);
  };
}

/** A callback ref that keeps the node on screen and still sets the caller's ref. */
export function useAeKeepOnScreen<T extends HTMLElement>(
  forwarded: React.ForwardedRef<T>,
): (node: T | null) => void {
  const cleanup = React.useRef<(() => void) | null>(null);
  return React.useCallback(
    (node: T | null) => {
      cleanup.current?.();
      cleanup.current = node ? aeKeepOnScreen(node) : null;
      if (typeof forwarded === "function") forwarded(node);
      else if (forwarded) forwarded.current = node;
    },
    [forwarded],
  );
}
