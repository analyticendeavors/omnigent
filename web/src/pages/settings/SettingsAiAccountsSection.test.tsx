import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsAiAccountsSection } from "./SettingsAiAccountsSection";

vi.mock("@/hooks/useHosts", () => ({
  useHosts: () => ({
    data: [
      { host_id: "one", name: "Laptop", status: "online" },
      { host_id: "two", name: "Desktop", status: "online" },
      { host_id: "off", name: "Offline host", status: "offline" },
    ],
  }),
}));
vi.mock("@/shell/ClaudeAccounts", () => ({
  ClaudeAccounts: ({ host }: { host: { name: string } }) => <div>Accounts on {host.name}</div>,
}));
describe("AI account settings", () => {
  it("routes account management to the selected online host", () => {
    render(<SettingsAiAccountsSection />);
    expect(screen.getByText("Accounts on Laptop")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "two" } });
    expect(screen.getByText("Accounts on Desktop")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "off" } });
    expect(screen.queryByText("Accounts on Desktop")).toBeNull();
    expect(screen.getByText("Reconnect this host to manage its accounts.")).toBeTruthy();
  });
});
