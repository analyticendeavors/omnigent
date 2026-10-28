import { act, render, renderHook } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { aeKeepOnScreen, aeScreenShift, useAeKeepOnScreen } from "./aeKeepOnScreen";

// jsdom computes no layout, so these tests drive the shift with stubbed boxes. The
// real check is the hit test and the measured flyout boxes in the PR body.

afterEach(() => {
  window.innerWidth = 1024;
  Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
});

function flyout(left: number, width: number) {
  const wrapper = document.createElement("div");
  const node = document.createElement("div");
  wrapper.appendChild(node);
  document.body.appendChild(wrapper);
  wrapper.getBoundingClientRect = () =>
    ({ left, width, right: left + width, top: 0, bottom: 0, height: 0 }) as DOMRect;
  return { wrapper, node };
}

describe("aeScreenShift", () => {
  it("leaves a box that fits where it is", () => {
    expect(aeScreenShift(100, 192, 390)).toBe(0);
  });

  it("pulls a box that runs off the right edge back inside the margin", () => {
    // The phone case: Account flyout at x 282, 192 wide, on a 390 px screen.
    expect(aeScreenShift(282, 192, 390)).toBe(-92);
  });

  it("pushes a box that runs off the left edge back inside the margin", () => {
    // The 440 px case: the flyout opened to the left at x -73.
    expect(aeScreenShift(-73, 192, 440)).toBe(81);
  });

  it("keeps a box inside a visible band that starts right of the page's left edge", () => {
    // Pinch-zoomed and panned: the visible band is x 200 to 590 (offset 200, width 390).
    expect(aeScreenShift(150, 192, 390, 200)).toBe(58);
    expect(aeScreenShift(500, 192, 390, 200)).toBe(-110);
    expect(aeScreenShift(300, 192, 390, 200)).toBe(0);
  });

  it("keeps the left edge visible when the box is wider than the screen", () => {
    expect(aeScreenShift(50, 500, 390)).toBe(-42);
  });
});

describe("aeKeepOnScreen", () => {
  it("moves a flyout that overflows the viewport and clears the shift when it fits", () => {
    window.innerWidth = 390;
    const { node, wrapper } = flyout(282, 192);
    const stop = aeKeepOnScreen(node);
    expect(node.style.position).toBe("relative");
    expect(node.style.left).toBe("-92px");
    wrapper.getBoundingClientRect = () => ({ left: 100, width: 192 }) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    expect(node.style.left).toBe("");
    stop();
  });

  it("re-fits when Radix rewrites the wrapper's style", async () => {
    window.innerWidth = 390;
    const { node, wrapper } = flyout(100, 192);
    const stop = aeKeepOnScreen(node);
    expect(node.style.left).toBe("");
    wrapper.getBoundingClientRect = () => ({ left: 282, width: 192 }) as DOMRect;
    wrapper.style.transform = "translate(282px, 455px)";
    await vi.waitFor(() => expect(node.style.left).toBe("-92px"));
    stop();
  });

  it("clamps to the visual viewport when pinch-zoom shrinks it", () => {
    window.innerWidth = 1024;
    Object.defineProperty(window, "visualViewport", {
      value: { width: 390, addEventListener: vi.fn(), removeEventListener: vi.fn() },
      configurable: true,
    });
    const { node } = flyout(282, 192);
    const stop = aeKeepOnScreen(node);
    expect(node.style.left).toBe("-92px");
    stop();
  });

  it("follows a pinch-zoomed screen that is panned right and refits on its scroll", () => {
    const listeners: Record<string, () => void> = {};
    const vv = {
      width: 390,
      offsetLeft: 200,
      addEventListener: vi.fn((name: string, fn: () => void) => {
        listeners[name] = fn;
      }),
      removeEventListener: vi.fn(),
    };
    window.innerWidth = 1024;
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    const { node, wrapper } = flyout(150, 192);
    const stop = aeKeepOnScreen(node);
    // Band is x 200 to 590, so a flyout at 150 moves right to 208.
    expect(node.style.left).toBe("58px");
    vv.offsetLeft = 0;
    wrapper.getBoundingClientRect = () => ({ left: 150, width: 192 }) as DOMRect;
    listeners.scroll();
    expect(node.style.left).toBe("");
    stop();
    expect(vv.removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(vv.removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  it("stops observing after cleanup", async () => {
    window.innerWidth = 390;
    const { node, wrapper } = flyout(100, 192);
    const stop = aeKeepOnScreen(node);
    stop();
    wrapper.getBoundingClientRect = () => ({ left: 282, width: 192 }) as DOMRect;
    wrapper.style.transform = "translate(1px, 1px)";
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(node.style.left).toBe("");
  });
});

describe("useAeKeepOnScreen", () => {
  it("sets a function ref, an object ref and null, and cleans up on a ref change", () => {
    window.innerWidth = 390;
    const { wrapper, node } = flyout(282, 192);
    const fn = vi.fn();
    const obj = { current: null as HTMLDivElement | null };
    const { result, rerender } = renderHook(
      ({ forwarded }: { forwarded: React.ForwardedRef<HTMLDivElement> }) =>
        useAeKeepOnScreen(forwarded),
      { initialProps: { forwarded: fn as React.ForwardedRef<HTMLDivElement> } },
    );
    act(() => result.current(node as HTMLDivElement));
    expect(fn).toHaveBeenCalledWith(node);
    expect(node.style.left).toBe("-92px");

    // A new ref identity gives a new callback; React calls the old one with null.
    const first = result.current;
    rerender({ forwarded: obj });
    expect(result.current).not.toBe(first);
    act(() => first(null));
    expect(fn).toHaveBeenLastCalledWith(null);
    wrapper.getBoundingClientRect = () => ({ left: 100, width: 192 }) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    expect(node.style.left).toBe("-92px");

    act(() => result.current(node as HTMLDivElement));
    expect(obj.current).toBe(node);
    expect(node.style.left).toBe("");
    act(() => result.current(null));
    expect(obj.current).toBeNull();
  });
});

describe("DropdownMenuSubContent", () => {
  it("is capped to the screen width", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent data-testid="sub">Row</DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const sub = document.querySelector('[data-slot="dropdown-menu-sub-content"]');
    expect(sub?.className).toContain("max-w-[calc(100vw-1rem)]");
  });
});
