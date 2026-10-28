import { describe, expect, it } from "vitest";
import { aeKeepOnScreen, aeScreenShift } from "./aeKeepOnScreen";

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

  it("keeps the left edge visible when the box is wider than the screen", () => {
    expect(aeScreenShift(50, 500, 390)).toBe(-42);
  });
});

describe("aeKeepOnScreen", () => {
  function flyout(left: number, width: number) {
    const wrapper = document.createElement("div");
    const node = document.createElement("div");
    wrapper.appendChild(node);
    document.body.appendChild(wrapper);
    wrapper.getBoundingClientRect = () =>
      ({ left, width, right: left + width, top: 0, bottom: 0, height: 0 }) as DOMRect;
    return { wrapper, node };
  }

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
});
