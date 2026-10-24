import { describe, expect, it } from "vitest";
import { aeRaiseMarks, aeRunsAboveStart } from "./aeModelChange";

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

describe("aeRaiseMarks", () => {
  const labels = {
    "ae.model_start": "claude-sonnet-5-5|medium",
    "ae.raises": "1",
    "ae.raise_cap": "1",
    "ae.model_last":
      '{"f":["claude-sonnet-5-5","medium"],"t":["claude-opus-5-5","high"],"k":"r","r":"Stuck on locks","a":1792876051,"p":"a"}',
  };
  const opus = { model: "claude-opus-5-5", effort: "high" };

  it("is raised above the start, with the line and a title naming the last change", () => {
    const marks = aeRaiseMarks(labels, opus);
    expect(marks.raised).toBe(true);
    expect(marks.capReached).toBe(true);
    expect(marks.line).toBe("\u2191 Opus high \u00b7 from Sonnet medium");
    expect(marks.title).toMatch(/^Raised 1 time, \d\d:\d\d: Stuck on locks\./);
    expect(marks.title).toContain("The next raise asks you first.");
  });

  it("is not raised back at the start, and without a start label", () => {
    expect(aeRaiseMarks(labels, start).raised).toBe(false);
    expect(aeRaiseMarks({}, opus).raised).toBe(false);
    expect(aeRaiseMarks(undefined, opus).raised).toBe(false);
  });

  it("does not need a raise count, and leaves the cap off below it", () => {
    const marks = aeRaiseMarks({ "ae.model_start": "claude-sonnet-5-5|medium" }, opus);
    expect(marks.raised).toBe(true);
    expect(marks.capReached).toBe(false);
    expect(marks.title).toBe("Raised 0 times from Sonnet medium");
  });
});

describe("aeRaiseMarks long-form fallback", () => {
  it("reads the long keys too", () => {
    const marks = aeRaiseMarks(
      {
        "ae.model_start": "claude-sonnet-5-5|medium",
        "ae.model_last": JSON.stringify({
          to: { model: "claude-opus-5-5", effort: "high" },
          reason: "Long form",
          at: 1792876051,
        }),
      },
      { model: "claude-opus-5-5", effort: "high" },
    );
    expect(marks.title).toMatch(/: Long form\./);
  });
});
