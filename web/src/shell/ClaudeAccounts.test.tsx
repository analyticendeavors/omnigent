import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAccounts } from "./ClaudeAccounts";
import type { Host } from "@/hooks/useHosts";

const mutate = vi.fn();
vi.mock("@/hooks/useHosts", () => ({
  useDetectedCredentials: () => ({
    data: [
      { family: "claude-oauth-active", source: "Default CLI account", env_var: "" },
      { family: "claude-oauth", source: "Backup", env_var: "Backup" },
    ],
  }),
  useStoreCredential: () => ({ mutate, isPending: false }),
}));
const host = { host_id: "host", name: "Laptop" } as Host;
beforeEach(() => mutate.mockReset());
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
});
