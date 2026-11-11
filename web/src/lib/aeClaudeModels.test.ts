// Tests for Claude version labels and older models (omnigent-ae, 2026-10-19).

import { afterEach, describe, expect, it } from "vitest";
import type { NativeModelOption } from "@/lib/types";
import {
  AE_CLAUDE_KNOWN_MODELS,
  aeClaudeVersion,
  aeClaudeVersionLabel,
  aeKnownModels,
  aeSetWatchedModels,
  aeSplitPrevious,
  aeMergeKnownClaudeModels,
  aeWithClaudeVersions,
} from "./aeClaudeModels";

const API = { kind: "api", label: "API", name: "anthropic" };
const SUBSCRIPTION = { kind: "subscription", label: "Subscription", name: "claude" };

/** The catalog a Claude subscription serves, as the host probe returns it. */
const CATALOG: NativeModelOption[] = [
  { id: "sonnet", model: "claude-sonnet-5-5", displayName: "Sonnet", source: SUBSCRIPTION },
  {
    id: "claude-fable-5-1[1m]",
    model: "claude-fable-5-1",
    displayName: "Fable",
    source: SUBSCRIPTION,
  },
  {
    id: "opus",
    model: "claude-opus-5-5",
    displayName: "Opus",
    isDefault: true,
    source: SUBSCRIPTION,
  },
  { id: "haiku", model: "claude-haiku-5-5", displayName: "Haiku", source: SUBSCRIPTION },
];

describe("aeClaudeVersionLabel", () => {
  it.each([
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-opus-5", "Opus 5"],
    ["claude-fable-5-1", "Fable 5.1"],
    ["claude-sonnet-4-6", "Sonnet 4.6"],
    ["claude-opus-5-5[1m]", "Opus 5.5"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-opus-4-20250514", "Opus 4"],
    ["claude-opus-4-20250514[1m]", "Opus 4"],
  ])("%s reads as %s", (model, label) => {
    expect(aeClaudeVersionLabel(model)).toBe(label);
  });

  it.each(["opus", "gpt-5.5", "", "claude-opus"])("returns null for %j", (model) => {
    expect(aeClaudeVersionLabel(model)).toBeNull();
  });

  it("never reads a date suffix as the minor version", () => {
    expect(aeClaudeVersion("claude-opus-4-20250514")).toEqual({
      family: "opus",
      major: 4,
      minor: 0,
      minorText: null,
    });
  });

  it("reads every known model", () => {
    for (const id of AE_CLAUDE_KNOWN_MODELS) expect(aeClaudeVersionLabel(id)).not.toBeNull();
  });
});

describe("aeWithClaudeVersions", () => {
  it("labels catalog rows with versions and keeps their alias ids", () => {
    const rows = aeWithClaudeVersions(CATALOG);
    expect(rows.slice(0, 4).map((row) => [row.id, row.displayName])).toEqual([
      ["sonnet", "Sonnet 5.5"],
      ["claude-fable-5-2[1m]", "Fable 5.2 (1M context)"],
      ["opus", "Opus 5.5"],
      ["haiku", "Haiku 5.5"],
    ]);
    expect(rows[2].isDefault).toBe(true);
  });

  it("appends each older known model once, with its full id as the model", () => {
    const older = aeWithClaudeVersions(CATALOG).slice(CATALOG.length);
    expect(older.map((row) => row.id)).toEqual([
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-fable-5-1",
      "claude-fable-5",
    ]);
    for (const row of older) {
      expect(row.model).toBe(row.id);
      expect(row.source).toEqual(SUBSCRIPTION);
    }
    expect(older[0].displayName).toBe("Opus 5");
  });

  it("is idempotent", () => {
    const once = aeWithClaudeVersions(CATALOG);
    expect(aeWithClaudeVersions(once)).toEqual(once);
  });

  it("does not duplicate a version the catalog already lists", () => {
    const rows = aeWithClaudeVersions([
      ...CATALOG,
      { id: "haiku-old", model: "claude-haiku-4-5-20251001", source: SUBSCRIPTION },
    ]);
    expect(rows.filter((row) => aeClaudeVersionLabel(row.model ?? row.id) === "Haiku 4.5")).toEqual(
      [expect.objectContaining({ id: "haiku-old" })],
    );
  });

  it("keeps a longer label such as the 1M context row", () => {
    const rows = aeWithClaudeVersions([
      {
        id: "claude-opus-5-5[1m]",
        model: "claude-opus-5-5[1m]",
        displayName: "Opus 5.5 (1M context)",
        source: SUBSCRIPTION,
      },
    ]);
    expect(rows[0].displayName).toBe("Opus 5.5 (1M context)");
  });

  it("decides per row in a catalog mixing sources", () => {
    const workspace = { kind: "databricks", label: "Workspace", name: "DEFAULT" };
    const rows = aeWithClaudeVersions([
      { id: "opus", model: "claude-opus-5-5", displayName: "Opus", source: SUBSCRIPTION },
      { id: "sonnet", model: "claude-sonnet-5-5", displayName: "Sonnet", source: workspace },
    ]);
    expect(rows[0].displayName).toBe("Opus 5.5");
    expect(rows[1]).toEqual({
      id: "sonnet",
      model: "claude-sonnet-5-5",
      displayName: "Sonnet",
      source: workspace,
    });
    const added = rows.slice(2).map((row) => row.id);
    expect(added).toEqual(["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7"]);
  });

  it("leaves rows from other sources untouched", () => {
    for (const source of [
      { kind: "databricks", label: "Workspace", name: "DEFAULT" },
      { kind: "gateway", label: "AI Gateway" },
    ]) {
      const rows = CATALOG.map((row) => ({ ...row, source }));
      expect(aeWithClaudeVersions(rows)).toBe(rows);
    }
    const unsourced = CATALOG.map(({ source: _source, ...row }) => row);
    expect(aeWithClaudeVersions(unsourced)).toBe(unsourced);
  });

  it("adds nothing for a family the catalog does not list", () => {
    const rows = aeWithClaudeVersions(CATALOG.filter((row) => row.id !== "haiku"));
    expect(rows.some((row) => row.id === "claude-haiku-4-5")).toBe(false);
  });
});

describe("aeSplitPrevious", () => {
  it("keeps the newest of each family and splits off the older ones", () => {
    const { latest, previous } = aeSplitPrevious(aeWithClaudeVersions(CATALOG));
    expect(latest.map((row) => row.id)).toEqual(
      CATALOG.map((row) => (row.id === "claude-fable-5-1[1m]" ? "claude-fable-5-2[1m]" : row.id)),
    );
    expect(previous.map((row) => row.id)).toContain("claude-opus-5");
    expect(previous).toHaveLength(AE_CLAUDE_KNOWN_MODELS.length - CATALOG.length);
  });

  it("keeps rows without a version with the newest", () => {
    const rows = [{ id: "default" }, { id: "opus-4-10" }, { id: "claude-opus-5-5" }];
    const { latest, previous } = aeSplitPrevious(rows);
    expect(latest).toEqual([{ id: "default" }, { id: "claude-opus-5-5" }]);
    expect(previous).toEqual([{ id: "opus-4-10" }]);
  });
});

describe("promotion of a newer known model", () => {
  it("moves the 1M Fable row to 5.2 and demotes 5.1", () => {
    const rows = aeWithClaudeVersions(CATALOG);
    const main = rows.find((row) => row.id === "claude-fable-5-2[1m]");
    expect(main).toMatchObject({
      model: "claude-fable-5-2",
      displayName: "Fable 5.2 (1M context)",
      source: SUBSCRIPTION,
    });
    expect(rows.some((row) => row.id === "claude-fable-5-1[1m]")).toBe(false);
    const { latest, previous } = aeSplitPrevious(rows);
    expect(latest.map((row) => row.id)).toContain("claude-fable-5-2[1m]");
    expect(previous.find((row) => row.id === "claude-fable-5-1")?.displayName).toBe("Fable 5.1");
  });

  it("leaves a bare alias row alone and puts a 5.2 row in front of it", () => {
    const rows = aeWithClaudeVersions([
      { id: "fable", model: "claude-fable-5-1", displayName: "Fable", source: SUBSCRIPTION },
    ]);
    expect(rows[0]).toEqual({
      id: "claude-fable-5-2",
      model: "claude-fable-5-2",
      displayName: "Fable 5.2",
      source: SUBSCRIPTION,
    });
    expect(rows[1]).toMatchObject({
      id: "fable",
      model: "claude-fable-5-1",
      displayName: "Fable 5.1",
    });
    expect(rows.filter((row) => row.model === "claude-fable-5-1")).toHaveLength(1);
  });

  it("puts a newer opus row before the untouched opus alias row", () => {
    const rows = aeMergeKnownClaudeModels(
      [{ id: "opus", model: "claude-opus-5-5", displayName: "Opus", source: SUBSCRIPTION }],
      ["claude-opus-6"],
    );
    expect(rows.map((row) => row.id).slice(0, 2)).toEqual(["claude-opus-6", "opus"]);
    expect(rows.filter((row) => row.model === "claude-opus-5-5")).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: "claude-opus-6",
      displayName: "Opus 6",
      source: SUBSCRIPTION,
    });
    expect(rows[1]).toMatchObject({ model: "claude-opus-5-5", displayName: "Opus 5.5" });
  });

  it("keeps the 1M suffix on the row inserted before a wide alias row", () => {
    const rows = aeMergeKnownClaudeModels(
      [
        {
          id: "opus[1m]",
          model: "claude-opus-5-5[1m]",
          displayName: "Opus",
          source: SUBSCRIPTION,
        },
      ],
      ["claude-opus-6"],
    );
    expect(rows.map((row) => row.id).slice(0, 2)).toEqual(["claude-opus-6[1m]", "opus[1m]"]);
    expect(rows[0]).toMatchObject({
      model: "claude-opus-6[1m]",
      displayName: "Opus 6 (1M context)",
    });
    expect(rows[1]).toMatchObject({
      model: "claude-opus-5-5[1m]",
      displayName: "Opus 5.5 (1M context)",
    });
    expect(rows.filter((row) => row.id.startsWith("claude-opus-6"))).toHaveLength(1);
  });

  it("copies the alias row's effort options to the new row but not isDefault", () => {
    const rows = aeMergeKnownClaudeModels(
      [
        {
          id: "opus",
          model: "claude-opus-5-5",
          displayName: "Opus",
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
          source: SUBSCRIPTION,
        },
      ],
      ["claude-opus-6"],
    );
    expect(rows[0]).toMatchObject({
      id: "claude-opus-6",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
    });
    expect(rows[0].isDefault).toBeFalsy();
    expect(rows[1]).toMatchObject({ id: "opus", isDefault: true });
    expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
  });

  it("is not stopped by an API row with the same id", () => {
    const rows = aeMergeKnownClaudeModels(
      [
        { id: "claude-opus-6", model: "claude-opus-6", displayName: "Opus 6", source: API },
        { id: "opus", model: "claude-opus-5-5", displayName: "Opus", source: SUBSCRIPTION },
      ],
      ["claude-opus-6"],
    );
    expect(rows.filter((row) => row.id === "claude-opus-6").map((row) => row.source)).toEqual([
      API,
      SUBSCRIPTION,
    ]);
  });

  it("promotes a bare full id to claude-fable-5-2", () => {
    const rows = aeWithClaudeVersions([
      {
        id: "claude-fable-5-1",
        model: "claude-fable-5-1",
        displayName: "Fable",
        source: SUBSCRIPTION,
      },
    ]);
    expect(rows[0]).toMatchObject({ id: "claude-fable-5-2", model: "claude-fable-5-2" });
  });

  it("leaves a catalog already on 5.2 unchanged", () => {
    const current = CATALOG.map((row) =>
      row.id.startsWith("claude-fable")
        ? { ...row, id: "claude-fable-5-2[1m]", model: "claude-fable-5-2" }
        : row,
    );
    const rows = aeWithClaudeVersions(current);
    expect(
      rows.filter((row) => row.source === SUBSCRIPTION && !row.id.startsWith("claude-")),
    ).toEqual(
      current
        .filter((row) => !row.id.startsWith("claude-"))
        .map((row) => ({
          ...row,
          displayName: expect.any(String),
        })),
    );
    expect(rows.find((row) => row.id === "claude-fable-5-2[1m]")?.displayName).toBe(
      "Fable 5.2 (1M context)",
    );
  });

  it("does not touch Opus, Sonnet or Haiku rows", () => {
    const rows = aeWithClaudeVersions(CATALOG);
    expect(rows.find((row) => row.id === "opus")).toMatchObject({
      model: "claude-opus-5-5",
      displayName: "Opus 5.5",
      isDefault: true,
    });
    expect(rows.find((row) => row.id === "sonnet")?.model).toBe("claude-sonnet-5-5");
    expect(rows.find((row) => row.id === "haiku")?.model).toBe("claude-haiku-5-5");
  });

  it("lets an extra known id beat 5.2", () => {
    const rows = aeMergeKnownClaudeModels(CATALOG, ["claude-fable-5-3"]);
    expect(rows.find((row) => row.id === "claude-fable-5-3[1m]")?.displayName).toBe(
      "Fable 5.3 (1M context)",
    );
    expect(rows.some((row) => row.id === "claude-fable-5-2")).toBe(true);
  });
});

describe("the watched known list", () => {
  afterEach(() => aeSetWatchedModels([]));

  it("is the static list, unchanged, when nothing is watched", () => {
    expect(aeKnownModels()).toEqual(AE_CLAUDE_KNOWN_MODELS);
  });

  it("adds valid ids, sorted by family then newest version, and drops the rest", () => {
    aeSetWatchedModels([
      "claude-fable-5-3",
      "claude-mythos-5-2",
      "claude-opus-5-5[1m]",
      "gpt-5",
      "claude-opus-4-20250514",
      7,
    ]);
    const known = aeKnownModels();
    expect(known.indexOf("claude-fable-5-3")).toBeLessThan(known.indexOf("claude-fable-5-2"));
    expect(known).toContain("claude-mythos-5-2");
    expect(known.some((id) => id.includes("[1m]") || id.includes("2025") || id === "gpt-5")).toBe(
      false,
    );
    expect(known.indexOf("claude-opus-5-5")).toBeLessThan(known.indexOf("claude-sonnet-5-5"));
  });

  it("keeps one array until the ids change", () => {
    aeSetWatchedModels(["claude-fable-5-3"]);
    const first = aeKnownModels();
    aeSetWatchedModels(["claude-fable-5-3"]);
    expect(aeKnownModels()).toBe(first);
  });

  it("reads Mythos ids as a family", () => {
    expect(aeClaudeVersionLabel("claude-mythos-5-2")).toBe("Mythos 5.2");
    expect(aeClaudeVersion("claude-mythos-5")?.family).toBe("mythos");
  });

  it("promotes a watched id over the catalog's newest row", () => {
    aeSetWatchedModels(["claude-fable-5-3"]);
    const rows = aeWithClaudeVersions(CATALOG);
    expect(rows.find((row) => row.id === "claude-fable-5-3[1m]")?.displayName).toBe(
      "Fable 5.3 (1M context)",
    );
  });
});

describe("a watched family the catalog does not list", () => {
  afterEach(() => aeSetWatchedModels([]));
  const SUB = { kind: "subscription", label: "Subscription", name: "claude" };
  const FABLE_ONLY: NativeModelOption[] = [
    { id: "claude-fable-5-2[1m]", model: "claude-fable-5-2", displayName: "Fable", source: SUB },
  ];

  it("adds one subscription row for a watched Mythos id", () => {
    aeSetWatchedModels(["claude-mythos-5-2"]);
    const row = aeWithClaudeVersions(FABLE_ONLY).find((r) => r.id === "claude-mythos-5-2");
    expect(row).toEqual({
      id: "claude-mythos-5-2",
      model: "claude-mythos-5-2",
      displayName: "Mythos 5.2",
      source: SUB,
    });
  });

  it("adds nothing from the static list alone", () => {
    const rows = aeWithClaudeVersions(FABLE_ONLY);
    expect(rows.some((r) => r.id.includes("opus") || r.id.includes("mythos"))).toBe(false);
  });

  it("adds nothing when the catalog has no subscription row", () => {
    aeSetWatchedModels(["claude-mythos-5-2"]);
    const other: NativeModelOption[] = [{ id: "x", model: "x", displayName: "X" }];
    expect(aeWithClaudeVersions(other)).toBe(other);
  });
});
