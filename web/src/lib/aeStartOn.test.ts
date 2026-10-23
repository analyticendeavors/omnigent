import { describe, expect, it } from "vitest";
import type { AeRolePreset } from "./aeRoles";
import { aeParseStartOn, aeStartOnLine } from "./aeStartOn";
import type { NativeModelOption } from "./types";

const preset = (id: string, title: string): AeRolePreset => ({
  id,
  title,
  icon: "scale",
  color: "teal",
  description: "",
  when_to_use: "",
  pinned: false,
  roles: {
    lead: { mode: "session" },
    planner: { mode: "auto" },
    reviewer: { mode: "auto" },
    builder: { mode: "auto" },
    helper: { mode: "auto" },
  },
  rules: { raise_or_lower: "tell", lead_steps_down: true, auto_raises: 1 },
});
const PRESETS = [preset("balanced", "Balanced"), preset("deep-debug", "Deep debug")];
const MODELS: NativeModelOption[] = [
  { id: "opus", model: "claude-opus-5-5", displayName: "Opus 5.5" },
  { id: "sonnet", model: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", displayName: "Haiku 5.5" },
];
const parse = (text: string) => aeParseStartOn(text, PRESETS, MODELS);

describe("aeStartOnLine", () => {
  it("finds the first START ON line, any case, through markdown", () => {
    expect(aeStartOnLine('HANDOFF: x\n**START ON:** preset "Balanced"\nSTART ON: YOLO')).toBe(
      'preset "Balanced"',
    );
    expect(aeStartOnLine("  start on: Opus 5.5 high")).toBe("Opus 5.5 high");
    expect(aeStartOnLine("we should start on: monday? no")).toBeNull();
    expect(aeStartOnLine("no line here")).toBeNull();
  });
});

describe("aeParseStartOn", () => {
  it.each([
    ['START ON: preset "Balanced"', "balanced"],
    ["START ON: balanced", "balanced"],
    ['START ON: preset "Deep debug", with one change\n  Helper Sonnet 5.5 low', "deep-debug"],
    ["START ON: Deep Debug plus Helper Sonnet 5.5 low", "deep-debug"],
    ["START ON: deep-debug", "deep-debug"],
    ["START ON: Lead picks", "lead-picks"],
  ])("reads %j as a preset", (text, id) => {
    expect(parse(text)).toMatchObject({ kind: "preset", presetId: id });
  });

  it.each([
    ["START ON: Opus 5.5 high", "opus", "high", "Opus 5.5 high"],
    ["START ON: no preset, Sonnet 5.5 medium solo", "sonnet", "medium", "Sonnet 5.5 medium"],
    ["START ON: claude-opus-5-5 xhigh", "opus", "xhigh", "Opus 5.5 xhigh"],
    ["START ON: Haiku 5.5", "claude-haiku-5-5", null, "Haiku 5.5"],
  ])("reads %j as a model", (text, model, effort, label) => {
    expect(parse(text)).toEqual({ kind: "model", model, effort, label });
  });

  it("returns null for a line it cannot read", () => {
    expect(parse("START ON: whatever feels right")).toBeNull();
    expect(parse("START ON:")).toBeNull();
    expect(parse("just a message")).toBeNull();
  });
});
