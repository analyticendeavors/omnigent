// A Claude native subagent's model and effort, read from the lead's Agent tool
// call (its input names a tier alias and an effort). The child session itself
// carries neither, so a row matches its call by the `tool_use_id` label.

import type { AnyBlock } from "@/lib/blocks";

export interface AeNativeAgentInput {
  model: string | null;
  effort: string | null;
}

const AGENT_TOOLS = new Set(["Agent", "Task"]);
const TOOL_USE_ID_LABEL = "omnigent.claude_native.tool_use_id";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Agent tool calls in *blocks*, by call id; calls that name neither model nor effort are left out. */
export function aeNativeAgentInputs(
  blocks: readonly AnyBlock[],
): Record<string, AeNativeAgentInput> {
  const out: Record<string, AeNativeAgentInput> = {};
  for (const block of blocks) {
    if (block.type !== "tool_group") continue;
    for (const call of block.executions) {
      if (!AGENT_TOOLS.has(call.name)) continue;
      const model = text(call.arguments?.model);
      const effort = text(call.arguments?.effort);
      if (model || effort) out[call.callId] = { model, effort };
    }
  }
  return out;
}

/** The input of the call that started *child*, or null when unknown. */
export function aeNativeAgentInput(
  inputs: Readonly<Record<string, AeNativeAgentInput>>,
  child: { labels?: Record<string, string> | null },
): AeNativeAgentInput | null {
  const id = child.labels?.[TOOL_USE_ID_LABEL];
  return (id && inputs[id]) || null;
}

/** "sonnet" reads "Sonnet"; a full model id stays as it is. */
export function aeNativeModelLabel(model: string): string {
  return /^[a-z]+$/.test(model) ? model[0].toUpperCase() + model.slice(1) : model;
}
