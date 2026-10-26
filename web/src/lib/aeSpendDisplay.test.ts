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

describe("aeSpendLabel both", () => {
  const big = usage({ a: row({ inputTokens: 1_900_000, outputTokens: 80_000 }) }, 9.8);
  const withTokens = usage({ a: row({ inputTokens: 200_000, outputTokens: 12_000 }) }, 3);
  const noTokens = usage({ a: row({ totalCostUsd: 1 }) }, 1);
  const tokensOnly = usage({ a: row({ inputTokens: 1000, outputTokens: 200 }) }, null);

  it("joins tokens and the estimated cost", () => {
    const label = aeSpendLabel([big], "both");
    expect(label).toMatchObject({
      text: "1.98M tok · $9.80",
      long: "1.98M tokens · $9.80",
      unit: "both",
    });
    expect(label?.title).toBe(`${label?.parts?.tokens?.title} · $9.80 estimated`);
    expect(label?.parts?.tokens?.text).toBe("1.98M tok");
    expect(label?.parts?.cost?.text).toBe("$9.80");
  });

  it("keeps the plus for incomplete tokens", () => {
    expect(aeSpendLabel([withTokens, noTokens], "both")?.text).toBe("212k+ tok · $4.00");
  });

  it("marks a cost that leaves out a session with no cost, as tokens mark theirs", () => {
    // A subscription session reports tokens but no cost.
    const label = aeSpendLabel([big, tokensOnly], "both");
    expect(label?.text).toBe("1.98M tok \u00b7 $9.80+");
    expect(label?.parts?.cost?.title).toBe("$9.80 estimated \u00b7 1 session reports no cost");
    // Cost mode keeps its old text.
    expect(aeSpendLabel([big, tokensOnly], "cost")?.text).toBe("$9.80");
  });

  it("falls back to the tokens label when no real cost exists", () => {
    const label = aeSpendLabel([tokensOnly], "both");
    expect(label).toMatchObject({ text: "1.2k tok", unit: "tokens" });
    expect(label?.parts).toMatchObject({ cost: null });
  });

  it("falls back to the cost label when no tokens exist", () => {
    const label = aeSpendLabel([noTokens], "both");
    expect(label).toMatchObject({ text: "$1.00", unit: "estimated" });
    expect(label?.parts).toMatchObject({ tokens: null });
  });

  it("is null when off and fills parts in the other modes", () => {
    expect(aeSpendLabel([big], "off")).toBeNull();
    expect(aeSpendLabel([big], "tokens")).toMatchObject({
      text: "1.98M tok",
      parts: { cost: null },
    });
    const cost = aeSpendLabel([big], "cost");
    expect(cost?.text).toBe("$9.80");
    expect(cost?.parts).toMatchObject({ tokens: null });
    expect(cost?.parts?.cost?.text).toBe("$9.80");
    const fell = aeSpendLabel([{ ...tokensOnly, tokens: 5000 }], "cost");
    expect(fell?.parts?.cost).toBeNull();
    expect(fell?.parts?.tokens?.text).toBe("5k");
  });

  it("accepts both from storage", () => {
    window.localStorage.setItem("omnigent:ae-spend-display", "both");
    expect(readAeSpendDisplay()).toBe("both");
  });
});
