import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  aeClaudeCodeDefaultEffort,
  aeClaudeEffortLabel,
  aeEffortDefaultFor,
  aeEffortResolved,
  aeEffortSourceTag,
  readAeEffortDefault,
} from "./aeEffortDefault";

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

describe("aeClaudeCodeDefaultEffort", () => {
  it("knows Claude Code's own default for a model id, alias or label", () => {
    expect(aeClaudeCodeDefaultEffort("claude-fable-5-1")).toBe("high");
    expect(aeClaudeCodeDefaultEffort("claude-opus-5-5[1m]")).toBe("medium");
    expect(aeClaudeCodeDefaultEffort("claude-opus-5")).toBe("high");
    expect(aeClaudeCodeDefaultEffort("Sonnet 5.5")).toBe("medium");
    expect(aeClaudeCodeDefaultEffort("opus", [{ id: "opus", model: "claude-opus-4-7" }])).toBe(
      "xhigh",
    );
  });

  it("gives null for a model it has no row for, or no version", () => {
    expect(aeClaudeCodeDefaultEffort("claude-opus-4-1")).toBe(null);
    expect(aeClaudeCodeDefaultEffort("opus")).toBe(null);
    expect(aeClaudeCodeDefaultEffort(null)).toBe(null);
  });
});

describe("aeEffortResolved", () => {
  const options = [{ id: "fable", model: "claude-fable-5-1", isDefault: true }];

  it("takes a settings-file level before Claude Code's default", () => {
    expect(
      aeEffortResolved(JSON.stringify({ "claude-fable-5-1": "max" }), "claude-fable-5-1"),
    ).toEqual({ level: "max", source: "settings" });
    expect(aeEffortResolved(JSON.stringify({ "*": "low" }), "claude-opus-5-5")).toEqual({
      level: "low",
      source: "settings",
    });
  });

  it("falls back to Claude Code's default for the model, or the picker's default model", () => {
    expect(aeEffortResolved(null, "claude-fable-5-1")).toEqual({ level: "high", source: "claude" });
    expect(
      aeEffortResolved(JSON.stringify({ "claude-opus-5-5": "high" }), "claude-sonnet-5-5"),
    ).toEqual({ level: "medium", source: "claude" });
    expect(aeEffortResolved(null, null, options)).toEqual({ level: "high", source: "claude" });
  });

  it("gives null when neither names a level", () => {
    expect(aeEffortResolved(null, "claude-opus-4-1")).toBe(null);
    expect(aeEffortResolved(null, null)).toBe(null);
  });
});

describe("aeClaudeEffortLabel", () => {
  it("uses Claude Code's words, Extra for xhigh", () => {
    expect(["low", "medium", "high", "xhigh", "max"].map(aeClaudeEffortLabel)).toEqual([
      "Low",
      "Medium",
      "High",
      "Extra",
      "Max",
    ]);
    expect(aeClaudeEffortLabel(null)).toBe(null);
  });

  it("tags a settings-file level and Claude Code's own default apart", () => {
    expect(aeEffortSourceTag("settings")).toBe("settings");
    expect(aeEffortSourceTag("claude")).toBe("default");
  });
});
