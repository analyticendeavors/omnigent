import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAccounts } from "./ClaudeAccounts";
import type { Host } from "@/hooks/useHosts";

const mutate = vi.fn();
let rows = [
  { family: "claude-oauth-active", source: "Default CLI account", env_var: "" },
  { family: "claude-oauth", source: "Backup", env_var: "Backup" },
];
let isPending = false;
vi.mock("@/hooks/useHosts", () => ({
  useDetectedCredentials: () => ({ data: rows }),
  useStoreCredential: () => ({ mutate, isPending }),
}));
const host = { host_id: "host", name: "Laptop" } as Host;
beforeEach(() => {
  mutate.mockReset();
  rows = [
    { family: "claude-oauth-active", source: "Default CLI account", env_var: "" },
    { family: "claude-oauth", source: "Backup", env_var: "Backup" },
  ];
  isPending = false;
});
describe("ClaudeAccounts", () => {
  it("selects the backup account without a token", () => {
    render(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByText("Backup"));
    expect(mutate.mock.calls[0][0]).toEqual({
      harness: "claude-native",
      kind: "claude-oauth-select",
      account_name: "Backup",
    });
    expect(screen.getByText(/Start a new chat/)).toBeTruthy();
  });
  it("adds a named OAuth token through the credential endpoint", () => {
    render(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByText("Add Claude account"));
    fireEvent.change(screen.getByLabelText("Claude account name"), {
      target: { value: "Personal" },
    });
    fireEvent.change(screen.getByLabelText("Claude OAuth token"), {
      target: { value: "sk-ant-oat-example" },
    });
    fireEvent.click(screen.getByText("Save account"));
    expect(mutate.mock.calls[0][0]).toEqual({
      harness: "claude-native",
      kind: "claude-oauth-add",
      account_name: "Personal",
      secret: "sk-ant-oat-example",
    });
  });
  it("renames the default account using its empty stable ID", () => {
    render(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Default CLI account" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Account label for Default CLI account" }),
      {
        target: { value: "  Main  " },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(mutate.mock.calls[0][0]).toEqual({
      harness: "claude-native",
      kind: "claude-oauth-rename",
      account_name: "",
      account_label: "Main",
    });
  });
  it("keeps the backup stable ID for selection after its label changes", () => {
    const view = render(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Backup" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Account label for Backup" }), {
      target: { value: "Work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(mutate.mock.calls[0][0]).toEqual({
      harness: "claude-native",
      kind: "claude-oauth-rename",
      account_name: "Backup",
      account_label: "Work",
    });
    act(() => mutate.mock.calls[0][1].onSuccess());
    rows = [rows[0], { ...rows[1], source: "Work" }];
    view.rerender(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(mutate.mock.calls[1][0]).toEqual({
      harness: "claude-native",
      kind: "claude-oauth-select",
      account_name: "Backup",
    });
    expect(screen.getByRole("button", { name: "Default CLI account (selected)" })).toBeDisabled();
  });
  it("cancels a rename without sending a mutation", () => {
    render(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Backup" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Account label for Backup" }), {
      target: { value: "Work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Account label for Backup" })).toBeNull();
    expect(screen.getByRole("button", { name: "Backup" })).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });
  it("keeps the editor open and shows a rename failure", () => {
    render(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Backup" }));
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    act(() => mutate.mock.calls[0][1].onError(new Error("Could not save account name.")));
    expect(screen.getByRole("alert").textContent).toBe("Could not save account name.");
    expect(screen.getByRole("textbox", { name: "Account label for Backup" })).toBeTruthy();
  });
  it("disables account actions while a rename is pending", () => {
    const view = render(<ClaudeAccounts host={host} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Backup" }));
    isPending = true;
    view.rerender(<ClaudeAccounts host={host} />);
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Account label for Backup" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rename Default CLI account" })).toBeDisabled();
  });
});
