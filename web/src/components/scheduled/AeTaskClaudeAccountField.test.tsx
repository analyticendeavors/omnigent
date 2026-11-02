import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AeTaskClaudeAccountField } from "@/components/scheduled/AeTaskClaudeAccountField";
import {
  DEFAULT_LOGIN_ACCOUNT,
  FOLLOW_ACTIVE_ACCOUNT,
  accountChoiceFor,
  claudeAccountInput,
} from "@/lib/aeTaskClaudeAccount";

const { detected } = vi.hoisted(() => ({
  detected: {
    rows: [] as { family: string; env_var: string; source: string }[],
  },
}));
vi.mock("@/hooks/useHosts", () => ({
  useDetectedCredentials: () => ({ data: detected.rows }),
}));

beforeEach(() => {
  detected.rows = [
    { family: "claude-oauth", env_var: "", source: "AE Default" },
    { family: "claude-oauth", env_var: "shared:AE Backup", source: "AE Backup" },
  ];
});

describe("accountChoiceFor", () => {
  it("maps no pin, the default login and a named account", () => {
    expect(accountChoiceFor(null)).toBe(FOLLOW_ACTIVE_ACCOUNT);
    expect(accountChoiceFor(undefined)).toBe(FOLLOW_ACTIVE_ACCOUNT);
    expect(accountChoiceFor("")).toBe(DEFAULT_LOGIN_ACCOUNT);
    expect(accountChoiceFor("shared:AE Backup")).toBe("shared:AE Backup");
  });
});

describe("claudeAccountInput", () => {
  it("omits the key on create when following the active account", () => {
    expect(claudeAccountInput(FOLLOW_ACTIVE_ACCOUNT, undefined, false)).toEqual({});
  });
  it("pins the default login as an empty string", () => {
    expect(claudeAccountInput(DEFAULT_LOGIN_ACCOUNT, undefined, false)).toEqual({
      claudeAccount: "",
    });
  });
  it("sends nothing on edit when the pick did not change", () => {
    expect(claudeAccountInput(DEFAULT_LOGIN_ACCOUNT, "", true)).toEqual({});
    expect(claudeAccountInput(FOLLOW_ACTIVE_ACCOUNT, null, true)).toEqual({});
  });
  it("clears the pin on edit with null", () => {
    expect(claudeAccountInput(FOLLOW_ACTIVE_ACCOUNT, "shared:AE Backup", true)).toEqual({
      claudeAccount: null,
    });
  });
});

describe("AeTaskClaudeAccountField", () => {
  it("shows the pinned account and the keep-pinned hint", () => {
    render(
      <AeTaskClaudeAccountField value="shared:AE Backup" onValueChange={() => {}} hostId="h1" />,
    );
    expect(screen.getByTestId("task-claude-account-trigger")).toBeTruthy();
    expect(screen.getByText(/even when the host switches/)).toBeTruthy();
  });
  it("explains that following the active account has no pin", () => {
    render(
      <AeTaskClaudeAccountField
        value={FOLLOW_ACTIVE_ACCOUNT}
        onValueChange={() => {}}
        hostId="h1"
      />,
    );
    expect(screen.getByText(/whichever Claude account the host has active/)).toBeTruthy();
  });
  it("never renders a blank trigger for a default-login pin the host does not list", () => {
    detected.rows = [{ family: "claude-oauth", env_var: "shared:AE Backup", source: "AE Backup" }];
    render(
      <AeTaskClaudeAccountField
        value={DEFAULT_LOGIN_ACCOUNT}
        onValueChange={() => {}}
        hostId="h1"
      />,
    );
    expect(screen.getByTestId("task-claude-account-trigger").textContent).toContain(
      "Default login (not listed)",
    );
  });
});
