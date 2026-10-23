import { describe, expect, it, vi } from "vitest";
import { aeRowIconCount, aeRowOrder, type AeRolePreset } from "./aeRoles";
import {
  AE_RECENT_PRESETS_KEY,
  AE_SUPERSEDED,
  aeLatestWins,
  aePresetDigit,
  aeReadRecentPresets,
  aeRememberPreset,
  aeResolveSessionPreset,
  aeRolesForPick,
  aeTeamLabelWithRoles,
  readAeSessionRoles,
} from "./aeSessionRoles";

const preset = (id: string, pinned = false): AeRolePreset => ({
  id,
  title: id,
  icon: "scale",
  color: "teal",
  description: "",
  when_to_use: "",
  pinned,
  roles: {
    lead: { mode: "session" },
    planner: { mode: "fixed", model: "claude-opus-5-5", effort: "high" },
    reviewer: { mode: "auto" },
    builder: { mode: "auto" },
    helper: { mode: "auto" },
  },
  rules: { raise_or_lower: "tell", lead_steps_down: true, auto_raises: 1 },
});
const STATE = { default_preset: "b", presets: [preset("a"), preset("b"), preset("c")] };

describe("session roles label", () => {
  it("keeps every other field when setting or clearing roles", () => {
    const labels = {
      "ae.team": JSON.stringify({ version: 1, mode: "team", members: [{ x: 1 }], extra: true }),
    };
    const set = JSON.parse(aeTeamLabelWithRoles(labels, { preset: "a" }));
    expect(set).toEqual({
      version: 1,
      mode: "team",
      members: [{ x: 1 }],
      extra: true,
      roles: { preset: "a" },
    });
    const cleared = JSON.parse(aeTeamLabelWithRoles({ "ae.team": JSON.stringify(set) }, null));
    expect(cleared).not.toHaveProperty("roles");
    expect(cleared.mode).toBe("team");
  });

  it("starts a missing label as Auto", () => {
    expect(JSON.parse(aeTeamLabelWithRoles(undefined, { preset: "lead-picks" }))).toEqual({
      version: 1,
      mode: "auto",
      members: [],
      roles: { preset: "lead-picks" },
    });
  });

  it("reads valid roles and keeps a custom block it cannot read as stored", () => {
    const custom = { roles: preset("x").roles, rules: preset("x").rules };
    const label = (roles: unknown) => ({ "ae.team": JSON.stringify({ version: 1, roles }) });
    expect(readAeSessionRoles(label({ preset: "a", custom }))).toEqual({ preset: "a", custom });
    const newer = { preset: "a", custom: { roles: {} } };
    const unread = readAeSessionRoles(label(newer));
    expect(unread).toMatchObject({ preset: "a", raw: newer });
    expect(unread).not.toHaveProperty("custom");
    // Written back unchanged, and a new pick replaces it.
    const labels = label(newer);
    expect(JSON.parse(aeTeamLabelWithRoles(labels, unread)).roles).toEqual(newer);
    expect(JSON.parse(aeTeamLabelWithRoles(labels, { preset: "b" })).roles).toEqual({
      preset: "b",
    });
    expect(readAeSessionRoles(label({ preset: "a", custom: "x" }))).toMatchObject({
      raw: { custom: "x" },
    });
    expect(readAeSessionRoles(label({ nope: 1 }))).toBeNull();
  });

  it("resolves absent or unknown to the default and the default pick to no field", () => {
    expect(aeResolveSessionPreset(null, STATE)).toMatchObject({ preset: { id: "b" } });
    expect(aeResolveSessionPreset({ preset: "gone" }, STATE)).toMatchObject({
      preset: { id: "b" },
      edited: false,
    });
    expect(aeResolveSessionPreset({ preset: "lead-picks" }, STATE)).toEqual({ kind: "lead-picks" });
    expect(aeRolesForPick("b", "b")).toBeNull();
    expect(aeRolesForPick("a", "b")).toEqual({ preset: "a" });
  });

  it("matches Alt+1..9 on the physical key with no other modifier", () => {
    const key = (code: string, extra: Partial<KeyboardEvent> = {}) => ({
      code,
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...extra,
    });
    expect(aePresetDigit(key("Digit1"))).toBe(0);
    expect(aePresetDigit(key("Digit9"))).toBe(8);
    expect(aePresetDigit(key("Digit0"))).toBeNull();
    expect(aePresetDigit(key("Digit2", { shiftKey: true }))).toBeNull();
    expect(aePresetDigit(key("Digit2", { altKey: false }))).toBeNull();
  });
});

describe("collapsed row fit", () => {
  it("orders open, default, pinned, then the rest", () => {
    const list = [preset("a"), preset("b"), preset("c", true), preset("d")];
    expect(aeRowOrder(list, "d", "b").map((p) => p.id)).toEqual(["d", "b", "c", "a"]);
  });

  it("shows every icon when all fit and keeps room for +N when not", () => {
    expect(aeRowIconCount(900, 200, 2)).toBe(2);
    expect(aeRowIconCount(300, 200, 5)).toBe(1);
    expect(aeRowIconCount(0, 200, 5)).toBe(0);
  });
});

describe("recent presets and write order", () => {
  it("never stores lead-picks among the recent presets", () => {
    window.localStorage.removeItem(AE_RECENT_PRESETS_KEY);
    aeRememberPreset("a");
    aeRememberPreset("lead-picks");
    expect(aeReadRecentPresets()).toEqual(["a"]);
  });

  it("runs writes for one session in order and lets the latest pending one win", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const first = aeLatestWins("s", async () => {
      order.push("first");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "first";
    });
    await vi.waitFor(() => expect(order).toEqual(["first"]));
    const second = aeLatestWins("s", async () => {
      order.push("second");
      return "second";
    });
    const third = aeLatestWins("s", async () => {
      order.push("third");
      return "third";
    });
    const other = aeLatestWins("t", async () => "other");
    release();
    expect(await first).toBe("first");
    expect(await second).toBe(AE_SUPERSEDED);
    expect(await third).toBe("third");
    expect(await other).toBe("other");
    expect(order).toEqual(["first", "third"]);
  });

  it("keeps going after a write fails", async () => {
    await expect(aeLatestWins("f", () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(await aeLatestWins("f", async () => "ok")).toBe("ok");
  });
});
