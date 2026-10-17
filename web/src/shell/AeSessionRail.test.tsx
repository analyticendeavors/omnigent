import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AE_RAIL_SECTIONS, useAeSessionRailStore } from "@/lib/aeSessionRail";
import { AeSessionRail, aeRailFloats, workspaceTabOpener } from "./AeSessionRail";

const { isMobileMock } = vi.hoisted(() => ({ isMobileMock: vi.fn(() => false) }));

vi.mock("@/hooks/useIsMobileViewport", () => ({
  useIsMobileViewport: () => isMobileMock(),
}));

// Small stand-ins for the real sections, so the container is tested alone.
vi.mock("@/components/aeRail/registry", async () => {
  const { AE_RAIL_SECTIONS: ids } = await import("@/lib/aeSessionRail");
  const { AeRailSection } = await import("@/components/aeRail/AeRailSection");
  const components = Object.fromEntries(
    ids.map((id) => [
      id,
      ({ sessionId }: { sessionId: string }) => (
        <AeRailSection id={id}>
          <p>
            {id} body for {sessionId}
          </p>
        </AeRailSection>
      ),
    ]),
  );
  return { AE_RAIL_COMPONENTS: components };
});

function sectionOrder(): string[] {
  return [...document.querySelectorAll("[data-ae-rail-item]")].map(
    (el) => el.getAttribute("data-ae-rail-item") ?? "",
  );
}

beforeEach(() => {
  useAeSessionRailStore.setState({
    open: true,
    sheetOpen: false,
    order: [...AE_RAIL_SECTIONS],
    folded: {},
    focus: null,
  });
});

afterEach(() => {
  cleanup();
  isMobileMock.mockReturnValue(false);
});

describe("AeSessionRail", () => {
  it("renders the sections in the store's order with the session id", () => {
    useAeSessionRailStore.setState({
      order: [
        "usage",
        "triage",
        ...AE_RAIL_SECTIONS.filter((id) => id !== "usage" && id !== "triage"),
      ],
    });
    render(<AeSessionRail sessionId="s-1" />);
    expect(sectionOrder().slice(0, 3)).toEqual(["usage", "triage", "environment"]);
    expect(screen.getByText("usage body for s-1")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Drag to reorder/ })).toHaveLength(
      AE_RAIL_SECTIONS.length,
    );
  });

  it("renders nothing while closed or while the right panel is maximized", () => {
    useAeSessionRailStore.setState({ open: false });
    const { rerender } = render(<AeSessionRail sessionId="s-1" />);
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
    act(() => useAeSessionRailStore.setState({ open: true }));
    rerender(<AeSessionRail sessionId="s-1" hidden />);
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
  });

  it("reorders through a section menu's Move up", () => {
    render(<AeSessionRail sessionId="s-1" />);
    const context = screen.getByRole("region", { name: "Context" });
    const menu = within(context).getByRole("button", { name: "Context options" });
    fireEvent.pointerDown(menu, { button: 0 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
    expect(sectionOrder().slice(0, 3)).toEqual(["triage", "context", "environment"]);
  });

  it("scrolls a focused section into view and flashes it", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    useAeSessionRailStore.setState({ folded: { agents: true } });
    render(<AeSessionRail sessionId="s-1" />);
    act(() => useAeSessionRailStore.getState().focusSection("agents"));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    const item = document.querySelector('[data-ae-rail-item="agents"]');
    expect(scrollIntoView.mock.instances.at(-1)).toBe(item);
    expect(scrollIntoView).toHaveBeenLastCalledWith(expect.objectContaining({ block: "nearest" }));
    expect(item).toHaveAttribute("data-flashing", "true");
    expect(screen.getByText("agents body for s-1")).toBeInTheDocument();
    scrollIntoView.mockRestore();
  });

  it("docks while the chat keeps 480 px beside it, and floats below that", () => {
    // A 1210 px window with the sidebar closed leaves the chat 906 px: dock.
    expect(aeRailFloats(1210, 0)).toBe(false);
    // The same window with a 320 px sidebar still leaves 586 px.
    expect(aeRailFloats(1210, 320)).toBe(false);
    // Exactly 480 px left docks; one pixel less floats.
    expect(aeRailFloats(1104, 320)).toBe(false);
    expect(aeRailFloats(1103, 320)).toBe(true);
    // The workspace panel shares the row, so it counts against the chat too.
    expect(aeRailFloats(1440, 320 + 500)).toBe(true);
    expect(aeRailFloats(1690, 500)).toBe(false);
  });

  it("docks in jsdom's 1024 px window with the sidebar closed", () => {
    render(<AeSessionRail sessionId="s-1" />);
    expect(screen.getByTestId("ae-session-rail")).not.toHaveAttribute("data-floating");
  });

  it("floats once the sidebar and workspace panel leave the chat too little room", () => {
    // 1024 - 220 - 304 leaves the chat 500 px: dock.
    const { rerender } = render(<AeSessionRail sessionId="s-1" sidebarWidth={220} />);
    expect(screen.getByTestId("ae-session-rail")).not.toHaveAttribute("data-floating");
    // A 240 px workspace panel cuts that to 260 px: float.
    rerender(<AeSessionRail sessionId="s-1" sidebarWidth={220} workspacePanelWidth={240} />);
    expect(screen.getByTestId("ae-session-rail")).toHaveAttribute("data-floating", "true");
  });

  it("re-decides when the window is resized", () => {
    const original = window.innerWidth;
    render(<AeSessionRail sessionId="s-1" sidebarWidth={320} />);
    const rail = () => screen.getByTestId("ae-session-rail");
    try {
      act(() => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
        window.dispatchEvent(new Event("resize"));
      });
      expect(rail()).toHaveAttribute("data-floating", "true");
      act(() => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
        window.dispatchEvent(new Event("resize"));
      });
      expect(rail()).not.toHaveAttribute("data-floating");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: original });
    }
  });

  it("floating, closes from its header button and from Escape", () => {
    render(<AeSessionRail sessionId="s-1" sidebarWidth={600} />);
    const rail = screen.getByTestId("ae-session-rail");
    expect(rail).toHaveAttribute("data-floating", "true");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useAeSessionRailStore.getState().open).toBe(false);
    act(() => useAeSessionRailStore.setState({ open: true }));
    fireEvent.click(screen.getByRole("button", { name: "Hide session rail" }));
    expect(useAeSessionRailStore.getState().open).toBe(false);
  });

  it("shows the phone sheet only while sheetOpen, and its close button closes it", () => {
    isMobileMock.mockReturnValue(true);
    render(<AeSessionRail sessionId="s-1" />);
    const sheet = screen.getByTestId("ae-session-rail-sheet");
    expect(sheet).toHaveAttribute("data-state", "closed");
    expect(screen.queryByTestId("ae-session-rail-list")).toBeNull();
    act(() => useAeSessionRailStore.getState().setSheetOpen(true));
    expect(sheet).toHaveAttribute("data-state", "open");
    expect(within(sheet).getByText("Session")).toBeInTheDocument();
    expect(within(sheet).getByText("triage body for s-1")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(useAeSessionRailStore.getState().sheetOpen).toBe(false);
  });
});

describe("workspaceTabOpener", () => {
  function workspace(open: boolean, available = true) {
    return {
      open,
      available,
      toggle: vi.fn(),
      showTab: vi.fn(),
      mobile: { changes: vi.fn(), subagents: vi.fn() },
    };
  }

  it("opens a closed panel on the tab, and only switches tabs when it is open", () => {
    const closed = workspace(false);
    workspaceTabOpener(closed, false, vi.fn())?.("changes");
    expect(closed.toggle).toHaveBeenCalledTimes(1);
    expect(closed.showTab).toHaveBeenCalledWith("changes");
    const open = workspace(true);
    workspaceTabOpener(open, false, vi.fn())?.("subagents");
    expect(open.toggle).not.toHaveBeenCalled();
    expect(open.showTab).toHaveBeenCalledWith("subagents");
  });

  it("closes the phone sheet before opening the drawer", () => {
    const shell = workspace(false);
    const setSheetOpen = vi.fn();
    workspaceTabOpener(shell, true, setSheetOpen)?.("subagents");
    expect(setSheetOpen).toHaveBeenCalledWith(false);
    expect(shell.mobile.subagents).toHaveBeenCalledTimes(1);
  });

  it("offers nothing without a shell or a workspace panel", () => {
    expect(workspaceTabOpener(undefined, false, vi.fn())).toBeUndefined();
    expect(workspaceTabOpener(workspace(false, false), false, vi.fn())).toBeUndefined();
  });
});
