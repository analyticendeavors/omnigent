import { describe, expect, it } from "vitest";
import { aeGroupShells } from "./aeShellChipGroups";

const loop = (tail: string) => ({
  command: `until [ -z "$(pgrep -f 'scripts/fit-check.mjs')" ]; do sleep 5; done; ${tail}`,
});

describe("aeGroupShells", () => {
  it("returns no groups for no shells", () => {
    expect(aeGroupShells([])).toEqual([]);
  });

  it("merges wait loops that differ only after the wait", () => {
    const groups = aeGroupShells([
      { id: "a", ...loop("echo one") },
      { id: "b", ...loop("echo two") },
      { id: "c", command: "gh pr checks 1 --watch" },
      { id: "d", ...loop("pnpm test") },
      { id: "e", ...loop("echo   one") },
    ]);
    expect(groups.map((g) => g.count)).toEqual([4, 1]);
    expect(groups[0].tasks.map((t) => t.id)).toEqual(["a", "b", "d", "e"]);
  });

  it("keeps different commands apart, in first-seen order", () => {
    const groups = aeGroupShells([{ command: "sleep 1" }, { command: "sleep 2" }]);
    expect(groups.map((g) => g.key)).toEqual(["sleep 1", "sleep 2"]);
  });

  it("lets the description win over the command", () => {
    const groups = aeGroupShells([
      { description: "Wait for CI", command: "sleep 1" },
      { description: "Wait for CI", command: "sleep 2" },
      { command: "sleep 1" },
    ]);
    expect(groups.map((g) => g.count)).toEqual([2, 1]);
  });

  it("does not merge wait loops with different conditions", () => {
    const groups = aeGroupShells([
      { command: "until [ -f a ]; do sleep 5; done" },
      { command: "until [ -f b ]; do sleep 5; done" },
    ]);
    expect(groups).toHaveLength(2);
  });
});
