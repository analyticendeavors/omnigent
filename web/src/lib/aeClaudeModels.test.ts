// Tests for Claude version labels and older models (omnigent-ae, 2026-10-19).

import { describe, expect, it } from "vitest";
import type { NativeModelOption } from "@/lib/types";
import {
  AE_CLAUDE_KNOWN_MODELS,
  aeClaudeVersion,
  aeClaudeVersionLabel,
  aeSplitPrevious,
  aeWithClaudeVersions,
} from "./aeClaudeModels";

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
      ["claude-fable-5-1[1m]", "Fable 5.1 (1M context)"],
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
    expect(latest.map((row) => row.id)).toEqual(CATALOG.map((row) => row.id));
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
