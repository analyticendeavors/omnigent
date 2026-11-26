import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/hooks/useConversations";
import {
  aeBadgeCount,
  readAeBadgeScope,
  useAeBadgeScope,
  writeAeBadgeScope,
} from "@/lib/aeBadgeScope";

function row(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    object: "conversation",
    title: id,
    created_at: 1,
    updated_at: 1,
    labels: { "ae.status": "working" },
    permission_level: null,
    ...extra,
  };
}

describe("aeBadgeCount", () => {
  const rows = [
    row("solo"),
    row("child", { parent_session_id: "solo" }),
    row("helper", { labels: { "ae.status": "working", "ae.orch": "solo" } }),
    row("archived", { archived: true }),
    row("parked", { labels: { "ae.status": "parked" } }),
    row("blocked", { pending_elicitations_count: 1 }),
    row("failed", { status: "failed" }),
  ];

  it("top-level matches the slot count and skips children and helpers", () => {
    expect(aeBadgeCount(rows, false, "top-level")).toBe(1);
  });

  it("top-level follows the helpers-count policy", () => {
    expect(aeBadgeCount(rows, true, "top-level")).toBe(2);
  });

  it("all counts working children and helpers, never archived, parked, blocked or failed", () => {
    expect(aeBadgeCount(rows, false, "all")).toBe(3);
  });

  it("counts a session listed twice once", () => {
    expect(aeBadgeCount([row("a"), row("a")], false, "all")).toBe(1);
  });
});

describe("badge scope storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to top-level, also for a stored value it does not know", () => {
    expect(readAeBadgeScope()).toBe("top-level");
    window.localStorage.setItem("omnigent:ae-badge-scope", "nonsense");
    expect(readAeBadgeScope()).toBe("top-level");
  });

  it("saves all", () => {
    writeAeBadgeScope("all");
    expect(readAeBadgeScope()).toBe("all");
  });
});

describe("badge scope storage failures and cross-tab changes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the default and still notifies when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readAeBadgeScope()).toBe("top-level");
    expect(() => writeAeBadgeScope("all")).not.toThrow();
  });

  it("re-reads on a storage event for its key, and when another tab clears everything", () => {
    window.localStorage.clear();
    const { result } = renderHook(() => useAeBadgeScope());
    expect(result.current).toBe("top-level");

    window.localStorage.setItem("omnigent:ae-badge-scope", "all");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "omnigent:ae-badge-scope" }));
    });
    expect(result.current).toBe("all");

    window.localStorage.clear();
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current).toBe("top-level");
  });
});
