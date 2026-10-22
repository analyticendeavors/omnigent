import { useLayoutEffect } from "react";
import { aeDockPinnedToBottom, aeDockTranscriptScroller } from "@/lib/aeDockLift";

/**
 * Keeps the last chat lines visible above the open dock tray. The tray floats
 * over the transcript, so while the chat is pinned to the bottom the scroller
 * gets the tray's height as bottom padding and scrolls to the new end. A reader
 * scrolled up is left alone; reaching the bottom again lifts. Removing the tray
 * restores the padding.
 */
export function useAeDockLift(tray: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!tray) return;
    const scroller = aeDockTranscriptScroller(tray);
    if (!scroller) return;
    const inlinePadding = scroller.style.paddingBottom;
    const basePadding = Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
    const lift = () => {
      if (!aeDockPinnedToBottom(scroller)) return;
      scroller.style.paddingBottom = `${basePadding + tray.offsetHeight}px`;
      scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
    };
    lift();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(lift);
    observer?.observe(tray);
    scroller.addEventListener("scroll", lift, { passive: true });
    return () => {
      observer?.disconnect();
      scroller.removeEventListener("scroll", lift);
      scroller.style.paddingBottom = inlinePadding;
    };
  }, [tray]);
}
