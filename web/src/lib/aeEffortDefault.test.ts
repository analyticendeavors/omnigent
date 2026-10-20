import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { aeEffortDefaultSuffix, readAeEffortDefault } from "./aeEffortDefault";

function cacheWith(labels: Record<string, string>) {
  const qc = new QueryClient();
  qc.setQueryData(["conversations", "all"], {
    pages: [{ data: [{ id: "conv_1", labels }] }],
    pageParams: [null],
  });
  return qc;
}

describe("readAeEffortDefault", () => {
  it("reads the level the runner recorded", () => {
    expect(readAeEffortDefault(cacheWith({ "ae.claude_effort_default": "high" }), "conv_1")).toBe(
      "high",
    );
  });

  it("gives null for none, a missing label, or an uncached session", () => {
    expect(readAeEffortDefault(cacheWith({ "ae.claude_effort_default": "none" }), "conv_1")).toBe(
      null,
    );
    expect(readAeEffortDefault(cacheWith({}), "conv_1")).toBe(null);
    expect(readAeEffortDefault(cacheWith({}), "conv_2")).toBe(null);
  });
});

describe("aeEffortDefaultSuffix", () => {
  it("names the recorded level as the default", () => {
    expect(aeEffortDefaultSuffix("claude", false, "high")).toBe(": High (default)");
  });

  it("says Claude default when no level is recorded", () => {
    expect(aeEffortDefaultSuffix("claude", false, null)).toBe(": Claude default");
  });

  it("stays blank under smart routing and for other harnesses", () => {
    expect(aeEffortDefaultSuffix("claude", true, "high")).toBe("");
    expect(aeEffortDefaultSuffix("codex", false, "high")).toBe("");
    expect(aeEffortDefaultSuffix(null, false, null)).toBe("");
  });
});
