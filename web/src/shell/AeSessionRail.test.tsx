import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AE_RAIL_SECTIONS,
  aeRailForgetRestoredSession,
  aeRailRestoredPanelOpen,
  useAeSessionRailStore,
} from "@/lib/aeSessionRail";
import { aeRecordTempPromotion } from "@/lib/aeTempPromotions";
import { resetSharedWidthStoreForTesting } from "@/hooks/useResizablePanel";
import {
  AeSessionRail,
  aeRailFloats,
  aeRailReservedWidth,
  workspaceTabOpener,
} from "./AeSessionRail";

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

function workspace(open: boolean, available = true, animating = false) {
  return {
    open,
    animating,
    available,
    toggle: vi.fn(),
    showTab: vi.fn(),
    mobile: { changes: vi.fn(), subagents: vi.fn() },
  };
}

const jsdomInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");

function resizeTo(value: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value });
    window.dispatchEvent(new Event("resize"));
  });
}

const setupMatchMedia = window.matchMedia;

function reduceMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    ...setupMatchMedia(query),
    matches: reduce && query.includes("prefers-reduced-motion"),
  })) as typeof window.matchMedia;
}

beforeEach(() => {
  useAeSessionRailStore.setState({
    open: true,
    closedForPanel: false,
    sheetOpen: false,
    order: [...AE_RAIL_SECTIONS],
    folded: {},
    focus: null,
    openInEverySession: false,
  });
  // The layout tests take the rail's instant path; the slide has its own tests.
  reduceMotion(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = setupMatchMedia;
  isMobileMock.mockReturnValue(false);
  // Put jsdom's own property back, accessor or not, for the tests after this one.
  if (jsdomInnerWidth) Object.defineProperty(window, "innerWidth", jsdomInnerWidth);
  else delete (window as { innerWidth?: number }).innerWidth;
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

  it("reserves the sidebar, the workspace panel with its 8 px gap, and a push panel", () => {
    expect(aeRailReservedWidth(320, 0, 0)).toBe(320);
    expect(aeRailReservedWidth(0, 500, 0)).toBe(508);
    expect(aeRailReservedWidth(320, 0, 600)).toBe(920);
  });

  it("counts an open files or logs panel against the chat", () => {
    resetSharedWidthStoreForTesting();
    // Closed: jsdom's 1024 px window leaves the chat 720 px, so the rail docks.
    const { rerender } = render(<AeSessionRail sessionId="s-1" />);
    expect(screen.getByTestId("ae-session-rail")).not.toHaveAttribute("data-floating");
    // Open at its default half of the window (512 px), 208 px are left: the rail makes way.
    rerender(<AeSessionRail sessionId="s-1" pushPanelOpen />);
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
    rerender(<AeSessionRail sessionId="s-1" />);
    expect(screen.getByTestId("ae-session-rail")).not.toHaveAttribute("data-floating");
  });

  it("docks in jsdom's 1024 px window with the sidebar closed", () => {
    render(<AeSessionRail sessionId="s-1" />);
    expect(screen.getByTestId("ae-session-rail")).not.toHaveAttribute("data-floating");
  });

  it("closes for a panel opened beside it without room, and reopens once the panel closes", () => {
    // 1024 - 220 - 304 leaves the chat 500 px: dock.
    const { rerender } = render(<AeSessionRail sessionId="s-1" sidebarWidth={220} />);
    expect(screen.getByTestId("ae-session-rail")).not.toHaveAttribute("data-floating");
    // A 240 px workspace panel and its 8 px gap cut that to 252 px: the rail makes way.
    rerender(<AeSessionRail sessionId="s-1" sidebarWidth={220} workspacePanelWidth={240} />);
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
    expect(useAeSessionRailStore.getState().closedForPanel).toBe(true);
    rerender(<AeSessionRail sessionId="s-1" sidebarWidth={220} />);
    expect(screen.getByTestId("ae-session-rail")).not.toHaveAttribute("data-floating");
    // Closed by the user, it stays closed after the next panel comes and goes.
    act(() => useAeSessionRailStore.getState().toggle());
    rerender(<AeSessionRail sessionId="s-1" sidebarWidth={220} workspacePanelWidth={240} />);
    rerender(<AeSessionRail sessionId="s-1" sidebarWidth={220} />);
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
  });

  it("opened over a panel, closes the push panels and the workspace", () => {
    useAeSessionRailStore.setState({ open: false });
    const shell = workspace(true);
    const closePushPanels = vi.fn();
    const { rerender } = render(
      <AeSessionRail
        sessionId="s-1"
        sidebarWidth={220}
        workspacePanelWidth={240}
        workspace={shell}
        closePushPanels={closePushPanels}
      />,
    );
    act(() => useAeSessionRailStore.getState().toggle());
    expect(shell.toggle).toHaveBeenCalledTimes(1);
    expect(closePushPanels).toHaveBeenCalledTimes(1);
    // Once the shell has closed them, the rail docks and nothing closes again.
    rerender(
      <AeSessionRail
        sessionId="s-1"
        sidebarWidth={220}
        workspace={{ ...shell, open: false }}
        closePushPanels={closePushPanels}
      />,
    );
    expect(screen.getByTestId("ae-session-rail")).not.toHaveAttribute("data-floating");
    expect(shell.toggle).toHaveBeenCalledTimes(1);
  });

  it("waits on a phone and behind a maximized panel, then makes way beside the panel", () => {
    const { rerender } = render(<AeSessionRail sessionId="s-1" workspacePanelWidth={900} hidden />);
    expect(useAeSessionRailStore.getState().open).toBe(true);
    isMobileMock.mockReturnValue(true);
    rerender(<AeSessionRail sessionId="s-1" workspacePanelWidth={900} />);
    expect(useAeSessionRailStore.getState().open).toBe(true);
    // Back on a desktop beside the restored panel, the panel counts as opened last.
    isMobileMock.mockReturnValue(false);
    rerender(<AeSessionRail sessionId="s-1" workspacePanelWidth={900} />);
    expect(useAeSessionRailStore.getState()).toMatchObject({ open: false, closedForPanel: true });
  });

  it("re-decides when the window is resized", () => {
    render(<AeSessionRail sessionId="s-1" sidebarWidth={320} />);
    const rail = () => screen.getByTestId("ae-session-rail");
    resizeTo(900);
    expect(rail()).toHaveAttribute("data-floating", "true");
    resizeTo(1400);
    expect(rail()).not.toHaveAttribute("data-floating");
  });

  it("closes when the window narrows beside a panel, and reopens once it fits", () => {
    resizeTo(1400);
    // 1400 - 248 (a 240 px workspace panel and its gap) - 304 leaves the chat 848 px: dock.
    render(<AeSessionRail sessionId="s-1" workspacePanelWidth={240} />);
    expect(screen.getByTestId("ae-session-rail")).not.toHaveAttribute("data-floating");
    resizeTo(900);
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
    resizeTo(1400);
    expect(screen.getByTestId("ae-session-rail")).not.toHaveAttribute("data-floating");
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

describe("AeSessionRail slide", () => {
  beforeEach(() => {
    reduceMotion(false);
    vi.useFakeTimers();
  });

  it("slides out after it closes, then unmounts after the workspace panel's 300 ms", () => {
    render(<AeSessionRail sessionId="s-1" />);
    const rail = screen.getByTestId("ae-session-rail");
    expect(rail).toHaveAttribute("data-state", "open");
    expect(rail.style.width).toBe("304px");
    expect(rail).not.toHaveAttribute("inert");
    expect(rail.style.transitionDuration).toBe("300ms");
    act(() => useAeSessionRailStore.getState().setOpen(false));
    expect(rail).toHaveAttribute("data-state", "closed");
    expect(rail).toHaveAttribute("inert");
    expect(rail.style.width).toBe("0px");
    act(() => vi.advanceTimersByTime(299));
    expect(screen.getByTestId("ae-session-rail")).toBe(rail);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
  });

  it("reopened mid-slide, slides back in without remounting", () => {
    render(<AeSessionRail sessionId="s-1" />);
    const rail = screen.getByTestId("ae-session-rail");
    act(() => useAeSessionRailStore.getState().setOpen(false));
    act(() => vi.advanceTimersByTime(150));
    act(() => useAeSessionRailStore.getState().setOpen(true));
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByTestId("ae-session-rail")).toBe(rail);
    expect(rail).toHaveAttribute("data-state", "open");
    expect(rail).not.toHaveAttribute("inert");
    expect(rail.style.width).toBe("304px");
  });

  it("making way for the workspace panel as it slides open, slides out in its own row", () => {
    // 1024 - 220 - 304 leaves the chat 500 px: dock.
    const { rerender } = render(
      <AeSessionRail sessionId="s-1" sidebarWidth={220} workspace={workspace(false)} />,
    );
    // The header toggle opens the panel with its slide.
    rerender(
      <AeSessionRail
        sessionId="s-1"
        sidebarWidth={220}
        workspacePanelWidth={240}
        workspace={workspace(true, true, true)}
      />,
    );
    const rail = screen.getByTestId("ae-session-rail");
    expect(rail).toHaveAttribute("data-state", "closed");
    expect(rail).not.toHaveAttribute("data-floating");
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
  });

  it("leaves at once for a workspace panel a session switch snaps open", () => {
    const { rerender } = render(
      <AeSessionRail sessionId="s-1" sidebarWidth={220} workspace={workspace(false)} />,
    );
    // The switch render still carries s-1's state: a panel just toggled shut is animating.
    rerender(
      <AeSessionRail sessionId="s-2" sidebarWidth={220} workspace={workspace(false, true, true)} />,
    );
    // The shell's restore then opens s-2's panel and cancels the motion in one batch.
    rerender(
      <AeSessionRail
        sessionId="s-2"
        sidebarWidth={220}
        workspacePanelWidth={240}
        workspace={workspace(true)}
      />,
    );
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
    expect(useAeSessionRailStore.getState().closedForPanel).toBe(true);
  });

  it("finishes its slide when the panel's motion flag drops before the rail is gone", () => {
    const props = { sessionId: "s-1", sidebarWidth: 220 };
    const { rerender } = render(<AeSessionRail {...props} workspace={workspace(false)} />);
    rerender(
      <AeSessionRail
        {...props}
        workspacePanelWidth={240}
        workspace={workspace(true, true, true)}
      />,
    );
    const rail = screen.getByTestId("ae-session-rail");
    act(() => vi.advanceTimersByTime(100));
    rerender(<AeSessionRail {...props} workspacePanelWidth={240} workspace={workspace(true)} />);
    expect(screen.getByTestId("ae-session-rail")).toBe(rail);
    expect(rail).toHaveAttribute("data-state", "closed");
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
    expect(useAeSessionRailStore.getState()).toMatchObject({ open: false, closedForPanel: true });
  });

  it("leaves at once when it would float over the panel even on its own", () => {
    // A 600 px sidebar leaves the chat 120 px beside the rail: it floats with no panel.
    const { rerender } = render(<AeSessionRail sessionId="s-1" sidebarWidth={600} />);
    expect(screen.getByTestId("ae-session-rail")).toHaveAttribute("data-floating", "true");
    rerender(<AeSessionRail sessionId="s-1" sidebarWidth={600} workspacePanelWidth={240} />);
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
  });

  it("leaves at once for a files or logs panel, which takes its full width at once", () => {
    resetSharedWidthStoreForTesting();
    const { rerender } = render(<AeSessionRail sessionId="s-1" />);
    // The push panel opens at half of jsdom's 1024 px window, leaving the rail no room.
    rerender(<AeSessionRail sessionId="s-1" pushPanelOpen />);
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
    expect(useAeSessionRailStore.getState().closedForPanel).toBe(true);
  });

  it("leaves at once for a panel that was already open, as when the window narrows", () => {
    resizeTo(1600);
    // 1600 - 220 - 248 - 304 leaves the chat 828 px: both dock.
    render(<AeSessionRail sessionId="s-1" sidebarWidth={220} workspacePanelWidth={240} />);
    expect(screen.getByTestId("ae-session-rail")).not.toHaveAttribute("data-floating");
    // At 1100 px the rail still fits alone (576 px), but beside the panel only 328 px.
    resizeTo(1100);
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
    expect(useAeSessionRailStore.getState().closedForPanel).toBe(true);
  });

  it("never shows beside a panel it cannot fit when both open with the page", () => {
    render(<AeSessionRail sessionId="s-1" sidebarWidth={220} workspacePanelWidth={240} />);
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
    expect(useAeSessionRailStore.getState().closedForPanel).toBe(true);
  });

  it("closed by hand while floating, slides out floating", () => {
    render(<AeSessionRail sessionId="s-1" sidebarWidth={600} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide session rail" }));
    const rail = screen.getByTestId("ae-session-rail");
    expect(rail).toHaveAttribute("data-state", "closed");
    expect(rail).toHaveAttribute("data-floating", "true");
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
  });

  it("hides at once while the right panel is maximized", () => {
    const { rerender } = render(<AeSessionRail sessionId="s-1" />);
    rerender(<AeSessionRail sessionId="s-1" hidden />);
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
  });
});

describe("AeSessionRail in every session", () => {
  beforeEach(() => {
    aeRailForgetRestoredSession();
    useAeSessionRailStore.setState({ openInEverySession: true });
  });

  it("a session switch opens a closed rail", () => {
    useAeSessionRailStore.setState({ open: false });
    const { rerender } = render(<AeSessionRail sessionId="s-1" />);
    expect(useAeSessionRailStore.getState().open).toBe(true);
    act(() => useAeSessionRailStore.getState().toggle());
    expect(screen.queryByTestId("ae-session-rail")).toBeNull();
    rerender(<AeSessionRail sessionId="s-2" />);
    expect(screen.getByTestId("ae-session-rail")).toBeInTheDocument();
  });

  it("closes no panel at the switch; the outgoing session's panel just goes", () => {
    useAeSessionRailStore.setState({ open: false });
    const shell = workspace(true);
    const closePushPanels = vi.fn();
    const props = { sidebarWidth: 220, workspace: shell, closePushPanels };
    const { rerender } = render(
      <AeSessionRail sessionId="s-1" workspacePanelWidth={240} {...props} />,
    );
    rerender(<AeSessionRail sessionId="s-2" workspacePanelWidth={240} {...props} />);
    // The shell restores s-2 with its panel closed.
    rerender(<AeSessionRail sessionId="s-2" {...props} workspace={workspace(false)} />);
    expect(useAeSessionRailStore.getState()).toMatchObject({ open: true, closedForPanel: false });
    expect(shell.toggle).not.toHaveBeenCalled();
    expect(closePushPanels).not.toHaveBeenCalled();
  });

  it("leaves the rail alone when a new chat's temp id becomes its own server id", () => {
    useAeSessionRailStore.setState({ open: false });
    aeRailRestoredPanelOpen("temp:abc", false, { sidebarWidth: 0 });
    aeRecordTempPromotion("temp:abc", "s-new");
    render(<AeSessionRail sessionId="s-new" />);
    expect(useAeSessionRailStore.getState().open).toBe(false);
  });

  it("opens the rail when an unsent new chat gives way to an unrelated session", () => {
    useAeSessionRailStore.setState({ open: false });
    aeRailRestoredPanelOpen("temp:unsent", false, { sidebarWidth: 0 });
    render(<AeSessionRail sessionId="s-b" />);
    expect(useAeSessionRailStore.getState().open).toBe(true);
  });

  it("opens the rail for a session opened from home", () => {
    useAeSessionRailStore.setState({ open: false });
    aeRailRestoredPanelOpen("temp:abc", false, { sidebarWidth: 0 });
    aeRecordTempPromotion("temp:abc", "s-new");
    aeRailForgetRestoredSession();
    render(<AeSessionRail sessionId="s-new" />);
    expect(useAeSessionRailStore.getState().open).toBe(true);
  });

  it("gives way to a panel a URL asks for when the two do not fit", () => {
    useAeSessionRailStore.setState({ open: false });
    const { rerender } = render(<AeSessionRail sessionId="s-1" sidebarWidth={220} />);
    rerender(<AeSessionRail sessionId="s-2" sidebarWidth={220} />);
    const linked = workspace(true);
    rerender(
      <AeSessionRail
        sessionId="s-2"
        sidebarWidth={220}
        workspacePanelWidth={240}
        workspace={linked}
      />,
    );
    expect(useAeSessionRailStore.getState()).toMatchObject({ open: false, closedForPanel: true });
    expect(linked.toggle).not.toHaveBeenCalled();
  });

  it("a panel opened later still swaps with the rail, which is back at the next switch", () => {
    const { rerender } = render(
      <AeSessionRail sessionId="s-1" sidebarWidth={220} workspace={workspace(false)} />,
    );
    rerender(
      <AeSessionRail
        sessionId="s-1"
        sidebarWidth={220}
        workspacePanelWidth={240}
        workspace={workspace(true)}
      />,
    );
    expect(useAeSessionRailStore.getState()).toMatchObject({ open: false, closedForPanel: true });
    rerender(<AeSessionRail sessionId="s-2" sidebarWidth={220} workspace={workspace(false)} />);
    expect(screen.getByTestId("ae-session-rail")).toBeInTheDocument();
  });

  it("does nothing on a phone", () => {
    isMobileMock.mockReturnValue(true);
    useAeSessionRailStore.setState({ open: false });
    const { rerender } = render(<AeSessionRail sessionId="s-1" />);
    rerender(<AeSessionRail sessionId="s-2" />);
    expect(useAeSessionRailStore.getState()).toMatchObject({ open: false, sheetOpen: false });
  });

  it("off: a switch leaves a closed rail closed", () => {
    useAeSessionRailStore.setState({ openInEverySession: false, open: false });
    const { rerender } = render(<AeSessionRail sessionId="s-3" />);
    rerender(<AeSessionRail sessionId="s-4" />);
    expect(useAeSessionRailStore.getState().open).toBe(false);
  });
});

describe("workspaceTabOpener", () => {
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
