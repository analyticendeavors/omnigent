// Tests for Settings > Chat: the session open view cards read and write the rail store,
// and /settings/chat routes to the section, with a nav item after Appearance.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";

vi.mock("@/lib/CapabilitiesContext", () => ({
  useServerInfo: () => ({ accounts_enabled: false, login_url: null, single_user: true }),
}));
vi.mock("@/hooks/useIsAdmin", () => ({ useIsAdmin: () => false }));
vi.mock("@/lib/identity", () => ({
  resolveIdentity: () => Promise.resolve(null),
  getCurrentIsAdmin: () => false,
  getCurrentUserId: () => null,
}));

import { SettingsPage } from "@/pages/SettingsPage";
import { SettingsSidebarBody, settingsNavGroups } from "@/shell/settingsNav";
import { AeChatSettingsSection } from "./AeChatSettingsSection";

function renderAt(path: string, node: React.ReactNode) {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </TooltipProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useAeSessionRailStore.setState({ sessionOpenView: "rail" });
});

afterEach(() => {
  cleanup();
});

describe("AeChatSettingsSection", () => {
  it("offers three choices under one label, the session rail checked", () => {
    renderAt("/settings/chat", <AeChatSettingsSection />);
    const group = screen.getByRole("radiogroup", { name: "When a session opens, show" });
    const names = within(group)
      .getAllByRole("radio")
      .map((radio) => radio.textContent);
    expect(names).toEqual(["Session rail", "Both when they fit", "Workspace panel"]);
    expect(screen.getByRole("radio", { name: "Session rail" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("writes each choice to the rail store and storage", () => {
    renderAt("/settings/chat", <AeChatSettingsSection />);
    for (const [view, name] of [
      ["both", "Both when they fit"],
      ["panel", "Workspace panel"],
      ["rail", "Session rail"],
    ] as const) {
      fireEvent.click(screen.getByTestId(`ae-session-open-view-${view}`));
      expect(useAeSessionRailStore.getState().sessionOpenView).toBe(view);
      const saved = JSON.parse(window.localStorage.getItem("ae.sessionRail.v1") ?? "{}");
      expect(saved.sessionOpenView).toBe(view);
      expect(screen.getByRole("radio", { name })).toHaveAttribute("aria-checked", "true");
    }
  });

  it("follows the store when the choice changes elsewhere", () => {
    renderAt("/settings/chat", <AeChatSettingsSection />);
    act(() => useAeSessionRailStore.getState().setSessionOpenView("panel"));
    expect(screen.getByTestId("ae-session-open-view-panel")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("is what /settings/chat renders", () => {
    renderAt("/settings/chat", <SettingsPage />);
    expect(screen.getByTestId("ae-chat-settings")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chat" })).toBeInTheDocument();
  });

  it("has a nav item between Appearance and Git, shown on phones too", () => {
    const general = settingsNavGroups(false, false)[0]!;
    const ids = general.items.map((i) => i.id);
    // Upstream slots Harnesses (and Sandbox Integrations) in right after Appearance.
    expect(ids.indexOf("chat")).toBeGreaterThan(ids.indexOf("appearance"));
    expect(ids.indexOf("chat")).toBeLessThan(ids.indexOf("git"));
    renderAt("/settings/chat", <SettingsSidebarBody onNavClick={vi.fn()} />);
    const link = screen.getByTestId("settings-nav-chat");
    expect(link).toHaveTextContent("Chat");
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link.querySelector("svg")).toHaveClass("ui-icon");
    expect(link.className).not.toContain("max-md:hidden");
  });
});
