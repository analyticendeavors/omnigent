import { describe, expect, it } from "vitest";
import {
  type AeRolePreset,
  type AeRolesDoc,
  aeDeletePreset,
  aeDropPreset,
  aeDuplicatePreset,
  aeIsTopTierEverywhere,
  aeOneLine,
  aeParseRolesState,
  aeRolesDoc,
  aePresetId,
  aeRestoreStarters,
  aeSetPinned,
  aeTopModel,
  aeWithInsights,
} from "./aeRoles";

const preset = (id: string, pinned = false): AeRolePreset => ({
  id,
  title: id,
  icon: "star",
  color: "teal",
  description: "",
  when_to_use: "",
  pinned,
  roles: {
    lead: { mode: "session" },
    planner: { mode: "auto" },
    reviewer: { mode: "auto" },
    builder: { mode: "auto" },
    helper: { mode: "auto" },
  },
  rules: { raise_or_lower: "tell", lead_steps_down: true, auto_raises: 1 },
});

const doc = (presets: AeRolePreset[], default_preset = presets[0].id): AeRolesDoc => ({
  revision: 1,
  default_preset,
  apply_start_on: true,
  presets,
});

const ids = (d: AeRolesDoc) => d.presets.map((p) => `${p.id}${p.pinned ? "*" : ""}`);

describe("aeRoles", () => {
  it("makes unique slugs", () => {
    expect(aePresetId("Deep debug!", [])).toBe("deep-debug");
    expect(aePresetId("Deep debug", ["deep-debug"])).toBe("deep-debug-2");
    expect(aePresetId("   ", [])).toBe("preset");
    expect(aePresetId("Lead picks", [])).toBe("lead-picks-2");
  });

  it("keeps notes to one line without control characters", () => {
    expect(aeOneLine(" a\n\tb\u2028c ")).toBe("a b c");
  });

  it("moves the default to the first preset when the default is deleted, never deletes the last", () => {
    expect(aeDeletePreset(doc([preset("a"), preset("b")], "b"), "b").default_preset).toBe("a");
    expect(aeDeletePreset(doc([preset("a"), preset("b")], "b"), "a").default_preset).toBe("b");
    const one = doc([preset("a")]);
    expect(aeDeletePreset(one, "a")).toBe(one);
  });

  it("keeps pinned presets first when pinning and dropping", () => {
    const d = doc([preset("a", true), preset("b"), preset("c")]);
    expect(ids(aeSetPinned(d, "c", true))).toEqual(["a*", "c*", "b"]);
    expect(ids(aeSetPinned(d, "a", false))).toEqual(["a", "b", "c"]);
    expect(ids(aeDropPreset(d, "c", "a"))).toEqual(["c*", "a*", "b"]);
    expect(ids(aeDropPreset(d, "a", "c"))).toEqual(["b", "c", "a"]);
  });

  it("restores only missing starters", () => {
    const { doc: next, added } = aeRestoreStarters(doc([preset("b")]), [preset("a"), preset("b")]);
    expect(added.map((p) => p.id)).toEqual(["a"]);
    expect(ids(next)).toEqual(["b", "a"]);
  });

  it("finds the top model and the top tier everywhere", () => {
    expect(aeTopModel(["claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-5-5"])).toBe(
      "claude-fable-5-1",
    );
    const max = { mode: "fixed", model: "claude-fable-5-1", effort: "max" } as const;
    const roles = { lead: max, planner: max, reviewer: max, builder: max, helper: max };
    expect(aeIsTopTierEverywhere(roles, ["claude-opus-5-5", "claude-fable-5-1"])).toBe(true);
    expect(aeIsTopTierEverywhere(roles, [])).toBe(true);
    expect(
      aeIsTopTierEverywhere({ ...roles, lead: { mode: "session" } }, ["claude-fable-5-1"]),
    ).toBe(false);
    expect(
      aeIsTopTierEverywhere({ ...roles, helper: { ...max, model: "claude-opus-5-5" } }, [
        "claude-fable-5-1",
      ]),
    ).toBe(false);
  });

  it("parses the server's state and rejects a malformed one", () => {
    const body = { ...doc([preset("a")]), starters: [preset("a")] };
    expect(aeParseRolesState(body)?.presets).toHaveLength(1);
    expect(aeParseRolesState({ ...body, revision: -1 })).toBeNull();
    expect(
      aeParseRolesState({
        ...body,
        presets: [{ ...preset("a"), roles: { ...preset("a").roles, lead: { mode: "fixed" } } }],
      }),
    ).toBeNull();
  });

  it("carries the insights setting through a read and a save, and leaves it out when absent", () => {
    const insights = { enabled: true, weeks: 4, scope: "own" } as const;
    const body = { ...doc([preset("a")]), starters: [], insights };
    const state = aeParseRolesState(body);
    expect(state?.insights).toEqual(insights);
    expect(aeRolesDoc(state as AeRolesDoc).insights).toEqual(insights);
    expect(aeParseRolesState({ ...body, insights: { enabled: "yes" } })?.insights).toBeUndefined();
    expect(aeParseRolesState({ ...body, insights: null })?.insights).toBeUndefined();
    const often = { ...insights, frequency: "monthly" };
    expect(aeParseRolesState({ ...body, insights: often })?.insights).toEqual(often);
    expect(
      aeParseRolesState({ ...body, insights: { ...insights, frequency: "daily" } })?.insights,
    ).toEqual(insights);
    const shown = { ...insights, show: "tokens" };
    expect(aeParseRolesState({ ...body, insights: shown })?.insights).toEqual(shown);
    expect(aeParseRolesState({ ...body, insights: { ...insights, show: "x" } })?.insights).toEqual(
      insights,
    );
    expect("insights" in aeRolesDoc(doc([preset("a")]))).toBe(false);
  });

  it("aeWithInsights replaces the setting and keeps the rest of the doc", () => {
    const base = {
      ...doc([preset("a")]),
      starters: [],
      insights: { enabled: false, weeks: 2, scope: "all" },
    } as const;
    const next = aeWithInsights(base as AeRolesDoc, { enabled: true, weeks: 2, scope: "own" });
    expect(next.insights).toEqual({ enabled: true, weeks: 2, scope: "own" });
    expect(next.revision).toBe(base.revision);
    expect(next.presets).toEqual(base.presets);
    expect("starters" in next).toBe(false);
  });

  it("trims a long title by code points so the copy fits 40 without splitting a pair", () => {
    const long = { ...preset("a"), title: "😀".repeat(40) };
    const { doc: next } = aeDuplicatePreset(doc([long]), long);
    const title = next.presets[1].title;
    expect(Array.from(title)).toHaveLength(40);
    expect(title.endsWith(" copy")).toBe(true);
    expect(title).toBe(`${"😀".repeat(35)} copy`);
    const short = { ...preset("b"), title: "Plan" };
    expect(aeDuplicatePreset(doc([short]), short).doc.presets[1].title).toBe("Plan copy");
  });
});
