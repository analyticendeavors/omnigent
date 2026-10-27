import { describe, expect, it } from "vitest";
import { aeChatAccount, aeMoveAllSummary } from "./aeClaudeAccount";
import { aeOtherClaudeAccounts } from "./aeLimitGate";
import { askAeMoveAll, dismissAeMoveAll } from "./aeMoveAllChats";

describe("aeChatAccount", () => {
  it("prefers the stored pick over the last launch, and treats an empty pick as the default", () => {
    expect(aeChatAccount({ "ae.claude_account": "B" })).toBe("B");
    expect(aeChatAccount({ "omnigent.claude_native.account": "", "ae.claude_account": "B" })).toBe(
      "",
    );
    expect(aeChatAccount({})).toBeUndefined();
    expect(aeChatAccount(null)).toBeUndefined();
  });
});

describe("aeMoveAllSummary", () => {
  it("names the moved count and each skipped chat", () => {
    expect(
      aeMoveAllSummary({
        moved: ["a"],
        skipped: [
          { id: "b", title: "Fix CI", reason: "mid-reply" },
          { id: "c", title: "Docs", reason: "Claude account selection requires a connected host." },
        ],
        pending: [],
      }),
    ).toBe(
      "Moved 1 chat; 2 skipped: Fix CI is mid-reply, Docs: Claude account selection requires a connected host.",
    );
    expect(aeMoveAllSummary({ moved: ["a", "b"], skipped: [], pending: [] })).toBe("Moved 2 chats");
  });
});

describe("aeOtherClaudeAccounts", () => {
  const rows = [
    { family: "claude-oauth-active", source: "AE Default", env_var: "" },
    { family: "claude-oauth", source: "Backup", env_var: "Backup" },
  ];
  it("lists the logins other than the chat's own, else other than the selected one", () => {
    expect(aeOtherClaudeAccounts(rows, "Backup")).toEqual([{ account: "", label: "AE Default" }]);
    expect(aeOtherClaudeAccounts(rows, undefined)).toEqual([
      { account: "Backup", label: "Backup" },
    ]);
  });
  it("lists none on provider credentials", () => {
    expect(aeOtherClaudeAccounts([...rows, { family: "claude-provider-env" }], "")).toEqual([]);
  });
});

describe("askAeMoveAll", () => {
  it("is a store the shell's dialog reads", () => {
    askAeMoveAll({ account: "", label: "AE Default", hostId: undefined });
    dismissAeMoveAll();
  });
});
