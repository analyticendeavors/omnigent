import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAeDockLift } from "./useAeDockLift";

let resize: (() => void) | null = null;

function Harness({ open }: { open: boolean }) {
  const [tray, setTray] = useState<HTMLDivElement | null>(null);
  useAeDockLift(tray);
  return (
    <div>
      <div data-testid="scroller" data-virtualized-transcript="" />
      <div>{open ? <div ref={setTray} data-testid="tray" /> : null}</div>
    </div>
  );
}

function mount(open: boolean, scrollTop: number) {
  const view = render(<Harness open={false} />);
  const scroller = view.getByTestId("scroller");
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
  scroller.scrollTop = scrollTop;
  view.rerender(<Harness open={open} />);
  return { view, scroller };
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(120);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        resize = cb;
      }
      observe() {}
      disconnect() {
        resize = null;
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useAeDockLift", () => {
  it("pads the transcript by the tray height when pinned to the bottom, and restores it", () => {
    const { view, scroller } = mount(true, 400);
    expect(scroller.style.paddingBottom).toBe("120px");
    view.rerender(<Harness open={false} />);
    expect(scroller.style.paddingBottom).toBe("");
  });

  it("leaves a reader scrolled up in the chat alone, through a tray resize", () => {
    const { scroller } = mount(true, 100);
    expect(scroller.style.paddingBottom).toBe("");
    act(() => resize?.());
    expect(scroller.style.paddingBottom).toBe("");
    expect(scroller.scrollTop).toBe(100);
  });

  it("lifts once the reader scrolls down to the bottom with the tray open", () => {
    const { scroller } = mount(true, 100);
    scroller.scrollTop = 400;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(scroller.style.paddingBottom).toBe("120px");
  });

  it("watches the new tray when the tray remounts", () => {
    const { view, scroller } = mount(true, 400);
    view.rerender(<Harness open={false} />);
    expect(resize).toBeNull();
    scroller.scrollTop = 400;
    view.rerender(<Harness open />);
    expect(scroller.style.paddingBottom).toBe("120px");
    expect(resize).not.toBeNull();
  });
});
