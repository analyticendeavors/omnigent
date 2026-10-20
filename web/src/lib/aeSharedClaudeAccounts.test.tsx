import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectedCredential } from "@/hooks/useHosts";
import {
  AeSharedAccountMarker,
  aeFetchSharedClaudeAccounts,
  aeIsSharedAccount,
  aeMergeSharedClaudeAccounts,
} from "./aeSharedClaudeAccounts";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

const DEFAULT: DetectedCredential = { family: "claude-oauth", source: "Default", env_var: "" };
const TEAM_LOCAL: DetectedCredential = { family: "claude-oauth", source: "Team", env_var: "Team" };
const TEAM = { name: "Team", account: "shared:Team", label: "Company Max" };

describe("aeIsSharedAccount", () => {
  it("knows a shared id from a host name", () => {
    expect(aeIsSharedAccount("shared:Team")).toBe(true);
    expect(aeIsSharedAccount("Team")).toBe(false);
    expect(aeIsSharedAccount("")).toBe(false);
    expect(aeIsSharedAccount(null)).toBe(false);
  });
});

describe("aeMergeSharedClaudeAccounts", () => {
  it("lists shared accounts after the host's own, a same-named host login kept apart", () => {
    expect(aeMergeSharedClaudeAccounts([DEFAULT, TEAM_LOCAL], [TEAM])).toEqual([
      DEFAULT,
      TEAM_LOCAL,
      { family: "claude-oauth", source: "Company Max", env_var: "shared:Team" },
    ]);
  });

  it("keeps the host's selection of a shared account under the server's label", () => {
    const selected = {
      family: "claude-oauth-active",
      source: "Team (shared)",
      env_var: "shared:Team",
    };
    expect(aeMergeSharedClaudeAccounts([DEFAULT, selected], [TEAM])).toEqual([
      DEFAULT,
      { family: "claude-oauth-active", source: "Company Max", env_var: "shared:Team" },
    ]);
  });

  it("keeps a selected shared account the server no longer lists", () => {
    const gone = { family: "claude-oauth-active", source: "Old (shared)", env_var: "shared:Old" };
    expect(aeMergeSharedClaudeAccounts([DEFAULT, gone], [TEAM])).toEqual([
      DEFAULT,
      gone,
      { family: "claude-oauth", source: "Company Max", env_var: "shared:Team" },
    ]);
  });

  it("adds nothing to a host that lists no Claude logins", () => {
    const other = { family: "openai", source: "$OPENAI_API_KEY", env_var: "OPENAI_API_KEY" };
    expect(aeMergeSharedClaudeAccounts([other], [TEAM])).toEqual([other]);
    expect(aeMergeSharedClaudeAccounts([], [TEAM])).toEqual([]);
  });
});

describe("aeFetchSharedClaudeAccounts", () => {
  it("reads names and labels from the server, dropping anything malformed", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accounts: [TEAM, { name: "x", account: "x", label: "No prefix" }, null],
          can_manage: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(aeFetchSharedClaudeAccounts()).resolves.toEqual([TEAM]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/ae/claude-accounts/shared");
  });

  it("is empty when the server refuses or cannot be reached", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    await expect(aeFetchSharedClaudeAccounts()).resolves.toEqual([]);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await expect(aeFetchSharedClaudeAccounts()).resolves.toEqual([]);
  });
});

describe("AeSharedAccountMarker", () => {
  it("shows the word Shared beside a Tabler icon", () => {
    render(<AeSharedAccountMarker />);
    const marker = screen.getByTestId("ae-shared-account-marker");
    expect(marker).toHaveTextContent(/^Shared$/);
    expect(marker.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
