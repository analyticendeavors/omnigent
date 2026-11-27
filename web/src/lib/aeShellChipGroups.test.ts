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
    expect(groups.map((g) => g.label)).toEqual(["sleep 1", "sleep 2"]);
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

  it("labels a merged loop group with its shared condition", () => {
    const [g] = aeGroupShells([loop("a"), loop("b")]);
    expect(g.label).toBe("until [ -z \"$(pgrep -f 'scripts/fit-check.mjs')\" ]");
  });

  it("only merges loops whose body is a bare sleep", () => {
    const two = (a: string, b: string) => aeGroupShells([{ command: a }, { command: b }]);
    expect(
      two("while true; do ./poll-a.sh; sleep 5; done", "while true; do ./poll-b.sh; done"),
    ).toHaveLength(2);
    expect(
      two("until false; do ./deploy.sh; done", "until false; do ./backup.sh; done"),
    ).toHaveLength(2);
    expect(
      two(
        "until grep -q '; do alpha' f; do sleep 5; done",
        "until grep -q '; do beta' f; do sleep 5; done",
      ),
    ).toHaveLength(2);
  });

  it("does not cut at a `; do ` inside a quoted string", () => {
    const a = "until grep '; do sleep 5; done' a; do sleep 5; done";
    const b = "until grep '; do sleep 5; done' b; do sleep 5; done";
    expect(aeGroupShells([{ command: a }, { command: b }])).toHaveLength(2);
    expect(aeGroupShells([{ command: a }, { command: a }])).toHaveLength(1);
  });

  it("keeps a description and a command with the same text apart", () => {
    expect(aeGroupShells([{ description: "sleep 1" }, { command: "sleep 1" }])).toHaveLength(2);
  });
});
