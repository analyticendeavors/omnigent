import { describe, expect, it } from "vitest";
import { subagentStepNote } from "./aeRailSubagentSteps";

const call = (name: string, args: unknown) => ({
  type: "function_call",
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});

describe("subagentStepNote", () => {
  it("prefers the call's own description", () => {
    expect(subagentStepNote(call("Bash", { command: "ls", description: "List files" }))).toBe(
      "List files",
    );
  });

  it("names the file, pattern or tool when the call has no description", () => {
    expect(subagentStepNote(call("Read", { file_path: "/x/y/z.ts" }))).toBe("Reading z.ts");
    expect(subagentStepNote(call("Edit", { file_path: "C:\\x\\a.md" }))).toBe("Editing a.md");
    expect(subagentStepNote(call("Grep", { pattern: "childStatus" }))).toBe(
      "Searching for childStatus",
    );
    expect(subagentStepNote(call("SubagentHandback", { message: "done" }))).toBe("Reporting back");
    expect(subagentStepNote(call("TodoWrite", "not json"))).toBe("Using TodoWrite");
  });

  it("names only Claude Code's own tools by their arguments", () => {
    expect(subagentStepNote(call("ToolSearch", { query: "select:Read" }))).toBe("Using ToolSearch");
    expect(subagentStepNote(call("mcp__files__view", { file_path: "/a.ts" }))).toBe(
      "Using mcp__files__view",
    );
    expect(subagentStepNote(call("WebSearch", { query: "vitest" }))).toBe(
      "Searching the web for vitest",
    );
  });

  it("ignores items that are not tool calls", () => {
    expect(subagentStepNote({ type: "message", role: "user" })).toBeNull();
    expect(subagentStepNote({ type: "function_call_output", output: "x" })).toBeNull();
    expect(subagentStepNote(null)).toBeNull();
  });
});
