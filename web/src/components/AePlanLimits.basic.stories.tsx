import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { AePlanLimitsPanel } from "./AePlanLimits";
import { AE_STORY_SESSION, STORY_LIMITS, storyContextSnapshot } from "./aeRailStoryData";

const NOW = Date.now();

/** The popover's own frame: 22rem wide, with its border, padding and shadow. */
const PopoverFrame: Decorator = (Story) => (
  <div className="w-[22rem] rounded-md border bg-popover p-4 text-sm text-popover-foreground shadow-md">
    <Story />
  </div>
);

const meta = {
  title: "Components/AePlanLimitsPanel/Claude Code with rail data",
  component: AePlanLimitsPanel,
  decorators: [PopoverFrame],
} satisfies Meta<typeof AePlanLimitsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const collaborator = (
  id: string,
  name: string,
  harness: string,
  llmModel: string,
  contextWindow: number,
  lastTotalTokens: number,
) => ({
  id,
  name,
  running: true,
  snapshot: { harness, llmModel, contextWindow, lastTotalTokens },
});

/** Category bar and legend, two agent lanes, three subagents, the Claude plan rows and the rail button. */
export const ClaudeCodeSession: Story = {
  args: {
    data: STORY_LIMITS(NOW),
    now: NOW,
    conversationId: AE_STORY_SESSION,
    harness: "claude-native",
    model: "claude-opus-5-5[1m]",
    contextWindow: 1_000_000,
    tokensUsed: 495_200,
    snapshot: {
      data: storyContextSnapshot(),
      loading: false,
      fresh: true,
      refresh: () => {},
    },
    sessions: {
      collaborators: [
        collaborator("c1", "Review the diff", "codex-native", "gpt-6-astra", 400_000, 88_000),
        collaborator(
          "c2",
          "Write the docs",
          "claude-native",
          "claude-sonnet-5-5",
          1_000_000,
          410_000,
        ),
      ],
      subagents: 3,
    },
  },
};
