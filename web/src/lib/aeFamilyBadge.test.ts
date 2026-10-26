import { describe, expect, it } from "vitest";
import { AE_FAMILY_BADGES, aeFamilyBadgeLabel, aeRaiseArrowTitle } from "./aeFamilyBadge";

describe("AE_FAMILY_BADGES", () => {
  it("has one letter per role, the lead's L included for a nested lead child", () => {
    expect(Object.entries(AE_FAMILY_BADGES).map(([role, b]) => [role, b?.letter])).toEqual([
      ["lead", "L"],
      ["planner", "P"],
      ["reviewer", "R"],
      ["builder", "B"],
      ["helper", "H"],
    ]);
  });
});

describe("badge colors", () => {
  it("use opaque fills, no alpha, in light and dark", () => {
    for (const badge of Object.values(AE_FAMILY_BADGES)) {
      expect(badge?.className).not.toMatch(/bg-[a-z]+-\d+\/\d+/);
    }
  });
});

describe("aeFamilyBadgeLabel", () => {
  it("joins the role and its model with a middle dot", () => {
    expect(aeFamilyBadgeLabel("Reviewer", { model: "claude-sonnet-5-5", effort: "medium" })).toBe(
      "Reviewer · Sonnet medium",
    );
  });
  it("is the role alone without a model", () => {
    expect(aeFamilyBadgeLabel("Builder", null)).toBe("Builder");
    expect(aeFamilyBadgeLabel("Builder", { model: null, effort: null })).toBe("Builder");
  });
});

describe("aeRaiseArrowTitle", () => {
  const labels = {
    "ae.model_start": "claude-haiku-4-5|low",
    "ae.raises": "1",
    "ae.raise_cap": "2",
  };
  it("names the start and the count against the limit", () => {
    expect(aeRaiseArrowTitle(labels, false)).toBe("Raised from Haiku low (1 of 2)");
  });
  it("says the limit was reached, never a cap", () => {
    expect(aeRaiseArrowTitle({ ...labels, "ae.raise_cap": "1" }, true)).toBe(
      "Raise limit reached (1 of 1)",
    );
  });
});
