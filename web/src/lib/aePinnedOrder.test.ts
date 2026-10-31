import { describe, expect, it } from "vitest";
import type { Conversation } from "@/hooks/useConversations";
import { aeKidPinValues, aeNextPinValue, aePinWritesWithKids } from "./aePinnedOrder";

const row = (id: string, value: number) =>
  ({ id, labels: { "omnigent.pinned": String(value) } }) as unknown as Conversation;

describe("aePinnedOrder", () => {
  it("spreads values after the lead and below the next row", () => {
    expect(aeKidPinValues(10, 12, 3)).toEqual([10.5, 11, 11.5]);
    expect(aeKidPinValues(10, undefined, 2)).toEqual([11, 12]);
  });

  it("finds the row that follows a placed one", () => {
    const top = [row("a", 1), row("b", 5)];
    expect(aeNextPinValue(top, [], 2, "x")).toBe(5);
    expect(aeNextPinValue(top, [{ id: "b", pinnedAt: 1.5 }], 2, "x")).toBeUndefined();
  });

  it("moves a lead's pinned sessions after it, and leaves a placed family alone", () => {
    const top = [row("solo", 1001), row("lead", 1000)];
    const kids = new Map([["lead", [row("kid", 1002), row("kid2", 1003)]]]);
    // lead moved last: 1002 would tie with the old kid.
    const writes = aePinWritesWithKids(top, kids, [{ id: "lead", pinnedAt: 1002 }]);
    expect(writes).toEqual([
      { id: "lead", pinnedAt: 1002 },
      { id: "kid", pinnedAt: 1003 },
      { id: "kid2", pinnedAt: 1004 },
    ]);
    const settled = new Map([["lead", [row("kid", 1002.5), row("kid2", 1002.7)]]]);
    expect(aePinWritesWithKids(top, settled, [{ id: "lead", pinnedAt: 1002 }])).toEqual([
      { id: "lead", pinnedAt: 1002 },
    ]);
  });

  it("keeps sessions below the next top-level row after a renumber", () => {
    const top = [row("lead", 1), row("solo", 2)];
    const kids = new Map([["lead", [row("kid", 5)]]]);
    const writes = aePinWritesWithKids(top, kids, [
      { id: "lead", pinnedAt: 10 },
      { id: "solo", pinnedAt: 11 },
    ]);
    const kid = writes.find((w) => w.id === "kid")!;
    expect(kid.pinnedAt).toBeGreaterThan(10);
    expect(kid.pinnedAt).toBeLessThan(11);
  });
});
