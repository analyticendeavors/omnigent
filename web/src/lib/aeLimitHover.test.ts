import { describe, expect, it } from "vitest";
import type { AeLimitWindow } from "@/components/AePlanLimits";
import type { AeLimitGate } from "./aeLimitGate";
import { aeLimitHoverRows, aeLimitLevel } from "./aeLimitHover";

const RESET = "2026-10-30T09:00:00Z";
const NOW = Date.parse("2026-10-28T12:00:00Z");

function win(id: string, label: string, used: number, minutes: number | null): AeLimitWindow {
  return { id, label, used_percent: used, resets_at: RESET, window_minutes: minutes };
}

const GATE: AeLimitGate = {
  harness: "claude",
  account: null,
  label: "AE Default",
  windowId: "seven_day",
  windowKey: "claude||seven_day",
  span: "weekly",
  percent: 91,
  resetsAt: RESET,
};

const WINDOWS = [
  win("seven_day_sonnet", "Weekly, Sonnet", 42, 10080),
  win("seven_day_opus", "Weekly, Opus", 94, 10080),
  win("seven_day", "Weekly, all models", 91, 10080),
  win("five_hour", "5-hour", 37.6, 300),
];

describe("aeLimitLevel", () => {
  it("is red from 90, amber from 70, green below", () => {
    expect([69, 70, 89, 90].map(aeLimitLevel)).toEqual(["ok", "mid", "mid", "warn"]);
  });
});

describe("aeLimitHoverRows", () => {
  it("puts the 5-hour and all-models weekly rows first, then the rest fullest first", () => {
    const rows = aeLimitHoverRows(WINDOWS, GATE, NOW);
    expect(rows.map((r) => r.id)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_opus",
      "seven_day_sonnet",
    ]);
  });

  it("reads Weekly, X as Weekly · X, rounds, and marks the gate's own window", () => {
    const rows = aeLimitHoverRows(WINDOWS, GATE, NOW);
    expect(rows.map((r) => r.label)).toEqual([
      "5-hour",
      "Weekly · all models",
      "Weekly · Opus",
      "Weekly · Sonnet",
    ]);
    expect(rows[0]!.percent).toBe(38);
    expect(rows.filter((r) => r.isGate).map((r) => r.id)).toEqual(["seven_day"]);
    expect(rows.map((r) => r.level)).toEqual(["ok", "warn", "warn", "ok"]);
  });

  it("drops a window whose reset has passed", () => {
    const old = { ...win("five_hour", "5-hour", 97, 300), resets_at: "2026-10-28T12:00:00Z" };
    const rows = aeLimitHoverRows(
      [old, ...WINDOWS.slice(0, 3)],
      GATE,
      Date.parse("2026-10-28T13:00:00Z"),
    );
    expect(rows.map((r) => r.id)).not.toContain("five_hour");
  });

  it("colours by the raw reading, as the gate compares it", () => {
    const rows = aeLimitHoverRows([win("seven_day", "Weekly, all models", 89.6, 10080)], GATE, NOW);
    expect(rows[0]!.percent).toBe(90);
    expect(rows[0]!.level).toBe("mid");
  });

  it("drops a window with no usable percentage and answers [] for none", () => {
    const bad = { ...win("x", "Weekly, X", Number.NaN, 10080) };
    expect(aeLimitHoverRows([bad], GATE, NOW)).toEqual([]);
    expect(aeLimitHoverRows([], GATE, NOW)).toEqual([]);
  });
});
