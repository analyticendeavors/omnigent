import { describe, expect, it } from "vitest";
import {
  AE_LEGACY_GLYPHS,
  AE_SLOT_LIMIT,
  AE_STATUS_VALUES,
  aeDisplayStatus,
  aeLabel,
  aeStatusOf,
  countAeSlots,
  isAeSlot,
  stripLeadingGlyph,
} from "./aeLabels";

describe("stripLeadingGlyph", () => {
  it("drops each legacy glyph, its presentation selector and the space after it", () => {
    expect(stripLeadingGlyph("🟡 Fix the build")).toBe("Fix the build");
    expect(stripLeadingGlyph("🔴 Waiting on CI")).toBe("Waiting on CI");
    expect(stripLeadingGlyph("✅ Handoff written")).toBe("Handoff written");
    expect(stripLeadingGlyph("📌 Later")).toBe("Later");
    expect(stripLeadingGlyph("🗂️ Old notes")).toBe("Old notes");
    expect(stripLeadingGlyph("🗂 Old notes")).toBe("Old notes");
  });

  it("covers every status in the glyph table", () => {
    for (const status of AE_STATUS_VALUES) {
      expect(stripLeadingGlyph(`${AE_LEGACY_GLYPHS[status]} name`)).toBe("name");
    }
  });

  it("leaves other titles alone", () => {
    expect(stripLeadingGlyph("Fix the build")).toBe("Fix the build");
    expect(stripLeadingGlyph("Fix 🟡 the build")).toBe("Fix 🟡 the build");
    expect(stripLeadingGlyph("🚀 Launch")).toBe("🚀 Launch");
    expect(stripLeadingGlyph("")).toBe("");
  });
});

describe("aeLabel and aeStatusOf", () => {
  it("treats a missing, empty or blank value as unset", () => {
    expect(aeLabel(undefined, "ae.status")).toBeNull();
    expect(aeLabel({}, "ae.status")).toBeNull();
    expect(aeLabel({ "ae.status": "" }, "ae.status")).toBeNull();
    expect(aeLabel({ "ae.status": "   " }, "ae.status")).toBeNull();
    expect(aeLabel({ "ae.status": " parked " }, "ae.status")).toBe("parked");
  });

  it("returns only known status values", () => {
    expect(aeStatusOf({ "ae.status": "working" })).toBe("working");
    expect(aeStatusOf({ "ae.status": "done" })).toBeNull();
    expect(aeStatusOf({ omni_project: "x" })).toBeNull();
  });
});

describe("aeDisplayStatus", () => {
  it("derives blocked from a working session with an approval prompt outstanding", () => {
    expect(
      aeDisplayStatus({ labels: { "ae.status": "working" }, pending_elicitations_count: 1 }),
    ).toBe("blocked");
    expect(
      aeDisplayStatus({ labels: { "ae.status": "working" }, pending_elicitations_count: 0 }),
    ).toBe("working");
    expect(aeDisplayStatus({ labels: { "ae.status": "working" } })).toBe("working");
  });

  it("does not derive anything for the resting statuses", () => {
    expect(
      aeDisplayStatus({ labels: { "ae.status": "review" }, pending_elicitations_count: 2 }),
    ).toBe("review");
    expect(aeDisplayStatus({ labels: {}, pending_elicitations_count: 2 })).toBeNull();
  });
});

describe("slots", () => {
  const working = (id: string) => ({ id, labels: { "ae.status": "working" } });

  it("counts a working, top-level, unarchived row as a slot", () => {
    expect(isAeSlot(working("a"))).toBe(true);
    expect(isAeSlot({ ...working("a"), archived: true })).toBe(false);
    expect(isAeSlot({ ...working("a"), parent_session_id: "parent" })).toBe(false);
    expect(isAeSlot({ labels: { "ae.status": "parked" } })).toBe(false);
  });

  it("counts each session once and stops at nothing", () => {
    expect(AE_SLOT_LIMIT).toBe(3);
    expect(
      countAeSlots([
        working("a"),
        working("a"),
        working("b"),
        { ...working("c"), archived: true },
        { id: "d", labels: {} },
      ]),
    ).toBe(2);
    expect(countAeSlots([working("a"), working("b"), working("c"), working("d")])).toBe(4);
  });
});
