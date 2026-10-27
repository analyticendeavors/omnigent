// A family child's prompts in its lead's chat (omnigent-ae, 2026-10-27). The server mirrors a
// session's AskUserQuestion or permission prompt into its lead's stream, marked with the
// child's title (omnigent/server/ae_family_prompts.py). The lead's transcript skips those
// blocks and the action dock shows them instead, resolving in the child. Kept out of the
// components: the vitest suites mock whole component modules.

import type { AnyBlock, ElicitationBlock } from "@/lib/blocks";

/** A prompt the server marked as a family child's, mirrored into this chat. */
export function aeIsFamilyPrompt(block: AnyBlock): block is ElicitationBlock {
  return block.type === "elicitation" && Boolean(block.familyChild);
}

/** `blocks` without family-child prompts; the same array when it has none. */
export function aeWithoutFamilyPrompts(blocks: readonly AnyBlock[]): AnyBlock[] {
  return blocks.some(aeIsFamilyPrompt)
    ? blocks.filter((block) => !aeIsFamilyPrompt(block))
    : (blocks as AnyBlock[]);
}

/** The family children's prompts still waiting, oldest first. */
export function aeFamilyPrompts(blocks: readonly AnyBlock[]): ElicitationBlock[] {
  return blocks.filter(
    (block): block is ElicitationBlock =>
      aeIsFamilyPrompt(block) && block.status === "pending" && Boolean(block.targetSessionId),
  );
}

/** True for a pending prompt that parks this conversation's own turn, not a mirrored child's. */
export function aeParksThisTurn(block: AnyBlock, conversationId: string | null): boolean {
  return (
    block.type === "elicitation" &&
    block.status === "pending" &&
    (block.targetSessionId == null || block.targetSessionId === conversationId)
  );
}
