import { describe, expect, it } from "vitest";
import type { AeRolePreset } from "@/lib/aeRoles";
import { aePresetMenuGroups } from "./aePresetMenu";

const make = (id: string, pinned: boolean) => ({ id, pinned }) as AeRolePreset;
const ids = (list: AeRolePreset[]) => list.map((p) => p.id);

describe("aePresetMenuGroups", () => {
  const presets = [make("a", true), make("b", false), make("c", true), make("d", false)];

  it("puts pinned presets up front in saved order and hides the rest", () => {
    const groups = aePresetMenuGroups(presets, "a");
    expect(groups.heading).toBe("Pinned");
    expect(ids(groups.top)).toEqual(["a", "c"]);
    expect(ids(groups.hidden)).toEqual(["b", "d"]);
  });

  it("keeps an active unpinned preset in the top group at its list position", () => {
    const groups = aePresetMenuGroups(presets, "b");
    expect(ids(groups.top)).toEqual(["a", "b", "c"]);
    expect(ids(groups.hidden)).toEqual(["d"]);
  });

  it("shows everything under All presets when nothing is pinned", () => {
    const none = [make("a", false), make("b", false)];
    const groups = aePresetMenuGroups(none, "b");
    expect(groups.heading).toBe("All presets");
    expect(ids(groups.top)).toEqual(["a", "b"]);
    expect(groups.hidden).toEqual([]);
  });

  it("hides nothing when every preset is pinned", () => {
    expect(aePresetMenuGroups([make("a", true), make("b", true)], "x").hidden).toEqual([]);
  });

  it("treats Lead picks (an id no preset has) as no active preset", () => {
    const groups = aePresetMenuGroups(presets, "lead-picks");
    expect(ids(groups.top)).toEqual(["a", "c"]);
  });
});
