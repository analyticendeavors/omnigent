import { describe, expect, it } from "vitest";
import type { AnyBlock } from "@/lib/blocks";
import { aeNativeAgentInput, aeNativeAgentInputs, aeNativeModelLabel } from "./aeNativeAgentInput";

const group = (name: string, callId: string, args: Record<string, unknown>) =>
  ({
    type: "tool_group",
    executions: [{ name, callId, arguments: args }],
  }) as unknown as AnyBlock;

describe("aeNativeAgentInputs", () => {
  it("reads model and effort from Agent calls only", () => {
    const inputs = aeNativeAgentInputs([
      group("Agent", "t1", { model: "sonnet", effort: "medium", prompt: "x" }),
      group("Bash", "t2", { model: "opus" }),
      group("Task", "t3", { prompt: "no model" }),
    ]);
    expect(inputs).toEqual({ t1: { model: "sonnet", effort: "medium" } });
  });

  it("matches a child by its tool_use_id label", () => {
    const inputs = { t1: { model: "haiku", effort: null } };
    expect(
      aeNativeAgentInput(inputs, { labels: { "omnigent.claude_native.tool_use_id": "t1" } }),
    ).toEqual({ model: "haiku", effort: null });
    expect(aeNativeAgentInput(inputs, { labels: {} })).toBeNull();
  });

  it("capitalizes a tier alias and leaves a full id", () => {
    expect(aeNativeModelLabel("sonnet")).toBe("Sonnet");
    expect(aeNativeModelLabel("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  });
});
