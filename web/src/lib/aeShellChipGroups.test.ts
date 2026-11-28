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

  const W = "; do sleep 5; done";
  it.each([
    [
      "timeout bash -c form",
      [
        `timeout 30 bash -c 'while [ ! -f x ]${W}'; echo a`,
        `timeout 30 bash -c 'while [ ! -f x ]${W}'; echo b`,
      ],
      [2],
    ],
    [
      "escaped quote keeps the quoted delimiter inside the string",
      [`until grep "foo\\"${W}" a${W}`, `until grep "foo\\"${W}" b${W}`],
      [1, 1],
    ],
    [
      "apostrophe inside double quotes",
      [`until grep -q "don't" f${W}; tail1`, `until grep -q "don't" f${W}; tail2`],
      [2],
    ],
    [
      "nested quotes in the condition",
      [
        `until [ -z "$(pgrep -f 'x.mjs')" ]${W}; one`,
        `until [ -z "$(pgrep -f 'x.mjs')" ]${W}; two`,
      ],
      [2],
    ],
    [
      "quoted delimiter then a real one, same condition",
      [`until grep '${W}' a${W}; one`, `until grep '${W}' a${W}; two`],
      [2],
    ],
    [
      "quoted delimiter then a real one, different quoted strings",
      [`until grep '${W}' a${W}`, `until grep '${W}' b${W}`],
      [1, 1],
    ],
  ])("%s", (_name, commands, counts) => {
    const groups = aeGroupShells(commands.map((command) => ({ command })));
    expect(groups.map((g) => g.count)).toEqual(counts);
  });

  it("keeps a description and a command with the same text apart", () => {
    expect(aeGroupShells([{ description: "sleep 1" }, { command: "sleep 1" }])).toHaveLength(2);
  });
});
