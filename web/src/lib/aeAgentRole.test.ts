import { describe, expect, it } from "vitest";
import { aeAgentRole, aeFormatTokens, aeRoleName } from "./aeAgentRole";

describe("aeAgentRole", () => {
  it("reads the ae.role label", () => {
    expect(aeAgentRole({ labels: { "ae.role": "builder" } })).toBe("builder");
  });
  it("does not read a role from the title", () => {
    expect(aeAgentRole({ title: "Builder A: x" } as never)).toBeNull();
  });
  it("ignores an unknown label and falls back to the Role line", () => {
    expect(
      aeAgentRole({ labels: { "ae.role": "boss" }, task_summary: "  role: Reviewer.\nx" }),
    ).toBe("reviewer");
  });
  it("reads the Role line from the description label", () => {
    expect(aeAgentRole({ labels: { "omnigent.claude_native.description": "Role: Helper." } })).toBe(
      "helper",
    );
  });
  it("is null with neither", () => {
    expect(aeAgentRole({ labels: {}, task_summary: "Do a Role: Builder thing" })).toBeNull();
    expect(aeAgentRole({ task_summary: "Role: Wizard." })).toBeNull();
  });
  it.each([
    "Builder A: x",
    "Reviewer 2: x",
    "Helper: watch PR",
    "Role: Planner: x",
    "Role: Builder.",
  ])("reads the role from the description %j", (text) => {
    expect(aeAgentRole({ task_summary: text })).not.toBeNull();
  });
  it.each([
    "Review more-starters diff",
    "Helpers list",
    "Build the thing",
    "Builder notes",
    "Helper functions: refactor",
    "Lead the migration: x",
    "Builder pattern: compare",
  ])("does not read a role from %j", (text) => {
    expect(aeAgentRole({ task_summary: text })).toBeNull();
  });
  it("names a role", () => {
    expect(aeRoleName("builder")).toBe("Builder");
  });
});

describe("aeFormatTokens", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [9000, "9k"],
    [116_400, "116.4k"],
    [116_040, "116k"],
    [999_999, "999.9k"],
    [999_950, "999.9k"],
    [1_240_000, "1.24M"],
    [1_000_000, "1M"],
  ])("%s", (n, text) => {
    expect(aeFormatTokens(n)).toBe(text);
  });
});
