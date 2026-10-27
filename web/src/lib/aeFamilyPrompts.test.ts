import { describe, expect, it } from "vitest";
import { parseEvent } from "@/lib/sse";
import { BlockStream } from "@/lib/blockStream";
import type { AnyBlock, ElicitationBlock } from "@/lib/blocks";
import {
  aeFamilyPrompts,
  aeIsFamilyPrompt,
  aeParksThisTurn,
  aeWithoutFamilyPrompts,
} from "@/lib/aeFamilyPrompts";

const ctx = { agent: null, depth: 0, turn: 1, timestamp: 0, responseId: "r1", itemId: "i1" };

function prompt(over: Partial<ElicitationBlock>): ElicitationBlock {
  return {
    type: "elicitation",
    ctx,
    elicitationId: "e1",
    message: "Approve?",
    phase: "tool_call",
    policyName: "",
    contentPreview: "",
    requestedSchema: {},
    status: "pending",
    response: null,
    ...over,
  };
}

const text = { type: "text_done", ctx, fullText: "hi", hasCodeBlocks: false } as AnyBlock;
const mirror = prompt({
  elicitationId: "fam",
  targetSessionId: "conv_child",
  familyChild: { title: "Halcyon Orbital" },
});
const subAgent = prompt({ elicitationId: "sub", targetSessionId: "conv_sub" });
const own = prompt({ elicitationId: "own" });

describe("family child prompts", () => {
  it("keeps family mirrors out of the feed and leaves sub-agent mirrors and own prompts", () => {
    const blocks = [text, mirror, subAgent, own];
    expect(aeWithoutFamilyPrompts(blocks).map((b) => b.type)).toEqual([
      "text_done",
      "elicitation",
      "elicitation",
    ]);
    expect(aeWithoutFamilyPrompts(blocks).filter((b) => b.type === "elicitation").length).toBe(2);
    expect(aeIsFamilyPrompt(subAgent)).toBe(false);
    expect(aeIsFamilyPrompt(own)).toBe(false);
  });

  it("returns the same array when there is nothing to remove", () => {
    const blocks = [text, subAgent, own];
    expect(aeWithoutFamilyPrompts(blocks)).toBe(blocks);
  });

  it("lists only pending family prompts that name a child", () => {
    const answered = { ...mirror, elicitationId: "done", status: "responded" } as ElicitationBlock;
    const orphan = { ...mirror, elicitationId: "orphan", targetSessionId: null };
    expect(
      aeFamilyPrompts([text, mirror, answered, orphan, subAgent]).map((b) => b.elicitationId),
    ).toEqual(["fam"]);
  });

  it("carries the marker from the stream event to the block", () => {
    const event = parseEvent("response.elicitation_request", {
      elicitation_id: "e9",
      params: {
        message: "Keep it?",
        target_session_id: "conv_child",
        ae_family_child: true,
        ae_requester_title: "Halcyon Orbital",
      },
    });
    expect(event).toMatchObject({
      targetSessionId: "conv_child",
      familyChild: { title: "Halcyon Orbital" },
    });
    const plain = parseEvent("response.elicitation_request", {
      elicitation_id: "e8",
      params: { message: "x", target_session_id: "conv_sub" },
    });
    expect(plain).not.toHaveProperty("familyChild");
    const blocks = new BlockStream().reduceSync([event!]);
    expect(blocks.find((b) => b.type === "elicitation")).toMatchObject({
      familyChild: { title: "Halcyon Orbital" },
    });
  });
});

describe("which prompts park this turn", () => {
  it("counts its own prompt but not a mirrored child's or sub-agent's", () => {
    expect(aeParksThisTurn(own, "s1")).toBe(true);
    expect(aeParksThisTurn({ ...own, targetSessionId: "s1" } as ElicitationBlock, "s1")).toBe(true);
    expect(aeParksThisTurn(mirror, "s1")).toBe(false);
    expect(aeParksThisTurn(subAgent, "s1")).toBe(false);
    expect(aeParksThisTurn({ ...own, status: "responded" } as ElicitationBlock, "s1")).toBe(false);
    expect(aeParksThisTurn(text, "s1")).toBe(false);
  });
});
