import { QueryClientProvider } from "@tanstack/react-query";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { type ReactNode, useState } from "react";
import { AE_STORY_SESSION, installAeRailStoryData } from "@/components/aeRailStoryData";
import { AeSessionRail, AeSessionRailList } from "./AeSessionRail";

/** Seeds the stores, the query cache and the fetch stub once per story mount. */
function Seeded({ sheetOpen, children }: { sheetOpen?: boolean; children: ReactNode }) {
  const [client] = useState(() => installAeRailStoryData({ sheetOpen }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const seeded =
  (sheetOpen = false): Decorator =>
  (Story) => (
    <Seeded sheetOpen={sheetOpen}>
      <Story />
    </Seeded>
  );

/** A few grey message bars and a composer box, standing in for the chat. */
function ChatPlaceholder() {
  const bars = ["w-2/5", "w-3/5", "w-1/2", "w-4/5", "w-2/3", "w-1/3"];
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col gap-4 p-8">
        {bars.map((width, index) => (
          <div
            key={width + String(index)}
            className={`h-10 rounded-lg bg-muted ${width} ${index % 2 ? "self-end" : ""}`}
          />
        ))}
      </div>
      <div className="m-6 h-24 rounded-xl border border-border bg-card" />
    </div>
  );
}

const meta = {
  title: "Shell/AeSessionRail",
  component: AeSessionRail,
  parameters: { layout: "fullscreen" },
  args: { sessionId: AE_STORY_SESSION, workspacePanelOpen: false },
} satisfies Meta<typeof AeSessionRail>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The rail docked beside the chat. At 1440 wide it takes its own 304 px column. */
export const Docked: Story = {
  decorators: [seeded()],
  render: (args) => (
    <div className="fixed inset-0 flex bg-background text-foreground">
      <ChatPlaceholder />
      <AeSessionRail {...args} />
    </div>
  ),
};

/** Narrow window: the rail floats over the chat's right edge with a small "Session" header. */
export const Floating: Story = {
  decorators: [seeded()],
  render: (args) => (
    <div className="fixed inset-0 flex overflow-hidden bg-background text-foreground">
      <ChatPlaceholder />
      <AeSessionRail {...args} />
    </div>
  ),
};

/** On a phone the rail is a full-screen sheet. */
export const PhoneSheet: Story = {
  decorators: [seeded(true)],
  render: (args) => (
    <div className="fixed inset-0 bg-background text-foreground">
      <ChatPlaceholder />
      <AeSessionRail {...args} />
    </div>
  ),
};

/** Every section unfolded in a 304 px column, as tall as its content. */
export const AllSections: Story = {
  decorators: [seeded()],
  render: (args) => (
    <div className="w-[304px] border-l border-border bg-background text-foreground">
      <AeSessionRailList sessionId={args.sessionId} className="p-2" />
    </div>
  ),
};
