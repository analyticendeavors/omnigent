// AE: keep a menu's sub-flyout inside the screen on a phone. Radix flips a
// sub-menu to the side with more room but only shifts it along the other axis,
// so when neither side of the parent menu fits the flyout it ran off the screen
// edge (the composer model menu's Account, Effort and Previous models, 2026-10-28).
// The flyout is moved sideways after Radix places it; where it already fits the
// shift is 0. Kept out of the component file (the thin-fork rule).

import * as React from "react";

export const AE_SCREEN_MARGIN = 8;

/** How far to move a box at `left` with `width` so it sits inside `viewport` minus the margin. */
export function aeScreenShift(
  left: number,
  width: number,
  viewport: number,
  margin = AE_SCREEN_MARGIN,
): number {
  const fitted = Math.max(margin, Math.min(left, viewport - margin - width));
  return Math.round(fitted - left);
}

/** Shift `node` inside the screen now and whenever Radix repositions its wrapper. */
export function aeKeepOnScreen(node: HTMLElement): () => void {
  const wrapper = node.parentElement;
  if (!wrapper) return () => {};
  const fit = () => {
    const box = wrapper.getBoundingClientRect();
    const shift = aeScreenShift(box.left, box.width, window.innerWidth);
    node.style.position = "relative";
    node.style.left = shift === 0 ? "" : `${shift}px`;
  };
  fit();
  const frame = requestAnimationFrame(fit);
  const observer = new MutationObserver(fit);
  observer.observe(wrapper, { attributes: true, attributeFilter: ["style"] });
  window.addEventListener("resize", fit);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener("resize", fit);
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
