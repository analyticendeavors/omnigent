import { describe, expect, it } from "vitest";
import type { NativeModelOption } from "@/lib/types";
import { aeClaudeFoldSplit, aeCodexFoldSplit, aeFoldRowLabel } from "./aeModelFold";

const claude = (...ids: string[]) => ids.map((value) => ({ value, label: value }));
const values = (items: { value: string }[]) => items.map((i) => i.value);
const codex = (...names: string[]): NativeModelOption[] =>
  names.map((n) => ({ id: n.toLowerCase(), model: n.toLowerCase(), displayName: n }));
const labels = (rows: NativeModelOption[]) => rows.map((r) => r.displayName);

describe("aeClaudeFoldSplit", () => {
  it("keeps the newest of each family on top and the rest older", () => {
    const { latest, older } = aeClaudeFoldSplit(
      claude(
        "claude-opus-5-5",
        "claude-opus-5",
        "claude-sonnet-5-5",
        "claude-sonnet-4-6",
        "claude-haiku-5-5",
      ),
    );
    expect(values(latest)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(values(older)).toEqual(["claude-opus-5", "claude-sonnet-4-6"]);
  });

  it("moves Opus 5.5 into older when Opus 5.6 arrives", () => {
    const { latest, older } = aeClaudeFoldSplit(
      claude("claude-opus-5-6", "claude-opus-5-5", "claude-sonnet-5-5"),
    );
    expect(values(latest)).toEqual(["claude-opus-5-6", "claude-sonnet-5-5"]);
    expect(values(older)).toEqual(["claude-opus-5-5"]);
  });

  it("compares minors as numbers, so 4.10 beats 4.9", () => {
    const { latest, older } = aeClaudeFoldSplit(claude("claude-opus-4-9", "claude-opus-4-10"));
    expect(values(latest)).toEqual(["claude-opus-4-10"]);
    expect(values(older)).toEqual(["claude-opus-4-9"]);
  });

  it("leaves a family with one version, and a catalog in any order, in latest", () => {
    const { latest, older } = aeClaudeFoldSplit(claude("claude-fable-5-1", "claude-haiku-4-5"));
    expect(values(latest)).toEqual(["claude-fable-5-1", "claude-haiku-4-5"]);
    expect(older).toEqual([]);
  });

  it("keeps an unparseable id reachable in latest", () => {
    const { latest, older } = aeClaudeFoldSplit(
      claude("custom-model", "claude-opus-5-5", "claude-opus-5"),
    );
    expect(values(latest)).toEqual(["custom-model", "claude-opus-5-5"]);
    expect(values(older)).toEqual(["claude-opus-5"]);
  });

  it("reads the version from the label when the id has none", () => {
    const { older } = aeClaudeFoldSplit([
      { value: "alias-a", label: "Opus 5.5" },
      { value: "alias-b", label: "Opus 5" },
    ]);
    expect(values(older)).toEqual(["alias-b"]);
  });

  it("handles an empty catalog", () => {
    expect(aeClaudeFoldSplit([])).toEqual({ latest: [], older: [] });
  });
});

describe("aeCodexFoldSplit", () => {
  const rows = codex(
    "GPT-6-Astra",
    "GPT-6-Sol",
    "GPT-6-Luna",
    "GPT-5.6-Sol",
    "GPT-5.6-Terra",
    "GPT-5.6-Luna",
  );

  it("keeps the three latest and folds everything else the host lists", () => {
    const { latest, older } = aeCodexFoldSplit(rows);
    expect(labels(latest)).toEqual(["GPT-6-Astra", "GPT-6-Sol", "GPT-6-Luna"]);
    expect(labels(older)).toEqual(["GPT-5.6-Sol", "GPT-5.6-Terra", "GPT-5.6-Luna"]);
  });

  it("puts a newer generation on top and pushes the old one into older", () => {
    const { latest, older } = aeCodexFoldSplit([...rows, ...codex("GPT-6.1-Sol")]);
    expect(labels(latest)).toContain("GPT-6.1-Sol");
    expect(labels(older)).toContain("GPT-6-Sol");
  });

  it("keeps unparseable models reachable in older", () => {
    const { latest, older } = aeCodexFoldSplit([...rows, ...codex("custom")]);
    expect(labels(latest)).not.toContain("custom");
    expect(labels(older)).toContain("custom");
  });

  it("lists everything when no name parses", () => {
    const { latest, older } = aeCodexFoldSplit(codex("alpha", "beta"));
    expect(labels(latest)).toEqual(["alpha", "beta"]);
    expect(older).toEqual([]);
  });

  it("handles an empty catalog and a one-model catalog", () => {
    expect(aeCodexFoldSplit([])).toEqual({ latest: [], older: [] });
    const one = codex("GPT-6-Sol");
    expect(aeCodexFoldSplit(one)).toEqual({ latest: one, older: [] });
  });

  it("shows every row on top when no name parses (no version data, so nothing to fold)", () => {
    const { latest, older } = aeCodexFoldSplit(
      codex("alias-one", "alias-two", "alias-three", "alias-four"),
    );
    expect(latest).toHaveLength(4);
    expect(older).toEqual([]);
  });
});

describe("aeFoldRowLabel", () => {
  it("announces state and count", () => {
    expect(aeFoldRowLabel(7, false)).toBe("Older models, collapsed, 7");
    expect(aeFoldRowLabel(3, true)).toBe("Older models, expanded, 3");
  });
});
