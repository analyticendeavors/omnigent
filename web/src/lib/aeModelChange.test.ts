import { describe, expect, it } from "vitest";
import { aeRunsAboveStart } from "./aeModelChange";

const start = { model: "claude-sonnet-5-5", effort: "medium" };

describe("aeRunsAboveStart", () => {
  it.each([
    ["claude-opus-4-8", "low", true],
    ["claude-sonnet-5-5", "high", true],
    ["claude-sonnet-5-5", "medium", false],
    ["claude-sonnet-5-5", "low", false],
    ["claude-haiku-4-5", "max", false],
    ["claude-fable-5-1", null, true],
    [null, "high", true],
    [null, "low", false],
  ])("%s %s above the start: %s", (model, effort, above) => {
    expect(aeRunsAboveStart({ model, effort }, start)).toBe(above);
  });

  it("keeps the raise label when nothing can be compared", () => {
    expect(aeRunsAboveStart({ model: null, effort: null }, start)).toBe(true);
  });
});
