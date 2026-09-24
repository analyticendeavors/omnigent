// Tests for the split view (omnigent-ae patch P5): panes from the URL or the
// remembered layout, one frame per session, close / add / pick, the divider,
// following a frame that moves to another session, and the single-session
// fallback below 1024px.

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
    const sizes = readStoredLayout()!.sizes;
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
    expect(initialLayout(null, readStoredLayout())).toEqual({ panes: [null], sizes: [1] });
  });
});
