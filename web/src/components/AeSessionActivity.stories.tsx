import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactNode, useEffect, useState } from "react";
import { SessionStateBadge } from "@/components/SessionStateBadge";
import { AeSessionActivityLine } from "@/components/AeSessionActivity";
import { AE_ACTIVITY_SCHEDULED_KEY } from "@/hooks/aeSessionActivityHooks";
import { childSessionsQueryKey, type ChildSessionInfo } from "@/hooks/useChildSessions";
import type { SessionState } from "@/hooks/useSessionState";
import type { AnyBlock } from "@/lib/blocks";
import type { ScheduledTask } from "@/lib/scheduledTasksApi";
import { useChatStore } from "@/store/chatStore";
import { createInitialConversationState } from "@/store/conversationState";

// Illustrative data only: every session name, command and agent task is made up.
// `Date.now` is pinned to 08:30 on 2026-10-17 while a story is mounted, so the
// elapsed times and the "9:00" wake-up match the approved mockup.
const NOW = new Date(2026, 9, 17, 8, 30, 0).getTime();
const NINE = new Date(2026, 9, 17, 9, 0, 0).getTime();
const CONV = "conv_activity_story";

function useFrozenNow() {
  useState(() => {
    Date.now = () => NOW;
    return null;
  });
  const realNow = useState(() => Date.now)[0];
  useEffect(
    () => () => {
      Date.now = realNow;
    },
    [realNow],
  );
}

const ctx = (atMs?: number) => ({
  agent: null,
  depth: 0,
  turn: 0,
  timestamp: 0,
  responseId: "r",
  itemId: null,
  ...(atMs === undefined ? {} : { clientCreatedAtS: atMs / 1000 }),
});

const userMessage = (atMs: number) =>
  ({ type: "user_message", ctx: ctx(atMs), content: [] }) as AnyBlock;

const runningShell = (atMs: number) =>
  ({
    type: "tool_group",
    ctx: ctx(atMs),
    iteration: 0,
    executions: [
      {
        name: "Bash",
        arguments: { command: "pnpm vitest run" },
        argsSummary: "pnpm vitest run",
        callId: "call_1",
        agentName: "main",
        executedBy: "client",
        output: null,
      },
    ],
  }) as AnyBlock;

function child(id: string, summary: string, startedS: number): ChildSessionInfo {
  return {
    id,
    title: null,
    task_summary: summary,
    tool: "worker",
    session_name: id,
    current_task_status: "in_progress",
    busy: true,
    last_message_preview: null,
    pending_elicitations_count: 0,
    created_at: startedS,
  };
}

const checkin = (): ScheduledTask => ({
  id: "a".repeat(32),
  name: "AE orchestrator check-in",
  prompt: `Check in on ${CONV}`,
  rrule: "FREQ=HOURLY",
  ownerUserId: null,
  agentId: "ag",
  timezone: "UTC",
  createdAt: 0,
  updatedAt: 0,
  modelOverride: null,
  reasoningEffort: null,
  permissionMode: null,
  workspace: null,
  hostId: null,
  executionTarget: "connected_host",
  state: "active",
  lastRunAt: null,
  lastRunStatus: null,
  lastRunConversationId: null,
  nextRunAt: new Date(NINE).toISOString(),
});

type LineKind = "working" | "quiet" | "waiting" | "scheduled";

/** Seeds the chat store and the query cache once per mount, then renders the line. */
function SeededLine({ kind, children }: { kind: LineKind; children: ReactNode }) {
  useFrozenNow();
  const [client] = useState(() => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let state: Partial<ReturnType<typeof useChatStore.getState>>;
    let kids: ChildSessionInfo[] = [];
    let tasks: ScheduledTask[] = [];
    if (kind === "working") {
      state = {
        sessionStatus: "running",
        lastEventAt: NOW - 4000,
        blocks: [userMessage(NOW - 192_000), runningShell(NOW - 42_000)],
      };
    } else if (kind === "quiet") {
      state = {
        sessionStatus: "running",
        lastEventAt: NOW - 6 * 60_000,
        blocks: [userMessage(NOW - 7 * 60_000), runningShell(NOW - 6 * 60_000)],
      };
    } else if (kind === "waiting") {
      state = {
        sessionStatus: "idle",
        lastEventAt: NOW - 120_000,
        backgroundTaskCount: 1,
        backgroundTasks: [{ id: "s1", command: "gh pr checks 112 --watch" }],
      };
      kids = [
        child("c1", "Build rail container", NOW / 1000 - 480),
        child("c2", "Build popover", NOW / 1000 - 360),
      ];
    } else {
      state = { sessionStatus: "idle" };
      tasks = [checkin()];
    }
    useChatStore.setState({ ...createInitialConversationState(), conversationId: CONV, ...state });
    qc.setQueryData(childSessionsQueryKey(CONV), kids);
    qc.setQueryData(AE_ACTIVITY_SCHEDULED_KEY, tasks);
    return qc;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const meta = {
  title: "Components/AeSessionActivity",
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

interface Row {
  name: string;
  state: SessionState;
  selected?: boolean;
}

const ROWS: Row[] = [
  { name: "Session rail build", state: { kind: "running" }, selected: true },
  { name: "Fabric Admin Menu", state: { kind: "waiting", agents: 2, sinceEventMs: 0 } },
  { name: "MSFT Decision Model", state: { kind: "quiet", quietForMs: 6 * 60_000 } },
  { name: "Halcyon close-out", state: { kind: "awaiting", count: 1 } },
  {
    name: "Fabric Ecosystem Game",
    state: { kind: "scheduled", at: NINE, waker: "the hourly check-in" },
  },
  { name: "PR markdown cards", state: { kind: "unseen" } },
];

/** One sidebar row per state, drawn with the real `SessionStateBadge`. */
export const SidebarRows: Story = {
  render: function Render() {
    useFrozenNow();
    return (
      <div
        data-testid="activity-rows"
        className="w-70 rounded-xl border border-border bg-sidebar p-2 text-sm text-foreground"
      >
        <h3 className="mx-2 mt-0.5 mb-1.5 text-xs font-medium text-muted-foreground">Sessions</h3>
        {ROWS.map((row) => (
          <div
            key={row.name}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${row.selected ? "bg-brand-accent/15 text-brand-accent" : ""}`}
          >
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
            <SessionStateBadge state={row.state} />
          </div>
        ))}
      </div>
    );
  },
};

function lineStory(kind: LineKind): Story {
  return {
    render: () => (
      <SeededLine kind={kind}>
        <div data-testid="activity-line-frame" className="bg-background p-4">
          <AeSessionActivityLine showsWorking={kind !== "scheduled"} />
        </div>
      </SeededLine>
    ),
  };
}

/** Chat status line while a turn runs: elapsed time, current step, last activity. */
export const LineWorking: Story = lineStory("working");
/** Working but silent for six minutes: amber, with the reassurance text. */
export const LineQuiet: Story = lineStory("quiet");
/** The turn ended while two agents and a shell still run: chips for each. */
export const LineWaiting: Story = lineStory("waiting");
/** Nothing running; the hourly check-in wakes the session at 9:00 AM. */
export const LineScheduled: Story = lineStory("scheduled");
