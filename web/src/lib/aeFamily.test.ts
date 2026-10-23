import { afterEach, describe, expect, it } from "vitest";
import type { Conversation } from "@/hooks/useConversations";
import {
  AE_FAMILY_COLORS,
  aeFamilies,
  aeFamilyHint,
  assignFamilyColors,
  familySlotChain,
  familySlotKey,
} from "./aeFamily";

function row(id: string, labels: Record<string, string> = {}, title = id): Conversation {
  return {
    id,
    object: "conversation",
    title,
    created_at: 0,
    updated_at: 0,
    labels,
    permission_level: null,
    status: "idle",
  } as Conversation;
}

afterEach(() => {
  localStorage.clear();
});

describe("aeFamilies", () => {
  it("groups a lead with the sessions it started and the forks of either", () => {
    const rows = [
      row("k1", { "ae.orch": "lead" }, "Families PR"),
      row("other", {}, "Unrelated"),
      row("lead", {}, "Role routing build"),
      // A fork copies its source's ae.orch, and still reads as a fork.
      row("fork", { "omnigent.fork.source_id": "k1", "ae.orch": "lead" }, "Families PR (fork)"),
    ];
    const { byRoot, byRow } = aeFamilies(rows);
    expect([...byRoot.keys()]).toEqual(["lead"]);
    const family = byRoot.get("lead")!;
    expect(family.members.map((c) => c.id)).toEqual(["lead", "k1", "fork"]);
    expect(family.leadTitle).toBe("Role routing build");
    expect(byRow.has("other")).toBe(false);
    expect(aeFamilyHint(byRow.get("lead")!)).toBe("Leads 2 sessions");
    expect(aeFamilyHint(byRow.get("k1")!)).toBe("Started by Role routing build");
    expect(aeFamilyHint(byRow.get("fork")!)).toBe("Forked from Families PR");
  });

  it("shows a family only with two loaded members, even when its lead is not listed", () => {
    expect(aeFamilies([row("k1", { "ae.orch": "gone" })]).byRoot.size).toBe(0);
    const orphans = aeFamilies([
      row("k1", { "ae.orch": "gone" }),
      row("k2", { "ae.orch": "gone" }),
    ]);
    const family = orphans.byRoot.get("gone")!;
    expect(family.leadTitle).toBeNull();
    expect(aeFamilyHint(orphans.byRow.get("k1")!)).toBe("Started by a session not listed here");
    // `1` is the orchestrator's "no id given", not a parent.
    expect(
      aeFamilies([row("a", { "ae.orch": "1" }), row("b", { "ae.orch": "1" })]).byRoot.size,
    ).toBe(0);
  });

  it("follows a slot to the top of the ae.orch chain, never through a fork", () => {
    const rows = [row("lead"), row("k1", { "ae.orch": "lead" }), row("g", { "ae.orch": "k1" })];
    const byId = new Map(rows.map((c) => [c.id, c] as const));
    expect(familySlotKey(rows[2], byId)).toBe("lead");
    const fork = row("f", { "omnigent.fork.source_id": "lead" });
    expect(familySlotKey(fork, byId)).toBe("f");
    expect(familySlotChain(rows[2], byId)).toEqual(["k1", "lead"]);
    // The chain stops where the loaded rows do; the server may know the top.
    expect(familySlotChain(row("x", { "ae.orch": "unloaded" }), byId)).toEqual(["unloaded"]);
    const loop = [row("a", { "ae.orch": "b" }), row("b", { "ae.orch": "a" })];
    const loopIds = new Map(loop.map((c) => [c.id, c] as const));
    expect(["a", "b"]).toContain(familySlotKey(loop[0], loopIds));
  });
});

describe("assignFamilyColors", () => {
  it("keeps a family's color across lists and never gives two listed families one", () => {
    const first = assignFamilyColors(["a", "b"]);
    expect(first.get("a")).not.toBe(first.get("b"));
    // "a" left the list; "c" takes the free color and "b" keeps its own.
    const second = assignFamilyColors(["c", "b"]);
    expect(second.get("b")).toBe(first.get("b"));
    expect(second.get("c")).not.toBe(second.get("b"));
    // Past the palette, colors repeat rather than fail.
    const many = assignFamilyColors(Array.from({ length: 10 }, (_, i) => `r${i}`));
    expect(many.size).toBe(10);
    for (const index of many.values()) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(AE_FAMILY_COLORS.length);
    }
  });

  it("works when storage throws", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(assignFamilyColors(["a"]).get("a")).toBe(0);
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
