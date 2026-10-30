import type { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AE_ACCOUNT_FOLLOW_UP_DELAYS_MS,
  aeChatAccount,
  aeMoveAllSummary,
  aeRefreshChatAccountSoon,
  aeSwitchSummary,
} from "./aeClaudeAccount";
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

describe("aeSwitchSummary", () => {
  const own = { account: "B", relaunched: true };

  it("is the plain line when the children were not asked for", () => {
    expect(aeSwitchSummary("Backup", own)).toBe("This chat now runs on Backup.");
  });

  it("counts moved children and names each skipped or slow one", () => {
    expect(
      aeSwitchSummary("Backup", {
        ...own,
        children: {
          moved: [
            { id: "a", title: "Builder" },
            { id: "b", title: "Docs" },
          ],
          skipped: [{ id: "c", title: "Reviewer", reason: "mid-reply" }],
          pending: [{ id: "d", title: "Slow", reason: "still switching" }],
        },
      }),
    ).toBe(
      "This chat now runs on Backup; 2 child chats moved; 1 still switching: Slow; 1 skipped: Reviewer is mid-reply",
    );
  });

  it("says the children were not switched when the cascade failed", () => {
    expect(
      aeSwitchSummary("Backup", {
        ...own,
        children: { moved: [], skipped: [], pending: [], error: "children not attempted" },
      }),
    ).toBe("This chat now runs on Backup; its child chats were not switched");
  });

  it("says nothing extra when no child needed a move, and keeps a skip's own reason", () => {
    const none = { moved: [], skipped: [], pending: [] };
    expect(aeSwitchSummary("Backup", { ...own, children: none })).toBe(
      "This chat now runs on Backup",
    );
    expect(
      aeSwitchSummary("Backup", {
        ...own,
        children: {
          ...none,
          moved: [{ id: "a", title: "Builder" }],
          skipped: [{ id: "c", title: "Docs", reason: "needs a host" }],
        },
      }),
    ).toBe("This chat now runs on Backup; 1 child chat moved; 1 skipped: Docs: needs a host");
  });
});

describe("aeRefreshChatAccountSoon", () => {
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  const limitsCalls = (spy: ReturnType<typeof vi.fn>, id: string) =>
    spy.mock.calls.filter(
      ([arg]) => arg?.queryKey?.[0] === "ae-limits" && arg?.queryKey?.[1] === id,
    ).length;
  const fake = () => {
    vi.useFakeTimers();
    const invalidate = vi.fn();
    return { invalidate, client: { invalidateQueries: invalidate } as unknown as QueryClient };
  };

  it("re-reads the chat and its Usage numbers at each follow-up delay, and nothing before", () => {
    const { invalidate, client } = fake();
    aeRefreshChatAccountSoon(client, "s1");
    expect(invalidate).not.toHaveBeenCalled();
    AE_ACCOUNT_FOLLOW_UP_DELAYS_MS.forEach((delay, n) => {
      vi.advanceTimersByTime(n === 0 ? delay : delay - AE_ACCOUNT_FOLLOW_UP_DELAYS_MS[n - 1]);
      expect(limitsCalls(invalidate, "s1")).toBe(n + 1);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["session", "s1"] });
    expect(AE_ACCOUNT_FOLLOW_UP_DELAYS_MS.at(-1)).toBe(60000);
  });

  it("stops re-reading once cancelled", () => {
    const { invalidate, client } = fake();
    const cancel = aeRefreshChatAccountSoon(client, "s1");
    vi.advanceTimersByTime(AE_ACCOUNT_FOLLOW_UP_DELAYS_MS[0]);
    cancel();
    vi.advanceTimersByTime(120_000);
    expect(limitsCalls(invalidate, "s1")).toBe(1);
  });

  it("replaces an earlier schedule for the same chat and keeps other chats' own", () => {
    const { invalidate, client } = fake();
    aeRefreshChatAccountSoon(client, "s1");
    aeRefreshChatAccountSoon(client, "s2");
    vi.advanceTimersByTime(3000);
    aeRefreshChatAccountSoon(client, "s1");
    vi.advanceTimersByTime(120_000);
    // s1: one re-read from the first schedule (2 s), then a full second schedule.
    expect(limitsCalls(invalidate, "s1")).toBe(1 + AE_ACCOUNT_FOLLOW_UP_DELAYS_MS.length);
    expect(limitsCalls(invalidate, "s2")).toBe(AE_ACCOUNT_FOLLOW_UP_DELAYS_MS.length);
  });

  it("schedules nothing without a session", () => {
    const { client } = fake();
    aeRefreshChatAccountSoon(client, null);
    expect(vi.getTimerCount()).toBe(0);
  });
});
