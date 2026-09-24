// Tests for the split view (omnigent-ae patches P5 and P10): panes from the URL
// or the remembered layout, one frame per session, close / add / pick, the
// dividers in both axes, following a frame that moves to another session, the
// single-session fallback below 1024px, and every layout preset: the picker,
// where each preset puts its panes, growing on add, shrinking on close,
// swapping panes, and a version 1 layout restored after the upgrade.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AE_SPLIT_STORAGE_KEY, readStoredLayout } from "@/lib/aeSplitLayout";

const mocks = vi.hoisted(() => ({
  conversations: [] as { id: string; title: string | null }[],
}));

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({
    data: { pages: [{ data: mocks.conversations }], pageParams: [undefined] },
  }),
}));

import { AE_SPLIT_FRAME_POLL_MS, AeSplitPage, initialLayout } from "./AeSplitPage";

let wide = true;

function setViewport(isWide: boolean) {
  wide = isWide;
  window.matchMedia = ((query: string) => ({
    matches: wide,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/split" element={<AeSplitPage />} />
        <Route path="*" element={<p>single</p>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

function frames() {
  return screen.getAllByTestId("ae-split-frame") as HTMLIFrameElement[];
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.conversations = [
    { id: "a", title: "Alpha" },
    { id: "b", title: "Beta" },
    { id: "c", title: "Gamma" },
  ];
  setViewport(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AeSplitPage", () => {
  it("renders one frame per session in the URL, titled from the session list", () => {
    renderAt("/split?s=a,b");
    expect(frames().map((f) => f.getAttribute("src"))).toEqual(["/c/a", "/c/b"]);
    expect(screen.getAllByTestId("ae-split-pane").map((p) => p.getAttribute("aria-label"))).toEqual(
      ["Alpha", "Beta"],
    );
    expect(screen.getAllByTestId("ae-split-divider")).toHaveLength(1);
    expect(screen.getByTestId("ae-split-count")).toHaveTextContent("2 of 4 panes");
    expect(frames()[0]!.name).toMatch(/^ae-split-pane-/);
  });

  it("remembers the layout and restores it when the URL carries none", () => {
    renderAt("/split?s=a,b");
    expect(readStoredLayout()?.panes).toEqual(["a", "b"]);
    cleanup();
    renderAt("/split");
    expect(frames().map((f) => f.getAttribute("src"))).toEqual(["/c/a", "/c/b"]);
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=a,b");
  });

  it("closes a pane without reloading its neighbour", () => {
    renderAt("/split?s=a,b,c");
    const survivor = frames()[2];
    fireEvent.click(screen.getAllByTestId("ae-split-close")[1]!);
    expect(frames().map((f) => f.getAttribute("src"))).toEqual(["/c/a", "/c/c"]);
    expect(frames()[1]).toBe(survivor);
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=a,c");
    expect(readStoredLayout()?.panes).toEqual(["a", "c"]);
  });

  it("adds an empty pane on the new-session page, up to four", () => {
    renderAt("/split?s=a,b,c");
    fireEvent.click(screen.getByTestId("ae-split-add"));
    expect(frames().map((f) => f.getAttribute("src"))).toEqual(["/c/a", "/c/b", "/c/c", "/"]);
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=a,b,c,new");
    expect(screen.getByTestId("ae-split-add")).toBeDisabled();
  });

  it("switches a pane's session from its picker and disables sessions open elsewhere", () => {
    renderAt("/split?s=a,b");
    const picker = screen.getAllByTestId("ae-split-picker")[1] as HTMLSelectElement;
    const optionA = Array.from(picker.options).find((o) => o.value === "a")!;
    expect(optionA.disabled).toBe(true);
    fireEvent.change(picker, { target: { value: "c" } });
    expect(frames().map((f) => f.getAttribute("src"))).toEqual(["/c/a", "/c/c"]);
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=a,c");
  });

  it("moves a divider with the arrow keys and remembers the widths", () => {
    renderAt("/split?s=a,b");
    const divider = screen.getByTestId("ae-split-divider");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(divider.getAttribute("aria-valuenow")).toBe("54");
    const sizes = readStoredLayout()!.cols;
    expect(sizes[0]).toBeCloseTo(0.54);
    expect(sizes[1]).toBeCloseTo(0.46);
  });

  it("follows a frame that opens another session inside it", () => {
    vi.useFakeTimers();
    renderAt("/split?s=a,new");
    const frame = frames()[1]!;
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: { location: { pathname: "/c/c" }, document: { title: "Gamma" } },
    });
    act(() => {
      vi.advanceTimersByTime(AE_SPLIT_FRAME_POLL_MS);
    });
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=a,c");
    // The frame already shows that session; it is not reloaded.
    expect(frames()[1]).toBe(frame);
  });

  it("ignores a frame that moves onto a session another pane holds", () => {
    vi.useFakeTimers();
    renderAt("/split?s=a,b");
    Object.defineProperty(frames()[1]!, "contentWindow", {
      configurable: true,
      value: { location: { pathname: "/c/a" }, document: { title: "" } },
    });
    act(() => {
      vi.advanceTimersByTime(AE_SPLIT_FRAME_POLL_MS);
    });
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=a,b");
  });

  it("falls back to the first session alone below 1024px", () => {
    setViewport(false);
    renderAt("/split?s=b,a");
    expect(screen.getByText("single")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/c/b");
  });

  it("leaves for the first pane's session from Single view", () => {
    renderAt("/split?s=new,b");
    fireEvent.click(screen.getByTestId("ae-split-exit"));
    expect(screen.getByTestId("where")).toHaveTextContent("/c/b");
  });

  it("ignores a stored layout that is not JSON", () => {
    window.localStorage.setItem(AE_SPLIT_STORAGE_KEY, "nope");
    expect(initialLayout(null, readStoredLayout())).toEqual({
      preset: "one",
      panes: [null],
      cols: [1],
      rows: [[1]],
    });
  });
});

/** Each pane's slot rectangle as its inline style reads, in slot order: [left, top, width, height]. */
function placements() {
  return screen
    .getAllByTestId("ae-split-pane")
    .sort((a, b) => Number(a.dataset.slot) - Number(b.dataset.slot))
    .map((p) => [p.style.left, p.style.top, p.style.width, p.style.height]);
}

function sessionsBySlot() {
  return screen
    .getAllByTestId("ae-split-pane")
    .sort((a, b) => Number(a.dataset.slot) - Number(b.dataset.slot))
    .map((p) => p.dataset.session);
}

describe("AeSplitPage layout presets", () => {
  it("shows the seven presets in the top bar with the current one pressed", () => {
    renderAt("/split?s=a,b");
    const group = screen.getByRole("group", { name: "Layout" });
    const buttons = Array.from(group.querySelectorAll("button"));
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "2 side by side",
      "2 stacked",
      "2 stacked, 1 beside them",
      "1, then 2 stacked beside it",
      "2 by 2 grid",
      "3 side by side",
      "4 side by side",
    ]);
    expect(buttons.filter((b) => b.getAttribute("aria-pressed") === "true")).toEqual([
      screen.getByTestId("ae-split-preset-cols2"),
    ]);
    // Each button draws its preset: one rectangle per pane.
    expect(screen.getByTestId("ae-split-preset-grid").querySelectorAll("rect")).toHaveLength(4);
  });

  it("2 side by side: two columns, one vertical divider", () => {
    renderAt("/split?s=a,b");
    expect(placements()).toEqual([
      ["0%", "0%", "calc(50% - 3px)", "100%"],
      ["calc(50% + 3px)", "0%", "calc(50% - 3px)", "100%"],
    ]);
    const dividers = screen.getAllByTestId("ae-split-divider");
    expect(dividers.map((d) => d.getAttribute("aria-orientation"))).toEqual(["vertical"]);
  });

  it("2 stacked: one column, one horizontal divider that takes the up and down arrows", () => {
    renderAt("/split?s=a,b&l=rows2");
    expect(screen.getByTestId("ae-split-row").dataset.preset).toBe("rows2");
    expect(placements()).toEqual([
      ["0%", "0%", "100%", "calc(50% - 3px)"],
      ["0%", "calc(50% + 3px)", "100%", "calc(50% - 3px)"],
    ]);
    const divider = screen.getByTestId("ae-split-divider");
    expect(divider.getAttribute("aria-orientation")).toBe("horizontal");
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
    fireEvent.keyDown(divider, { key: "ArrowDown" });
    fireEvent.keyDown(divider, { key: "ArrowDown" });
    fireEvent.keyDown(divider, { key: "ArrowUp" });
    expect(divider.getAttribute("aria-valuenow")).toBe("52");
    expect(readStoredLayout()!.rows[0]![0]).toBeCloseTo(0.52);
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=a,b&l=rows2");
  });

  it("2+1: two stacked on the left, one beside them", () => {
    renderAt("/split?s=a,b,c&l=stack-left");
    expect(placements()).toEqual([
      ["0%", "0%", "calc(50% - 3px)", "calc(50% - 3px)"],
      ["0%", "calc(50% + 3px)", "calc(50% - 3px)", "calc(50% - 3px)"],
      ["calc(50% + 3px)", "0%", "calc(50% - 3px)", "100%"],
    ]);
    expect(
      screen.getAllByTestId("ae-split-divider").map((d) => d.getAttribute("aria-orientation")),
    ).toEqual(["vertical", "horizontal"]);
  });

  it("1+2: one on the left, two stacked beside it", () => {
    renderAt("/split?s=a,b,c&l=stack-right");
    expect(placements()).toEqual([
      ["0%", "0%", "calc(50% - 3px)", "100%"],
      ["calc(50% + 3px)", "0%", "calc(50% - 3px)", "calc(50% - 3px)"],
      ["calc(50% + 3px)", "calc(50% + 3px)", "calc(50% - 3px)", "calc(50% - 3px)"],
    ]);
  });

  it("2x2 grid: two columns of two, one vertical and two horizontal dividers", () => {
    renderAt("/split?s=a,b,c,d&l=grid");
    expect(placements()).toHaveLength(4);
    expect(placements()[3]).toEqual([
      "calc(50% + 3px)",
      "calc(50% + 3px)",
      "calc(50% - 3px)",
      "calc(50% - 3px)",
    ]);
    const dividers = screen.getAllByTestId("ae-split-divider");
    expect(dividers.map((d) => d.getAttribute("aria-orientation"))).toEqual([
      "vertical",
      "horizontal",
      "horizontal",
    ]);
    // The columns' stacks resize independently.
    fireEvent.keyDown(dividers[2]!, { key: "ArrowDown" });
    const rows = readStoredLayout()!.rows;
    expect(rows[0]).toEqual([0.5, 0.5]);
    expect(rows[1]![0]).toBeCloseTo(0.52);
  });

  it("3 and 4 side by side: columns only", () => {
    renderAt("/split?s=a,b,c");
    expect(screen.getByTestId("ae-split-row").dataset.preset).toBe("cols3");
    expect(screen.getAllByTestId("ae-split-divider")).toHaveLength(2);
    cleanup();
    renderAt("/split?s=a,b,c,d");
    expect(screen.getByTestId("ae-split-row").dataset.preset).toBe("cols4");
    expect(
      screen.getAllByTestId("ae-split-divider").map((d) => d.getAttribute("aria-orientation")),
    ).toEqual(["vertical", "vertical", "vertical"]);
  });

  it("switching preset moves the frames without reloading them and mirrors it in the URL", () => {
    renderAt("/split?s=a,b");
    const before = frames();
    fireEvent.click(screen.getByTestId("ae-split-preset-rows2"));
    expect(frames()).toEqual(before);
    expect(screen.getByTestId("ae-split-preset-rows2")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=a,b&l=rows2");
    expect(readStoredLayout()).toMatchObject({ preset: "rows2", panes: ["a", "b"] });
  });

  it("a bigger preset opens its extra slots on the new-session page", () => {
    renderAt("/split?s=a,b");
    fireEvent.click(screen.getByTestId("ae-split-preset-grid"));
    expect(sessionsBySlot()).toEqual(["a", "b", "", ""]);
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=a,b,new,new&l=grid");
    expect(screen.getByTestId("ae-split-add")).toBeDisabled();
  });

  it("a smaller preset keeps the first sessions, dropping empty panes first", () => {
    renderAt("/split?s=a,new,b,c&l=grid");
    expect(screen.getByTestId("ae-split-preset-cols2")).toHaveAttribute(
      "title",
      expect.stringContaining("keeps the first 2 sessions; the other 1 close here"),
    );
    fireEvent.click(screen.getByTestId("ae-split-preset-cols2"));
    expect(sessionsBySlot()).toEqual(["a", "b"]);
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=a,b");
  });

  it("adding a pane past the preset's slots switches to the next preset that fits", () => {
    renderAt("/split?s=a,b&l=rows2");
    expect(screen.getByTestId("ae-split-add")).toHaveAttribute(
      "title",
      expect.stringContaining("2 stacked, 1 beside them"),
    );
    fireEvent.click(screen.getByTestId("ae-split-add"));
    expect(screen.getByTestId("ae-split-row").dataset.preset).toBe("stack-left");
    expect(sessionsBySlot()).toEqual(["a", "b", ""]);
    fireEvent.click(screen.getByTestId("ae-split-add"));
    expect(screen.getByTestId("ae-split-row").dataset.preset).toBe("grid");
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=a,b,new,new&l=grid");
  });

  it("closing a pane shrinks to the preset of what is left", () => {
    renderAt("/split?s=a,b,c,d&l=grid");
    const survivors = frames().filter((f) => f.getAttribute("src") !== "/c/d");
    const closeD = screen
      .getAllByTestId("ae-split-pane")
      .find((p) => p.dataset.session === "d")!
      .querySelector('[data-testid="ae-split-close"]')!;
    fireEvent.click(closeD);
    expect(screen.getByTestId("ae-split-row").dataset.preset).toBe("stack-left");
    expect(frames()).toEqual(survivors);
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=a,b,c&l=stack-left");
  });

  it("the last pane cannot be closed", () => {
    renderAt("/split?s=a");
    expect(screen.getByTestId("ae-split-close")).toBeDisabled();
  });

  it("swaps two panes by dragging one's grip onto the other, without reloading either", () => {
    renderAt("/split?s=a,b,c&l=stack-left");
    const before = frames();
    const grips = screen.getAllByTestId("ae-split-grip");
    const panes = screen.getAllByTestId("ae-split-pane");
    fireEvent.dragStart(grips[0]!);
    // While a pane is moving the frames let the page keep the pointer.
    expect(frames()[0]!.className).toContain("pointer-events-none");
    fireEvent.dragOver(panes[2]!);
    expect(panes[2]!.className).toContain("ring-2");
    fireEvent.drop(panes[2]!);
    expect(sessionsBySlot()).toEqual(["c", "b", "a"]);
    expect(frames()).toEqual(before);
    expect(frames().map((f) => f.getAttribute("src"))).toEqual(["/c/a", "/c/b", "/c/c"]);
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=c,b,a&l=stack-left");
    expect(frames()[0]!.className).not.toContain("pointer-events-none");
  });

  it("moves a pane one slot with the arrow keys on its grip", () => {
    renderAt("/split?s=a,b,c");
    const gripA = screen.getAllByTestId("ae-split-grip")[0]!;
    fireEvent.keyDown(gripA, { key: "ArrowRight" });
    expect(sessionsBySlot()).toEqual(["b", "a", "c"]);
    fireEvent.keyDown(gripA, { key: "ArrowDown" });
    expect(sessionsBySlot()).toEqual(["b", "c", "a"]);
    fireEvent.keyDown(gripA, { key: "ArrowRight" });
    expect(sessionsBySlot()).toEqual(["b", "c", "a"]);
    fireEvent.keyDown(gripA, { key: "ArrowUp" });
    expect(sessionsBySlot()).toEqual(["b", "a", "c"]);
  });

  it("follows a frame that navigates after its pane was swapped", () => {
    vi.useFakeTimers();
    renderAt("/split?s=a,b");
    const frameA = frames()[0]!;
    fireEvent.keyDown(screen.getAllByTestId("ae-split-grip")[0]!, { key: "ArrowRight" });
    Object.defineProperty(frameA, "contentWindow", {
      configurable: true,
      value: { location: { pathname: "/c/c" }, document: { title: "Gamma" } },
    });
    act(() => {
      vi.advanceTimersByTime(AE_SPLIT_FRAME_POLL_MS);
    });
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=b,c");
  });

  it("restores a version 1 layout from before presets as side by side with its widths", () => {
    window.localStorage.setItem(
      AE_SPLIT_STORAGE_KEY,
      JSON.stringify({ panes: ["a", "b"], sizes: [0.3, 0.7] }),
    );
    renderAt("/split");
    expect(screen.getByTestId("ae-split-row").dataset.preset).toBe("cols2");
    expect(screen.getByTestId("ae-split-divider").getAttribute("aria-valuenow")).toBe("30");
    expect(JSON.parse(window.localStorage.getItem(AE_SPLIT_STORAGE_KEY)!)).toMatchObject({
      v: 2,
      preset: "cols2",
      cols: [0.3, 0.7],
    });
  });

  it("keeps remembered sizes when the URL names the same preset and pane count", () => {
    const stored = {
      v: 2,
      preset: "rows2",
      panes: ["x", "y"],
      cols: [1],
      rows: [[0.7, 0.3]],
    };
    window.localStorage.setItem(AE_SPLIT_STORAGE_KEY, JSON.stringify(stored));
    renderAt("/split?s=a,b&l=rows2");
    expect(screen.getByTestId("ae-split-divider").getAttribute("aria-valuenow")).toBe("70");
    cleanup();
    renderAt("/split?s=a,b");
    expect(screen.getByTestId("ae-split-divider").getAttribute("aria-valuenow")).toBe("50");
  });

  it("ignores an `l` that does not fit the panes", () => {
    renderAt("/split?s=a,b&l=grid");
    expect(screen.getByTestId("ae-split-row").dataset.preset).toBe("cols2");
    expect(screen.getByTestId("where")).toHaveTextContent("/split?s=a,b");
    expect(screen.getByTestId("where").textContent).not.toContain("l=");
  });
});
