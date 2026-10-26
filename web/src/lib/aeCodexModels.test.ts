import { describe, expect, it } from "vitest";
import {
  aeCodexDefaultEffort,
  aeCodexOtherModels,
  aeCodexEfforts,
  aeCodexName,
  aeCompareGeneration,
  aeLatestCodexModels,
  aeNewCodexReviewerModel,
} from "./aeCodexModels";
import type { NativeModelOption } from "./types";

const levels = (...names: string[]) => names.map((reasoningEffort) => ({ reasoningEffort }));
const FIVE = levels("low", "medium", "high", "xhigh", "max");
const SIX = levels("low", "medium", "high", "xhigh", "max", "ultra");

function row(
  displayName: string,
  supported = FIVE,
  defaultReasoningEffort = "medium",
): NativeModelOption {
  return {
    id: displayName.toLowerCase(),
    model: displayName.toLowerCase(),
    displayName,
    supportedReasoningEfforts: supported,
    defaultReasoningEffort,
  } as NativeModelOption;
}

// The host's real list, in its order.
const HOST = [
  row("GPT-6-Astra", SIX),
  row("GPT-6-Sol", SIX),
  row("GPT-6-Luna"),
  row("GPT-5.6-Sol", SIX, "low"),
  row("GPT-5.6-Terra", SIX),
  row("GPT-5.6-Luna"),
];

describe("aeCodexName", () => {
  it("reads the generation and the family from a display name", () => {
    expect(aeCodexName("GPT-6-Sol")).toEqual({ family: "sol", generation: [6] });
    expect(aeCodexName("GPT-5.6-Terra")).toEqual({ family: "terra", generation: [5, 6] });
  });

  it("gives null when either part is missing", () => {
    expect(aeCodexName("GPT-6")).toBeNull();
    expect(aeCodexName("Sol")).toBeNull();
    expect(aeCodexName("")).toBeNull();
    expect(aeCodexName(undefined)).toBeNull();
  });
});

describe("aeCompareGeneration", () => {
  it("compares part by part, so 5.6 is older than 6 and newer than 5", () => {
    expect(aeCompareGeneration([5, 6], [6])).toBeLessThan(0);
    expect(aeCompareGeneration([5, 6], [5])).toBeGreaterThan(0);
    expect(aeCompareGeneration([6], [6, 0])).toBe(0);
    expect(aeCompareGeneration([5, 10], [5, 9])).toBeGreaterThan(0);
  });
});

describe("aeLatestCodexModels", () => {
  it("keeps the three families with the newest version, newest of each", () => {
    expect(aeLatestCodexModels(HOST).map((r) => r.displayName)).toEqual([
      "GPT-6-Astra",
      "GPT-6-Sol",
      "GPT-6-Luna",
    ]);
  });

  it("is computed from the names, not fixed to any", () => {
    const next = [row("GPT-7-Sol", SIX), ...HOST, row("GPT-7-Terra")];
    expect(aeLatestCodexModels(next).map((r) => r.displayName)).toEqual([
      "GPT-7-Sol",
      "GPT-7-Terra",
      "GPT-6-Astra",
    ]);
  });

  it("takes the older generation of a family when the newer one is missing from the list", () => {
    const rows = [row("GPT-6-Sol", SIX), row("GPT-5.6-Terra"), row("GPT-5.6-Luna")];
    expect(aeLatestCodexModels(rows).map((r) => r.displayName)).toEqual([
      "GPT-6-Sol",
      "GPT-5.6-Terra",
      "GPT-5.6-Luna",
    ]);
  });

  it("lists fewer than three when the host has fewer families", () => {
    expect(aeLatestCodexModels([row("GPT-6-Sol"), row("GPT-5-Sol")])).toHaveLength(1);
  });

  it("drops names that do not parse while others do", () => {
    const rows = [row("Mystery"), row("GPT-6-Sol")];
    expect(aeLatestCodexModels(rows).map((r) => r.displayName)).toEqual(["GPT-6-Sol"]);
  });

  it("lists every model when no name parses", () => {
    const rows = [row("alpha"), row("beta"), row("gamma"), row("delta")];
    expect(aeLatestCodexModels(rows)).toEqual(rows);
    expect(aeLatestCodexModels([])).toEqual([]);
  });
});

describe("aeNewCodexReviewerModel", () => {
  it("is Sol of the newest generation", () => {
    expect(aeNewCodexReviewerModel(HOST)?.displayName).toBe("GPT-6-Sol");
  });

  it("falls back to the first listed when there is no Sol", () => {
    expect(aeNewCodexReviewerModel([row("GPT-6-Astra"), row("GPT-6-Luna")])?.displayName).toBe(
      "GPT-6-Astra",
    );
    expect(aeNewCodexReviewerModel([])).toBeNull();
  });
});

describe("Codex efforts", () => {
  it("lists the levels a preset can store, in bar order", () => {
    expect(aeCodexEfforts(HOST[2])).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(aeCodexEfforts(null)).toEqual([]);
  });

  it("lists ultra last for a model that offers it", () => {
    expect(aeCodexEfforts(HOST[1])).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("opens on ultra when that is the model's default", () => {
    expect(aeCodexDefaultEffort(row("GPT-6-Sol", SIX, "ultra"))).toBe("ultra");
  });

  it("uses the model's default, else medium, else its first level", () => {
    expect(aeCodexDefaultEffort(HOST[3])).toBe("low");
    expect(aeCodexDefaultEffort(row("GPT-6-Sol", FIVE, "ultra"))).toBe("medium");
    expect(aeCodexDefaultEffort(row("GPT-6-Sol", levels("high", "max"), "ultra"))).toBe("high");
    expect(aeCodexDefaultEffort(null)).toBe("medium");
  });
});

describe("mixed catalogs", () => {
  const MIXED = [...HOST, row("GPT-5.6-Codex-Max"), row("GPT-5.6-Max"), row("Mystery")];

  it("keeps the latest three to the named families when two or more parse", () => {
    expect(aeLatestCodexModels(MIXED).map((r) => r.displayName)).toEqual([
      "GPT-6-Astra",
      "GPT-6-Sol",
      "GPT-6-Luna",
    ]);
  });

  it("keeps models that do not parse, and other families, reachable after the latest three", () => {
    expect(aeCodexOtherModels(MIXED).map((r) => r.displayName)).toEqual([
      "GPT-5.6-Codex-Max",
      "GPT-5.6-Max",
      "Mystery",
    ]);
    expect(aeCodexOtherModels(HOST)).toEqual([]);
  });

  it("never shares a family between Codex-Max and Max", () => {
    expect(aeCodexName("GPT-5.6-Codex-Max")?.family).toBe("codex-max");
    expect(aeCodexName("GPT-5.6-Max")?.family).toBe("max");
  });

  it("falls back to every parsed family when fewer than two named ones exist", () => {
    const rows = [row("GPT-7-Max"), row("GPT-6-Sol"), row("GPT-5-Codex-Max")];
    expect(aeLatestCodexModels(rows).map((r) => r.displayName)).toEqual([
      "GPT-7-Max",
      "GPT-6-Sol",
      "GPT-5-Codex-Max",
    ]);
  });

  it("starts a new reviewer on the newest Sol anywhere in the list, even beyond the latest three", () => {
    const rows = [
      row("GPT-7-Astra"),
      row("GPT-7-Luna"),
      row("GPT-7-Terra"),
      row("GPT-6-Sol"),
      row("GPT-5-Sol"),
    ];
    expect(aeLatestCodexModels(rows).map((r) => r.displayName)).not.toContain("GPT-6-Sol");
    expect(aeNewCodexReviewerModel(rows)?.displayName).toBe("GPT-6-Sol");
    expect(aeNewCodexReviewerModel([row("GPT-7-Astra"), row("GPT-7-Luna")])?.displayName).toBe(
      "GPT-7-Astra",
    );
  });
});
