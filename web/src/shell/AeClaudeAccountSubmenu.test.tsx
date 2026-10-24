import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AeClaudeAccountSubmenu } from "./AeClaudeAccountSubmenu";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import type { Host } from "@/hooks/useHosts";

const mutate = vi.fn();
let rows = [
  { family: "claude-oauth-active", source: "AE Default", env_var: "" },
  { family: "claude-oauth", source: "AE Backup", env_var: "AE Backup" },
  { family: "claude-oauth", source: "AE Backup", env_var: "shared:AE Backup" },
];
let isPending = false;
let isError = false;
vi.mock("@/hooks/useHosts", () => ({
  useDetectedCredentials: () => ({
    data: isError ? undefined : rows,
    isError,
    isSuccess: !isError,
  }),
  useStoreCredential: () => ({ mutate, isPending }),
}));
const host = { host_id: "host", name: "Laptop" } as Host;

function renderMenu() {
  return render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <AeClaudeAccountSubmenu host={host} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

function openSubmenu() {
  fireEvent.keyDown(screen.getByTestId("composer-claude-account"), { key: "ArrowRight" });
}

beforeEach(() => {
  mutate.mockReset();
  isPending = false;
  isError = false;
  rows = [
    { family: "claude-oauth-active", source: "AE Default", env_var: "" },
    { family: "claude-oauth", source: "AE Backup", env_var: "AE Backup" },
    { family: "claude-oauth", source: "AE Backup", env_var: "shared:AE Backup" },
  ];
});

describe("AeClaudeAccountSubmenu", () => {
  it("shows one Account row naming the new-chat login, with the logins one level down", () => {
    renderMenu();
    const row = screen.getByTestId("composer-claude-account");
    expect(row).toHaveTextContent("Account");
    expect(screen.getByTestId("composer-claude-account-value")).toHaveTextContent("AE Default");
    expect(screen.queryByTestId("composer-claude-account-default")).toBeNull();

    expect(row).toHaveAttribute(
      "title",
      "For new chats. This chat keeps the login it started with.",
    );
    openSubmenu();
    expect(screen.getByTestId("composer-claude-account-scope")).toHaveTextContent("For new chats");
    // The hint wraps under the rows instead of setting the submenu's width.
    expect(screen.getByTestId("composer-claude-account-scope")).toHaveClass("w-0", "min-w-full");
    expect(
      screen.getByTestId("composer-claude-account-scope").closest('[role="menu"]'),
    ).toHaveClass("w-max");
    expect(screen.getByTestId("composer-claude-account-default")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("composer-claude-account-AE Backup")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    // The shared login of the same name carries the Shared tag.
    expect(screen.getByTestId("composer-claude-account-shared:AE Backup")).toHaveTextContent(
      "Shared",
    );
    expect(screen.getByTestId("composer-claude-account-AE Backup")).not.toHaveTextContent("Shared");
  });

  it("selects a login through the host's own select write", () => {
    renderMenu();
    openSubmenu();
    fireEvent.click(screen.getByTestId("composer-claude-account-AE Backup"));
    expect(mutate).toHaveBeenCalledWith(
      { harness: "claude-native", kind: "claude-oauth-select", account_name: "AE Backup" },
      expect.anything(),
    );
  });

  it("shows the server's refusal under the rows", () => {
    mutate.mockImplementation((_input, { onError }) => onError(new Error("Host offline")));
    renderMenu();
    openSubmenu();
    fireEvent.click(screen.getByTestId("composer-claude-account-shared:AE Backup"));
    expect(screen.getByRole("alert")).toHaveTextContent("Host offline");
  });

  it("keeps the current login unselectable and every row still while a write runs", () => {
    isPending = true;
    renderMenu();
    openSubmenu();
    expect(screen.getByTestId("composer-claude-account-default")).toHaveAttribute("data-disabled");
    expect(screen.getByTestId("composer-claude-account-AE Backup")).toHaveAttribute(
      "data-disabled",
    );
  });

  it("says when the host's logins could not be read", () => {
    isError = true;
    renderMenu();
    expect(screen.getByTestId("composer-claude-account-value")).toHaveTextContent("Unavailable");
    openSubmenu();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load Claude accounts");
  });

  it("treats a read with no Claude login as unavailable, not as loading", () => {
    rows = [];
    renderMenu();
    expect(screen.getByTestId("composer-claude-account-value")).toHaveTextContent("Unavailable");
    openSubmenu();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load Claude accounts");
  });

  it("renders nothing without a host", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuContent>
          <AeClaudeAccountSubmenu host={null} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(screen.queryByTestId("composer-claude-account")).toBeNull();
  });
});
