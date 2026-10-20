import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { aeEffortDefaultFor, aeEffortDefaultSuffix, readAeEffortDefault } from "./aeEffortDefault";

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

describe("aeEffortDefaultFor", () => {
  const levels = JSON.stringify({ "*": "medium", "claude-opus-5-5": "high" });

  it("picks the current model's own level, else the any-model level", () => {
    expect(aeEffortDefaultFor(levels, "claude-opus-5-5")).toBe("high");
    expect(aeEffortDefaultFor(levels, "claude-sonnet-5-5")).toBe("medium");
    expect(aeEffortDefaultFor(levels, null)).toBe("medium");
  });

  it("matches a suffixed id or a picker alias to the model's entry", () => {
    expect(aeEffortDefaultFor(levels, "claude-opus-5-5[1m]")).toBe("high");
    expect(aeEffortDefaultFor(levels, "opus", [{ id: "opus", model: "claude-opus-5-5" }])).toBe(
      "high",
    );
  });

  it("gives null with no entry for the model and no any-model level", () => {
    const opusOnly = JSON.stringify({ "claude-opus-5-5": "high" });
    expect(aeEffortDefaultFor(opusOnly, "claude-haiku-5-5")).toBe(null);
    expect(aeEffortDefaultFor(null, "claude-opus-5-5")).toBe(null);
    expect(aeEffortDefaultFor("{broken", "claude-opus-5-5")).toBe(null);
  });

  it("matches an alias with a suffix, and stored keys written as an alias or with a suffix", () => {
    const options = [
      { id: "opus[1m]", model: "claude-opus-5-5[1m]" },
      { id: "sonnet", model: "claude-sonnet-5-5", isDefault: true },
    ];
    expect(aeEffortDefaultFor(levels, "opus[1m]", options)).toBe("high");
    expect(
      aeEffortDefaultFor(JSON.stringify({ "opus[1m]": "low" }), "claude-opus-5-5", options),
    ).toBe("low");
    expect(
      aeEffortDefaultFor(JSON.stringify({ "claude-sonnet-5-5[1m]": "max" }), "sonnet", options),
    ).toBe("max");
  });

  it("uses the picker's default model before the session reports one", () => {
    const options = [{ id: "opus", model: "claude-opus-5-5", isDefault: true }];
    expect(aeEffortDefaultFor(JSON.stringify({ "claude-opus-5-5": "high" }), null, options)).toBe(
      "high",
    );
  });

  it("ignores values that are not Claude efforts", () => {
    expect(aeEffortDefaultFor(JSON.stringify({ "*": "turbo" }), "claude-opus-5-5")).toBe(null);
    expect(aeEffortDefaultFor("hig", "claude-opus-5-5")).toBe(null);
  });

  it("reads a plain level from the first release as any model's", () => {
    expect(aeEffortDefaultFor("high", "claude-haiku-5-5")).toBe("high");
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
