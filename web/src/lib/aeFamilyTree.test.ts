import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Conversation } from "@/hooks/useConversations";
import { aeFamilies } from "./aeFamily";
import type { AeClosedInput } from "./aeFamilyClosed";
import {
  AE_FAMILIES_SECTION,
  AE_FAMILY_REST_SECTION,
  aeFamilyTree,
  aeWithFamiliesSection,
  resetAeFamilyFoldsCache,
  toggleAeFamilyFold,
  useAeEffectiveFolds,
  useAeStableTree,
} from "./aeFamilyTree";

function row(id: string, labels: Record<string, string> = {}, extra: Partial<Conversation> = {}) {
  return {
    id,
    object: "conversation",
    title: id,
    created_at: 0,
    updated_at: 0,
    labels,
    permission_level: null,
    status: "idle",
    ...extra,
  } as Conversation;
}

const orch = (id: string) => ({ "ae.orch": id });

function build(
  ordered: Conversation[],
  {
    folded = [] as string[],
    byLead = false,
    orphans = true,
    lookup = undefined as ((id: string) => Conversation | undefined) | undefined,
    closed = undefined as AeClosedInput | undefined,
  } = {},
) {
  return aeFamilyTree(ordered, aeFamilies(ordered, orphans), {
    folded: new Set(folded),
    byLead,
    lookup,
    closed,
  });
}

afterEach(() => {
  localStorage.clear();
  resetAeFamilyFoldsCache();
});

describe("aeFamilyTree", () => {
  it("puts families first, each lead then its sessions as a tree, then the rest in order", () => {
    const ordered = [
      row("rest1"),
      row("grandchild", orch("child1")),
      row("child2", orch("lead")),
      row("lead"),
      row("child1", orch("lead")),
      row("rest2"),
    ];
    const { sessions, groupTitles, groupOrder, tree } = build(ordered);
    // Each step keeps the list's order: child2 sorts ahead of child1.
    expect(sessions.map((c) => c.id)).toEqual([
      "lead",
      "child2",
      "child1",
      "grandchild",
      "rest1",
      "rest2",
    ]);
    expect(groupOrder).toEqual([AE_FAMILIES_SECTION, AE_FAMILY_REST_SECTION]);
    expect(groupTitles.get("grandchild")).toBe(AE_FAMILIES_SECTION);
    expect(groupTitles.get("rest1")).toBe(AE_FAMILY_REST_SECTION);
    expect(tree.familyCount).toBe(1);
    const at = (id: string) => tree.rows.get(id)!;
    expect(at("lead")).toMatchObject({ depth: 0, stem: true, more: false });
    expect(at("child2")).toMatchObject({ depth: 1, more: true, stem: false });
    expect(at("child1")).toMatchObject({ depth: 1, more: false, stem: true });
    // The last child's line ends at its own row, so none runs past the grandchild.
    expect(at("grandchild")).toMatchObject({ depth: 2, through: [false], more: false });
    expect(tree.leads.get("lead")).toMatchObject({ count: 3, folded: false, standIn: null });
  });

  it("ranks families by their first member, or by their lead under Manual", () => {
    const ordered = [row("b-child", orch("b")), row("a"), row("a-child", orch("a")), row("b")];
    expect(build(ordered).sessions.map((c) => c.id)).toEqual(["b", "b-child", "a", "a-child"]);
    expect(build(ordered, { byLead: true }).sessions.map((c) => c.id)).toEqual([
      "a",
      "a-child",
      "b",
      "b-child",
    ]);
  });

  it("folds a family to its lead, rolling up a waiting or running session", () => {
    const ordered = [
      row("lead"),
      row("waiting", orch("lead"), { pending_elicitations_count: 1 }),
      row("busy", orch("lead"), { status: "running" }),
      row("rest"),
    ];
    const { sessions, tree } = build(ordered, { folded: ["lead"] });
    expect(sessions.map((c) => c.id)).toEqual(["lead", "rest"]);
    expect(tree.rows.get("lead")!.stem).toBe(false);
    expect(tree.leads.get("lead")).toMatchObject({
      count: 2,
      folded: true,
      needsResponse: true,
      running: true,
    });
  });

  it("stands in for a lead that is not listed, as its own entry before its sessions", () => {
    const archived = row("gone", {}, { archived: true, title: "Old lead" });
    const ordered = [row("only", orch("gone")), row("rest")];
    const lookup = (id: string) => (id === "gone" ? archived : undefined);
    const { sessions, tree, groupTitles } = build(ordered, { lookup });
    expect(sessions.map((c) => c.id)).toEqual(["gone", "only", "rest"]);
    expect(groupTitles.get("gone")).toBe(AE_FAMILIES_SECTION);
    expect(tree.standIns.has("gone")).toBe(true);
    expect(tree.leads.get("gone")).toMatchObject({ count: 1, standIn: { lead: archived } });
    expect(tree.rows.get("gone")).toMatchObject({ depth: 0, stem: true });
    expect(tree.rows.get("only")).toMatchObject({ depth: 1, more: false });
    // Folded, the family's sessions leave the list; only the stand-in stays.
    const folded = build(ordered, { folded: ["gone"], lookup });
    expect(folded.sessions.map((c) => c.id)).toEqual(["gone", "rest"]);
    expect(folded.tree.rows.has("only")).toBe(false);
    expect(folded.tree.leads.get("gone")).toMatchObject({ folded: true });
  });

  it("stands in for an unknown lead with a stub entry of the lead's id", () => {
    const { sessions, tree } = build([row("a", orch("ghost")), row("b", orch("ghost"))], {
      folded: ["ghost"],
    });
    expect(sessions.map((c) => c.id)).toEqual(["ghost"]);
    expect(tree.leads.get("ghost")).toMatchObject({ standIn: { lead: null }, folded: true });
  });

  it("lists a pinned or filtered-out lead as its real row, not a copy without behavior", () => {
    const pinned = row("pinned-lead", {}, { title: "Pinned lead" });
    const { sessions, tree } = build([row("kid", orch("pinned-lead"))], {
      lookup: (id) => (id === "pinned-lead" ? pinned : undefined),
    });
    expect(sessions[0]).toBe(pinned);
    expect(tree.standIns.size).toBe(0);
    expect(tree.leads.get("pinned-lead")).toMatchObject({ standIn: null, count: 1 });
  });

  it("puts every member of an ae.orch cycle, and its tail, in one family", () => {
    const ordered = [row("D", orch("A")), row("A", orch("B")), row("B", orch("A")), row("rest")];
    const { sessions, tree, groupTitles } = build(ordered);
    const ids = sessions.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(tree.familyCount).toBe(1);
    expect(tree.standIns.size).toBe(0);
    expect(ids).toEqual(["A", "D", "B", "rest"]);
    expect(groupTitles.get("B")).toBe(AE_FAMILIES_SECTION);
  });

  it("makes a family from an ae.orch link only, not from an unloaded fork source", () => {
    const fork = row("f", { "omnigent.fork.source_id": "unloaded" });
    const twin = row("g", { "omnigent.fork.source_id": "unloaded" });
    const { tree, groupTitles } = build([fork, twin]);
    expect(tree.familyCount).toBe(0);
    expect(groupTitles.get("f")).toBe(AE_FAMILY_REST_SECTION);
    expect(build([row("k", orch("gone"))]).tree.familyCount).toBe(1);
  });

  it("lists a search match whose lead did not match in the rest, with no stand-in", () => {
    const ordered = [row("kid", orch("lead"))];
    const families = aeFamilies([row("lead"), ...ordered], true);
    const { sessions, tree, groupTitles } = aeFamilyTree(ordered, families, {
      folded: new Set(),
      byLead: false,
      searching: true,
    });
    expect(sessions.map((c) => c.id)).toEqual(["kid"]);
    expect(tree.familyCount).toBe(0);
    expect(groupTitles.get("kid")).toBe(AE_FAMILY_REST_SECTION);
  });

  it("caps the indent at two steps", () => {
    const ordered = [
      row("lead"),
      row("c1", orch("lead")),
      row("c2", orch("c1")),
      row("c3", orch("c2")),
      row("c4", orch("lead")),
      // A fork copies its source's ae.orch and still nests under its source.
      row("c4-fork", { "ae.orch": "lead", "omnigent.fork.source_id": "c4" }),
    ];
    const { sessions, tree } = build(ordered);
    const ids = sessions.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["lead", "c1", "c2", "c3", "c4", "c4-fork"]);
    expect(tree.rows.get("c4-fork")!.depth).toBe(2);
    expect(tree.rows.get("c3")!.depth).toBe(2);
    expect(tree.rows.get("c2")).toMatchObject({ depth: 2, through: [true], more: true });
  });

  it("puts an empty Families section first when no family shows", () => {
    const rest = [row("a")];
    const { tree } = build(rest);
    expect(
      aeWithFamiliesSection([{ title: AE_FAMILY_REST_SECTION, conversations: rest }], tree),
    ).toEqual([
      { title: AE_FAMILIES_SECTION, conversations: [] },
      { title: AE_FAMILY_REST_SECTION, conversations: rest },
    ]);
    expect(aeWithFamiliesSection([{ title: "Today", conversations: rest }], null)).toHaveLength(1);
  });
});

describe("family folds", () => {
  it("remembers a fold on this device", () => {
    toggleAeFamilyFold("lead");
    expect(JSON.parse(localStorage.getItem("omnigent:ae-family-folds")!)).toEqual(["lead"]);
    resetAeFamilyFoldsCache();
    toggleAeFamilyFold("lead");
    expect(JSON.parse(localStorage.getItem("omnigent:ae-family-folds")!)).toEqual([]);
  });
});

describe("family folds, as the open session sees them", () => {
  it("unfolds the open session's family for this visit, until a fold is toggled", () => {
    const folded = new Set(["lead"]);
    const { result, rerender } = renderHook(
      ({ remembered, active }) =>
        useAeEffectiveFolds(remembered, active, active === "lead" ? null : "lead"),
      { initialProps: { remembered: folded as ReadonlySet<string>, active: "kid" } },
    );
    expect(result.current.has("lead")).toBe(false);
    // Another session leaves the remembered fold alone.
    rerender({ remembered: folded, active: "lead" });
    expect(result.current.has("lead")).toBe(true);
    rerender({ remembered: folded, active: "kid" });
    expect(result.current.has("lead")).toBe(false);
    // A toggle ends the override, so the user's fold shows.
    rerender({ remembered: new Set(["lead"]), active: "kid" });
    expect(result.current.has("lead")).toBe(true);
  });

  it("sets a fold outright when asked", () => {
    toggleAeFamilyFold("lead", true);
    toggleAeFamilyFold("lead", true);
    expect(JSON.parse(localStorage.getItem("omnigent:ae-family-folds")!)).toEqual(["lead"]);
    toggleAeFamilyFold("lead", false);
    expect(JSON.parse(localStorage.getItem("omnigent:ae-family-folds")!)).toEqual([]);
  });
});

describe("useAeStableTree", () => {
  const treeFor = (updated: number, folded: string[] = []) => {
    const ordered = [
      row("lead", {}, { updated_at: updated }),
      row("kid", orch("lead"), { updated_at: updated }),
    ];
    return build(ordered, { folded }).tree;
  };

  it("keeps the same tree across an update that only changes a time", () => {
    const { result, rerender } = renderHook(({ tree }) => useAeStableTree(tree), {
      initialProps: { tree: treeFor(1) },
    });
    const first = result.current;
    rerender({ tree: treeFor(2) });
    expect(result.current).toBe(first);
    rerender({ tree: treeFor(3, ["lead"]) });
    expect(result.current).not.toBe(first);
  });
});

describe("aeFamilyTree closed rows", () => {
  const ref = { "ae.status": "reference" };
  const input = (over: Partial<AeClosedInput> = {}): AeClosedInput => ({
    archived: new Map(),
    open: new Set(),
    all: new Set(),
    ...over,
  });
  const base = () => [
    row("lead"),
    row("live", orch("lead")),
    row("read", { ...orch("lead"), "ae.status": "review" }),
    row("done1", { ...orch("lead"), ...ref }, { updated_at: 5 }),
  ];

  it("moves a reference child into a folded '1 closed' row and keeps a review child", () => {
    const { sessions, tree } = build(base());
    expect(sessions.map((c) => c.id)).toEqual(["lead", "live", "read", "ae-closed:lead:fold"]);
    expect(tree.closed.get("ae-closed:lead:fold")).toMatchObject({
      kind: "fold",
      count: 1,
      open: false,
    });
    expect(tree.rows.has("done1")).toBe(false);
    // The last open row's line runs on to the fold row.
    expect(tree.rows.get("read")).toMatchObject({ more: true });
    expect(tree.closed.get("ae-closed:lead:fold")!.row).toMatchObject({ depth: 1, more: false });
    expect(tree.unlisted.has("ae-closed:lead:fold")).toBe(true);
  });

  it("counts archived children and lists them newest first when the group is open", () => {
    const a1 = row("arch1", orch("lead"), { archived: true, updated_at: 9 });
    const a2 = row("arch2", orch("lead"), { archived: true, updated_at: 1 });
    const closed = input({ archived: new Map([["lead", [a2, a1]]]), open: new Set(["lead"]) });
    const { sessions, tree } = build(base(), { closed });
    expect(sessions.map((c) => c.id)).toEqual([
      "lead",
      "live",
      "read",
      "ae-closed:lead:fold",
      "arch1",
      "done1",
      "arch2",
    ]);
    expect(tree.leads.get("lead")).toMatchObject({
      count: 5,
      closed: { total: 5, open: 2, closed: 3, archived: 2, working: 1, review: 1 },
    });
    expect(tree.closed.get("arch1")).toMatchObject({ kind: "row" });
  });

  it("shows 5, then 'Show N more' that reveals the rest", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      row(`c${i}`, { ...orch("lead"), ...ref }, { updated_at: 100 - i }),
    );
    const ordered = [row("lead"), ...many];
    const shortList = build(ordered, { closed: input({ open: new Set(["lead"]) }) });
    const ids = shortList.sessions.map((c) => c.id);
    expect(ids).toEqual([
      "lead",
      "ae-closed:lead:fold",
      "c0",
      "c1",
      "c2",
      "c3",
      "c4",
      "ae-closed:lead:more",
    ]);
    expect(shortList.tree.closed.get("ae-closed:lead:more")).toMatchObject({ hidden: 3 });
    const all = build(ordered, {
      closed: input({ open: new Set(["lead"]), all: new Set(["lead"]) }),
    });
    expect(all.sessions).toHaveLength(10);
    expect(all.tree.closed.has("ae-closed:lead:more")).toBe(false);
  });

  it("leaves a family with no closed members unchanged", () => {
    const { sessions, tree } = build([row("lead"), row("a", orch("lead"))]);
    expect(sessions.map((c) => c.id)).toEqual(["lead", "a"]);
    expect(tree.closed.size).toBe(0);
    expect(tree.leads.get("lead")).toMatchObject({ count: 1, closed: null });
    expect(tree.unlisted).toBe(tree.standIns);
  });

  it("keeps the tree signature through a time bump on a closed row", () => {
    const { result, rerender } = renderHook(
      ({ t }) =>
        useAeStableTree(
          build(base().map((c) => (c.id === "done1" ? { ...c, updated_at: t } : c))).tree,
        ),
      {
        initialProps: { t: 5 },
      },
    );
    const first = result.current;
    rerender({ t: 6 });
    expect(result.current).toBe(first);
  });

  it("treats a listed archived member as closed and counts it as archived", () => {
    const { sessions, tree } = build([
      row("lead"),
      row("live", orch("lead")),
      row("shelved", orch("lead"), { archived: true }),
    ]);
    expect(sessions.map((c) => c.id)).toEqual(["lead", "live", "ae-closed:lead:fold"]);
    expect(tree.leads.get("lead")!.closed).toMatchObject({ closed: 1, archived: 1, open: 1 });
  });

  it("marks every lead when the archived read stopped at its cap", () => {
    const { tree } = build([row("lead"), row("a", orch("lead"))], {
      closed: input({ capped: true }),
    });
    expect(tree.leads.get("lead")!.archivedCapped).toBe(true);
  });
});
