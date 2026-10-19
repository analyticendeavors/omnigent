// Tests for Settings > Chat (omnigent-ae, 2026-10-18): the "open the session
// rail in every session" switch reads and writes the rail store, and
// /settings/chat routes to the section, with a nav item after Appearance.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  useAeSessionRailStore.setState({ openInEverySession: true });
});

afterEach(() => {
  cleanup();
});

describe("AeChatSettingsSection", () => {
  it("shows the switch on by default and writes the choice to the rail store and storage", () => {
    renderAt("/settings/chat", <AeChatSettingsSection />);
    const toggle = screen.getByRole("switch", { name: "Open the session rail in every session" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(useAeSessionRailStore.getState().openInEverySession).toBe(false);
    const saved = JSON.parse(window.localStorage.getItem("ae.sessionRail.v1") ?? "{}");
    expect(saved.openInEverySession).toBe(false);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("follows the store when the preference changes elsewhere", () => {
    renderAt("/settings/chat", <AeChatSettingsSection />);
    const toggle = screen.getByTestId("ae-open-rail-every-session");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(useAeSessionRailStore.getState().openInEverySession).toBe(true);
  });

  it("is what /settings/chat renders", () => {
    renderAt("/settings/chat", <SettingsPage />);
    expect(screen.getByTestId("ae-chat-settings")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chat" })).toBeInTheDocument();
  });

  it("has a nav item right after Appearance, shown on phones too", () => {
    const general = settingsNavGroups(false, false)[0]!;
    const ids = general.items.map((i) => i.id);
    expect(ids[ids.indexOf("appearance") + 1]).toBe("chat");
    renderAt("/settings/chat", <SettingsSidebarBody onNavClick={vi.fn()} />);
    const link = screen.getByTestId("settings-nav-chat");
    expect(link).toHaveTextContent("Chat");
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link.querySelector("svg")).toHaveClass("ui-icon");
    expect(link.className).not.toContain("max-md:hidden");
  });
});
