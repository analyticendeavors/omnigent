import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { type AeLimitsAnswer, AePlanLimitsPanel } from "./AePlanLimits";

const NOW = Date.parse("2026-10-13T16:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const LIMITS: AeLimitsAnswer = {
  now: iso(NOW),
  harnesses: {
    claude: {
      harness: "claude",
      source: "statusline+usage",
      observed_at: iso(NOW - 60_000),
      plan: "Max 20x",
      windows: [
        {
          id: "five_hour",
          label: "5-hour limit",
          used_percent: 41,
          resets_at: iso(NOW + 2 * 3_600_000),
          window_minutes: 300,
        },
        {
          id: "seven_day",
          label: "Weekly, all models",
          used_percent: 63,
          resets_at: iso(NOW + 3 * 86_400_000),
          window_minutes: 10080,
        },
      ],
      note: null,
      contexts: [
        {
          conversation_id: "conv_claude",
          observed_at: iso(NOW - 2 * 60_000),
          model: "Fable",
          window_size: 1_000_000,
          used_tokens: 216_800,
          input_tokens: 5_000,
          cache_write_tokens: 1_800,
          cache_read_tokens: 210_000,
        },
        {
          conversation_id: "conv_reviewer",
          observed_at: iso(NOW - 3 * 3_600_000),
          model: "Fable",
          window_size: 1_000_000,
          used_tokens: 88_000,
          input_tokens: 2_000,
          cache_write_tokens: 0,
          cache_read_tokens: 86_000,
        },
      ],
    },
    codex: {
      harness: "codex",
      source: "app-server",
      observed_at: iso(NOW - 4 * 60_000),
      plan: "Pro",
      windows: [
        {
          id: "weekly",
          label: "Weekly limit",
          used_percent: 30,
          resets_at: iso(NOW + 86_400_000),
          window_minutes: 10080,
        },
      ],
      note: null,
    },
  },
};

/** The popover's own frame: 22rem wide, capped height, scrolling body. */
const PopoverFrame: Decorator = (Story) => (
  <div className="max-h-[32rem] w-full max-w-[22rem] overflow-y-auto rounded-md border bg-popover p-4 text-sm text-popover-foreground shadow-md">
    <Story />
  </div>
);

/** A 375px phone with the popover's 1rem gutters and a short visible height. */
const PhoneFrame: Decorator = (Story) => (
  <div className="w-full max-w-[375px] bg-background px-4 py-6" data-testid="ae-phone-frame">
    <div className="max-h-[26rem] w-full overflow-y-auto rounded-md border bg-popover p-4 text-sm text-popover-foreground shadow-md">
      <Story />
    </div>
  </div>
);

const meta = {
  title: "Components/AePlanLimitsPanel",
  component: AePlanLimitsPanel,
  args: { data: LIMITS, now: NOW },
} satisfies Meta<typeof AePlanLimitsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CodexActive: Story = {
  decorators: [PopoverFrame],
  args: {
    conversationId: "conv_codex",
    harness: "codex-native",
    model: "gpt-5.5",
    contextWindow: 400_000,
    tokensUsed: 120_000,
  },
};

export const ClaudeActive: Story = {
  decorators: [PopoverFrame],
  args: {
    conversationId: "conv_claude",
    harness: "claude-native",
    model: "claude-fable-5-1",
    contextWindow: 1_000_000,
    tokensUsed: 216_800,
  },
};

const TEAM: Partial<ComponentProps<typeof AePlanLimitsPanel>> = {
  conversationId: "conv_codex",
  harness: "codex-native",
  model: "gpt-5.5",
  contextWindow: 400_000,
  tokensUsed: 120_000,
  sessions: {
    self: {
      harness: "codex-native",
      llmModel: "gpt-5.5",
      contextWindow: 400_000,
      lastTotalTokens: 120_000,
    },
    collaborators: [
      {
        id: "conv_reviewer",
        name: "Review the context meter change",
        snapshot: {
          harness: "claude-native",
          llmModel: "claude-fable-5-1",
          contextWindow: null,
          lastTotalTokens: null,
        },
      },
      {
        id: "conv_tests",
        name: "Write the popover tests",
        snapshot: {
          harness: "pi",
          llmModel: "gemini-3-pro",
          contextWindow: 1_000_000,
          lastTotalTokens: 640_000,
        },
      },
      {
        id: "conv_docs",
        name: "Draft the release note",
        snapshot: {
          harness: "codex-native",
          llmModel: null,
          contextWindow: null,
          lastTotalTokens: null,
        },
      },
    ],
    hidden: 1,
  },
};

/** Codex leads with three collaborators: one live, one stale status line, one silent. */
export const WithCollaborators: Story = { decorators: [PopoverFrame], args: TEAM };

/** No session yet and no limits reading: every row says unavailable, none reads 0%. */
export const MissingTelemetry: Story = {
  decorators: [PopoverFrame],
  args: {
    data: { now: iso(NOW), harnesses: {} },
    harness: "codex-native",
    conversationId: "conv_waiting_for_context",
  },
};

/** Responsive screenshot target: the team view in a 375px phone frame, scrolling. */
export const PhoneWidth: Story = {
  args: TEAM,
  decorators: [PhoneFrame],
  parameters: { layout: "fullscreen" },
};
