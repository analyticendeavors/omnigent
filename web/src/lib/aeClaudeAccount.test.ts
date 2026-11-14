import type { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AE_ACCOUNT_FOLLOW_UP_DELAYS_MS,
  aeChatAccount,
  aeChatAccountSettled,
  aeMoveAllSummary,
  aeRefreshChatAccountSoon,
  aeSwitchSummary,
} from "./aeClaudeAccount";
import { aeOtherClaudeAccounts } from "./aeLimitGate";

describe("aeChatAccount", () => {
  it("prefers the last launch over a stored pick, as the server does", () => {
    expect(aeChatAccount({ "ae.claude_account": "B" })).toBe("B");
    // A pick stored while the chat was not running is not its login until it starts.
    expect(aeChatAccount({ "omnigent.claude_native.account": "", "ae.claude_account": "B" })).toBe(
      "B",
    );
    expect(aeChatAccount({ "ae.claude_account": "", "omnigent.claude_native.account": "B" })).toBe(
      "",
    );
    expect(aeChatAccount({ "omnigent.claude_native.account": "" })).toBe("");
    expect(aeChatAccount({})).toBeUndefined();
    expect(aeChatAccount(null)).toBeUndefined();
  });
});

describe("aeChatAccountSettled", () => {
  it("is true only when the chat runs on the login and has no other one stored", () => {
    expect(aeChatAccountSettled({ "ae.claude_account": "B" }, "B")).toBe(true);
    expect(
      aeChatAccountSettled(
        { "omnigent.claude_native.account": "B", "ae.claude_account": "B" },
        "B",
      ),
    ).toBe(true);
    // Running on B with the default stored: picking B again puts B back as the stored login.
    expect(
      aeChatAccountSettled({ "omnigent.claude_native.account": "", "ae.claude_account": "B" }, "B"),
    ).toBe(false);
    expect(aeChatAccountSettled({ "ae.claude_account": "B" }, "")).toBe(false);
    expect(aeChatAccountSettled({}, "")).toBe(false);
  });
});

describe("aeMoveAllSummary", () => {
  const row = (id: string, reason: string) => ({ id, title: `Chat ${id}`, reason });

  it("counts moved and stored chats together and names the login", () => {
    expect(
      aeMoveAllSummary(
        {
          moved: ["a"],
          skipped: [],
          pending: [],
          queued: [row("b", "starts at its next message"), row("c", "starts at its next message")],
        },
        "Backup",
      ),
    ).toBe("Moved 3 chats to Backup");
    expect(aeMoveAllSummary({ moved: ["a"], skipped: [], pending: [] }, "Backup")).toBe(
      "Moved 1 chat to Backup",
    );
  });

  it("adds the chats that move when their reply ends, and leaves out zero parts", () => {
    expect(
      aeMoveAllSummary(
        { moved: ["a", "b"], skipped: [], pending: [row("c", "moves when its reply ends")] },
        "Backup",
      ),
    ).toBe("Moved 2 chats to Backup; 1 move when their reply ends");
    expect(
      aeMoveAllSummary(
        { moved: [], skipped: [], pending: [row("c", "moves when its reply ends")] },
        "Backup",
      ),
    ).toBe("1 move when their reply ends");
  });

  it("words a chat the server was still switching apart from one waiting on its reply", () => {
    expect(
      aeMoveAllSummary(
        {
          moved: ["a"],
          skipped: [],
          pending: [row("c", "moves when its reply ends"), row("d", "still switching")],
        },
        "Backup",
      ),
    ).toBe("Moved 1 chat to Backup; 1 move when their reply ends; 1 still switching");
  });

  it("counts many skipped chats by reason and says when the list was cut", () => {
    const pinned = ["a", "b", "c", "d"].map((id) => row(id, "pinned by its scheduled task"));
    expect(
      aeMoveAllSummary(
        { moved: [], skipped: [...pinned, row("e", "Offline")], pending: [], truncated: true },
        "Backup",
      ),
    ).toBe(
      "5 skipped: 4 pinned by its scheduled task, 1 Offline; too many chats to list: run it again if some did not move",
    );
  });

  it("names a chat that failed for a real reason", () => {
    expect(
      aeMoveAllSummary(
        {
          moved: ["a"],
          skipped: [row("b", "Claude account selection requires a connected host.")],
          pending: [],
        },
        "Backup",
      ),
    ).toBe(
      "Moved 1 chat to Backup; 1 skipped: Chat b: Claude account selection requires a connected host.",
    );
  });

  it("says so when nothing needed moving", () => {
    expect(aeMoveAllSummary({ moved: [], skipped: [], pending: [] }, "Backup")).toBe(
      "No chats needed moving",
    );
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

describe("aeSwitchSummary", () => {
  const own = { account: "B", relaunched: true };

  it("is the plain line when the children were not asked for", () => {
    expect(aeSwitchSummary("Backup", own)).toBe("This chat now runs on Backup.");
  });

  it("names the children that start on the login at their next message", () => {
    expect(
      aeSwitchSummary("Backup", {
        ...own,
        children: {
          moved: [{ id: "c", title: "C" }],
          skipped: [],
          pending: [],
          queued: [{ id: "d", title: "D", reason: "starts at its next message" }],
        },
      }),
    ).toBe(
      "This chat now runs on Backup; 1 child chat moved; 1 child chat starts on Backup at its next message",
    );
  });

  it("says the chat starts on the login next time when no terminal was running", () => {
    expect(aeSwitchSummary("Backup", { account: "B", relaunched: false, queued: true })).toBe(
      "This chat starts on Backup at its next message.",
    );
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
