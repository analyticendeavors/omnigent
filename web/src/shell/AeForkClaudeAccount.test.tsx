import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DetectedCredential } from "@/hooks/useHosts";
import { AeForkClaudeAccount, aeForkClaudeAccounts } from "./AeForkClaudeAccount";

const rows = vi.hoisted(() => ({ value: [] as DetectedCredential[] }));
vi.mock("@/hooks/useHosts", () => ({
  useDetectedCredentials: () => ({ data: rows.value }),
}));

const WORK: DetectedCredential = { family: "claude-oauth", source: "Work", env_var: "Work" };
const DEFAULT: DetectedCredential = {
  family: "claude-oauth-active",
  source: "Default CLI account",
  env_var: null,
};

function openSelect(): void {
  const trigger = screen.getByTestId("fork-session-config-claude-account");
  fireEvent.pointerDown(trigger, new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  fireEvent.click(trigger);
}

describe("aeForkClaudeAccounts", () => {
  it("keeps only Claude subscription logins, the default login as an empty name", () => {
    expect(
      aeForkClaudeAccounts([
        WORK,
        DEFAULT,
        {
          family: "claude-provider-env",
          source: "ANTHROPIC_API_KEY",
          env_var: "ANTHROPIC_API_KEY",
        },
        WORK,
      ]),
    ).toEqual([
      { account: "Work", label: "Work" },
      { account: "", label: "Default CLI account" },
    ]);
  });
});

describe("AeForkClaudeAccount", () => {
  it("renders nothing when the host reports no Claude logins", () => {
    rows.value = [];
    render(
      <AeForkClaudeAccount
        hostId="h"
        currentAccount={undefined}
        value={undefined}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByTestId("fork-session-config-claude-account")).toBeNull();
  });

  it("keeps the source account until another login is picked", () => {
    rows.value = [WORK, DEFAULT];
    const onChange = vi.fn();
    render(
      <AeForkClaudeAccount
        hostId="h"
        currentAccount="Work"
        value={undefined}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("fork-session-config-claude-account")).toHaveTextContent(
      "Same as this session (Work)",
    );
    openSelect();
    fireEvent.click(screen.getByRole("option", { name: "Default CLI account" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("reports a named login", () => {
    rows.value = [WORK, DEFAULT];
    const onChange = vi.fn();
    render(
      <AeForkClaudeAccount
        hostId="h"
        currentAccount={undefined}
        value={undefined}
        onChange={onChange}
      />,
    );
    openSelect();
    fireEvent.click(screen.getByRole("option", { name: "Work" }));
    expect(onChange).toHaveBeenLastCalledWith("Work");
  });

  it("goes back to the source's account", () => {
    rows.value = [WORK, DEFAULT];
    const onChange = vi.fn();
    render(
      <AeForkClaudeAccount
        hostId="h"
        currentAccount={undefined}
        value="Work"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("fork-session-config-claude-account")).toHaveTextContent("Work");
    openSelect();
    fireEvent.click(screen.getByRole("option", { name: "Same as this session" }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("hides on a host signed in with provider credentials and drops the pick", () => {
    rows.value = [
      WORK,
      { family: "claude-provider-env", source: "ANTHROPIC_API_KEY", env_var: "ANTHROPIC_API_KEY" },
    ];
    const onChange = vi.fn();
    render(
      <AeForkClaudeAccount
        hostId="h"
        currentAccount={undefined}
        value="Work"
        onChange={onChange}
      />,
    );
    expect(screen.queryByTestId("fork-session-config-claude-account")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("drops a pick the host no longer lists", () => {
    rows.value = [DEFAULT];
    const onChange = vi.fn();
    render(
      <AeForkClaudeAccount
        hostId="h"
        currentAccount={undefined}
        value="Work"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("fork-session-config-claude-account")).toHaveTextContent(
      "Same as this session",
    );
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("marks a source account the host no longer lists", () => {
    rows.value = [DEFAULT];
    render(
      <AeForkClaudeAccount
        hostId="h"
        currentAccount="Work"
        value={undefined}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("fork-session-config-claude-account")).toHaveTextContent(
      "Same as this session (unavailable)",
    );
  });
});
