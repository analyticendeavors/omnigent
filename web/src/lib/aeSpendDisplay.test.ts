import { beforeEach, describe, expect, it } from "vitest";
import type { AeSessionUsage } from "@/lib/aeAgentUsage";
import {
  aeSpendLabel,
  aeTokenStats,
  readAeSpendDisplay,
  writeAeSpendDisplay,
} from "@/lib/aeSpendDisplay";
import type { ModelUsage } from "@/lib/types";

const row = (over: Partial<ModelUsage>): ModelUsage => ({
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
  totalCostUsd: null,
  ...over,
});

const usage = (byModel: Record<string, ModelUsage>, costUsd: number | null = null) =>
  ({
    tokens: null,
    byModel,
    byFamily: {},
    costUsd,
    costByFamily: {},
    effort: null,
    model: null,
  }) satisfies AeSessionUsage;

describe("spend display setting", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to tokens and keeps what is written", () => {
    expect(readAeSpendDisplay()).toBe("tokens");
    writeAeSpendDisplay("off");
    expect(readAeSpendDisplay()).toBe("off");
    window.localStorage.setItem("omnigent:ae-spend-display", "nonsense");
    expect(readAeSpendDisplay()).toBe("tokens");
  });
});

describe("aeTokenStats", () => {
  it("counts new input and output, not cache reads, and sums the rows that have counts", () => {
    const stats = aeTokenStats({
      a: row({ inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 50_000 }),
      b: row({ inputTokens: 100, cacheCreationInputTokens: 300 }),
      c: row({ totalCostUsd: 2 }),
    });
    expect(stats).toMatchObject({
      spent: 1600,
      cacheRead: 50_000,
      cacheWrite: 300,
      complete: false,
    });
    expect(aeTokenStats({ c: row({ totalCostUsd: 2 }) })).toBeNull();
  });
});

describe("aeSpendLabel", () => {
  const withTokens = usage({ a: row({ inputTokens: 200_000, outputTokens: 12_000 }) }, 3);
  const noTokens = usage({ a: row({ totalCostUsd: 1 }) }, 1);

  it("shows tokens with a breakdown title, and a plus when a session has no count", () => {
    expect(aeSpendLabel([withTokens], "tokens")).toMatchObject({
      text: "212k tok",
      long: "212k tokens",
    });
    const mixed = aeSpendLabel([withTokens, noTokens], "tokens");
    expect(mixed?.text).toBe("212k+ tok");
    expect(mixed?.title).toContain("1 session has no token count");
    expect(mixed?.title).toContain("input (incl. cache writes) 200k, output 12k, cache reads 0");
    expect(mixed?.title).not.toContain("cache writes 0");
  });

  it("hides when no session has tokens, and when off", () => {
    expect(aeSpendLabel([noTokens], "tokens")).toBeNull();
    expect(aeSpendLabel([withTokens], "off")).toBeNull();
  });

  it("keeps the old cost behavior in cost mode", () => {
    expect(aeSpendLabel([withTokens, noTokens], "cost")?.text).toBe("$4.00");
  });
});
