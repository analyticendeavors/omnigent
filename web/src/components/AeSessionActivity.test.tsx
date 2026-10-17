import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStateBadge } from "@/components/SessionStateBadge";
import { BackgroundTaskIndicator } from "@/components/composer/BackgroundTaskIndicator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AE_ACTIVITY_SCHEDULED_KEY } from "@/hooks/aeSessionActivityHooks";
import { childSessionsQueryKey, type ChildSessionInfo } from "@/hooks/useChildSessions";
import type { AnyBlock } from "@/lib/blocks";
import type { ScheduledTask } from "@/lib/scheduledTasksApi";
import { useChatStore } from "@/store/chatStore";
import { createInitialConversationState } from "@/store/conversationState";
import { AeSessionActivityLine, aeIsWideMarker, aeWideMarkerReserve } from "./AeSessionActivity";

const NOW = new Date(2026, 9, 17, 8, 30, 0).getTime();
const NINE = new Date(2026, 9, 17, 9, 0, 0).getTime();
const NINE_AM = new Date(NINE).toLocaleTimeString(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const CONV = "conv_ae_activity";

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

const codexQuestion = {
  type: "text_done",
  ctx: { ...ctx(), itemId: "it_q" },
  fullText: "Which path?",
  codexQuestions: [{ title: "Which path?", options: ["A", "B"] }],
} as unknown as AnyBlock;

const pendingQuestion = {
  type: "elicitation",
  ctx: ctx(),
  status: "pending",
  elicitationId: "el_1",
} as unknown as AnyBlock;

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

function checkin(): ScheduledTask {
  return {
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
  };
}

let qc: QueryClient;

function setup(
  state: Partial<ReturnType<typeof useChatStore.getState>>,
  extra: { children?: ChildSessionInfo[]; tasks?: ScheduledTask[] } = {},
) {
  useChatStore.setState({
    ...createInitialConversationState(),
    conversationId: CONV,
    ...state,
  });
  qc.setQueryData(childSessionsQueryKey(CONV), extra.children ?? []);
  qc.setQueryData(AE_ACTIVITY_SCHEDULED_KEY, extra.tasks ?? []);
}

function wrap(node: ReactNode) {
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { headers: { "content-type": "application/json" } })),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useChatStore.setState({ ...createInitialConversationState(), conversationId: null });
});

describe("sidebar badge", () => {
  it("shows waiting as a pulsing hourglass with the agent count", () => {
    wrap(<SessionStateBadge state={{ kind: "waiting", agents: 2, sinceEventMs: 120_000 }} />);
    const badge = screen.getByTestId("session-state-badge");
    expect(badge).toHaveAttribute("data-state", "waiting");
    expect(badge).toHaveAttribute("aria-label", "Waiting on 2 agents");
    expect(badge).toHaveTextContent("2");
    expect(badge.querySelector("svg")).toHaveClass("motion-safe:animate-pulse");
  });

  it("shows quiet as a slow amber spinner with the minutes", () => {
    wrap(<SessionStateBadge state={{ kind: "quiet", quietForMs: 6 * 60_000 }} />);
    const badge = screen.getByTestId("session-state-badge");
    // Still a running turn to upstream styling; the inner mark tells it apart.
    expect(badge).toHaveAttribute("data-state", "running");
    expect(badge).toHaveAttribute("aria-label", "Working, but no new output for 6m");
    expect(badge.querySelector("[data-ae-activity='quiet']")).toHaveClass("text-warning");
    expect(badge).toHaveTextContent("6m");
    expect(badge.querySelector("svg")).toHaveClass("motion-safe:animate-spin");
  });

  it("shows scheduled as an alarm and the short time", () => {
    wrap(
      <SessionStateBadge state={{ kind: "scheduled", at: NINE, waker: "the hourly check-in" }} />,
    );
    const badge = screen.getByTestId("session-state-badge");
    expect(badge).toHaveAttribute("data-state", "scheduled");
    expect(badge).toHaveAttribute(
      "aria-label",
      `Paused; the hourly check-in wakes it at ${NINE_AM}`,
    );
    // The locale words the hour itself, day period included ("9 AM").
    expect(badge.textContent).toBe(
      new Date(NINE).toLocaleTimeString(undefined, { hour: "numeric" }),
    );
  });

  it("leaves a plain running row on the upstream spinner", () => {
    wrap(<SessionStateBadge state={{ kind: "running" }} />);
    expect(screen.getByTestId("running-dot")).toBeInTheDocument();
  });

  it("gives the activity badges a wide slot", () => {
    expect(aeIsWideMarker({ kind: "running" })).toBe(false);
    expect(aeIsWideMarker({ kind: "unseen" })).toBe(false);
    expect(aeIsWideMarker(null)).toBe(false);
    expect(aeIsWideMarker({ kind: "quiet" })).toBe(true);
    expect(aeIsWideMarker({ kind: "waiting" })).toBe(true);
    expect(aeIsWideMarker({ kind: "scheduled" })).toBe(true);
  });

  it("keeps the title clear of a scheduled time with its day period", () => {
    expect(aeWideMarkerReserve({ kind: "scheduled" }, false)).toBe("pr-20");
    expect(aeWideMarkerReserve({ kind: "scheduled" }, true)).toBe("pr-26");
    expect(aeWideMarkerReserve({ kind: "quiet" }, false)).toBe("pr-14");
  });
});

describe("chat status line", () => {
  it("shows working with the turn time, the current step and the last activity", () => {
    setup({
      sessionStatus: "running",
      lastEventAt: NOW - 4000,
      blocks: [userMessage(NOW - 192_000), runningShell(NOW - 42_000)],
    });
    wrap(<AeSessionActivityLine showsWorking />);
    const line = screen.getByTestId("working-indicator");
    expect(line).toHaveAttribute("data-ae-activity", "working");
    expect(line).toHaveTextContent("Working· 3m 12s");
    expect(line).toHaveTextContent("Now: running pnpm vitest run for 42s");
    expect(line).toHaveTextContent("last activity 4s ago");
    expect(screen.getByRole("status")).toHaveTextContent("Working…");
  });

  it("keeps the blocked-on label", () => {
    setup({ sessionStatus: "running", blockedOn: "permission prompt", lastEventAt: NOW });
    wrap(<AeSessionActivityLine showsWorking />);
    expect(screen.getByTestId("working-indicator")).toHaveTextContent(
      "Blocked on: permission prompt",
    );
  });

  it("keeps the blocked message however long the dialog stays open", () => {
    setup({
      sessionStatus: "running",
      blockedOn: "dialog open",
      lastEventAt: NOW - 20 * 60_000,
      blocks: [userMessage(NOW - 25 * 60_000)],
    });
    wrap(<AeSessionActivityLine showsWorking />);
    const line = screen.getByTestId("working-indicator");
    expect(line).toHaveAttribute("data-ae-activity", "working");
    expect(line).toHaveTextContent(
      "Waiting on a dialog in the terminal. Open the terminal tab to respond.",
    );
  });

  it("dates the last activity by the newer of the store stamp and the newest block", () => {
    setup({
      sessionStatus: "running",
      lastEventAt: NOW - 20 * 60_000,
      blocks: [userMessage(NOW - 30_000)],
    });
    wrap(<AeSessionActivityLine showsWorking />);
    const line = screen.getByTestId("working-indicator");
    expect(line).toHaveAttribute("data-ae-activity", "working");
    expect(line).toHaveTextContent("last activity 30s ago");
  });

  it("counts the turn from the switch to running when no new user message started it", () => {
    setup({
      sessionStatus: "running",
      lastEventAt: NOW,
      aeRunningSince: NOW - 42_000,
      blocks: [userMessage(NOW - 2 * 3_600_000)],
    });
    wrap(<AeSessionActivityLine showsWorking />);
    expect(screen.getByTestId("working-indicator")).toHaveTextContent("Working· 42s");
  });

  it("counts the turn and the last activity from a message still on its way", () => {
    // A rebind cleared the store's stamp; the old transcript must not read as quiet.
    setup({
      sessionStatus: "running",
      lastEventAt: null,
      blocks: [userMessage(NOW - 2 * 3_600_000)],
      pendingUserMessages: [{ tempId: "pend_1", content: [], createdAtS: (NOW - 10_000) / 1000 }],
    });
    wrap(<AeSessionActivityLine showsWorking />);
    const line = screen.getByTestId("working-indicator");
    expect(line).toHaveAttribute("data-ae-activity", "working");
    expect(line).toHaveTextContent("Working· 10s");
    expect(line).toHaveTextContent("last activity 10s ago");
  });

  it("never shows an earlier turn's unanswered call as the current step", () => {
    setup({
      sessionStatus: "running",
      lastEventAt: NOW,
      blocks: [runningShell(NOW - 3_600_000), userMessage(NOW - 60_000)],
    });
    wrap(<AeSessionActivityLine showsWorking />);
    expect(screen.getByTestId("working-indicator")).not.toHaveTextContent("Now:");
  });

  it("turns quiet after five minutes without an event", () => {
    setup({
      sessionStatus: "running",
      lastEventAt: NOW - 6 * 60_000,
      blocks: [userMessage(NOW - 7 * 60_000), runningShell(NOW - 6 * 60_000)],
    });
    wrap(<AeSessionActivityLine showsWorking />);
    const line = screen.getByTestId("working-indicator");
    expect(line).toHaveAttribute("data-ae-activity", "quiet");
    expect(line).toHaveTextContent("Still working· no new output for 6m");
    expect(line).toHaveTextContent("Last step: running pnpm vitest run (6m).");
    expect(line).toHaveTextContent("Long runs are often quiet; the Stop button still works.");
    expect(line).toHaveTextContent("last activity 6m ago");
  });

  it("ticks the times each second while working", () => {
    setup({ sessionStatus: "running", lastEventAt: NOW - 4000 });
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    wrap(<AeSessionActivityLine showsWorking />);
    expect(screen.getByTestId("working-indicator")).toHaveTextContent("last activity 4s ago");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId("working-indicator")).toHaveTextContent("last activity 7s ago");
    // The label stays "Working" rather than rotating.
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(screen.getByTestId("working-indicator")).toHaveTextContent(
      /^Workinglast activity 19s ago$/,
    );
  });

  it("waits on agents and shells after the turn, with a chip for each", () => {
    setup(
      {
        sessionStatus: "idle",
        lastEventAt: NOW - 120_000,
        backgroundTaskCount: 1,
        backgroundTasks: [{ id: "s1", command: "gh pr checks 112 --watch" }],
      },
      {
        children: [
          child("c1", "Build rail container", NOW / 1000 - 480),
          child("c2", "Build popover", NOW / 1000 - 360),
        ],
      },
    );
    wrap(
      <>
        <AeSessionActivityLine showsWorking />
        <BackgroundTaskIndicator />
      </>,
    );
    const line = screen.getByTestId("ae-activity-line");
    expect(line).toHaveAttribute("data-ae-activity", "waiting");
    expect(line).toHaveTextContent("Waiting on 2 agents and 1 background shell");
    expect(line).toHaveTextContent("The session picks up when they report. Last update 2m ago.");
    const agents = screen.getAllByTestId("ae-activity-agent-chip");
    expect(agents.map((chip) => chip.textContent)).toEqual([
      "Build rail container8m",
      "Build popover6m",
    ]);
    expect(screen.getByTestId("ae-activity-shell-chip")).toHaveTextContent(
      "gh pr checks 112 --watch",
    );
    // The line lists the shells, so the composer pill steps aside.
    expect(screen.queryByTestId("background-task-pill")).toBeNull();
  });

  it("opens a shell chip's details", () => {
    setup({
      backgroundTaskCount: 1,
      backgroundTasks: [{ id: "s1", description: "Wait for CI", command: "sleep 120" }],
    });
    wrap(<AeSessionActivityLine showsWorking />);
    fireEvent.click(screen.getByTestId("ae-activity-shell-chip"));
    expect(screen.getByText("sleep 120")).toBeInTheDocument();
  });

  it("keeps the composer pill beside the working line", () => {
    setup({
      sessionStatus: "running",
      lastEventAt: NOW,
      backgroundTaskCount: 1,
      backgroundTasks: [{ id: "s1", command: "sleep 120" }],
    });
    wrap(
      <>
        <AeSessionActivityLine showsWorking />
        <BackgroundTaskIndicator />
      </>,
    );
    expect(screen.getByTestId("background-task-pill")).toBeInTheDocument();
  });

  it("waits on running children even when the page shows no work", () => {
    setup({ sessionStatus: "idle" }, { children: [child("c1", "Research", NOW / 1000 - 60)] });
    wrap(<AeSessionActivityLine showsWorking={false} />);
    expect(screen.getByTestId("ae-activity-line")).toHaveTextContent("Waiting on 1 agent");
  });

  it("counts a child held on an approval, as the sidebar does", () => {
    const held = { ...child("c1", "Deploy check", NOW / 1000 - 60), pending_elicitations_count: 1 };
    setup({ sessionStatus: "idle" }, { children: [held] });
    wrap(<AeSessionActivityLine showsWorking={false} />);
    expect(screen.getByTestId("ae-activity-line")).toHaveTextContent("Waiting on 1 agent");
    const chip = screen.getByTestId("ae-activity-agent-chip");
    expect(chip).toHaveTextContent("Deploy checkneeds approval");
    expect(chip).toHaveAttribute("data-needs-approval", "true");
  });

  it("renders nothing while a Codex question waits, until a reply is on its way", () => {
    setup(
      { sessionStatus: "idle", blocks: [codexQuestion] },
      { children: [child("c1", "Research", NOW / 1000 - 60)], tasks: [checkin()] },
    );
    const { container } = wrap(<AeSessionActivityLine showsWorking={false} />);
    expect(container).toBeEmptyDOMElement();
    act(() => {
      useChatStore.setState({
        pendingUserMessages: [{ tempId: "pend_1", content: [], createdAtS: NOW / 1000 }],
      });
    });
    expect(screen.getByTestId("ae-activity-line")).toHaveTextContent("Waiting on 1 agent");
  });

  it("ignores shells the page hides (a known-offline runner)", () => {
    setup({ backgroundTaskCount: 2 });
    const { container } = wrap(<AeSessionActivityLine showsWorking={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says when a schedule will wake an idle session", () => {
    setup({ sessionStatus: "idle" }, { tasks: [checkin()] });
    wrap(<AeSessionActivityLine showsWorking={false} />);
    const line = screen.getByTestId("ae-activity-line");
    expect(line).toHaveAttribute("data-ae-activity", "scheduled");
    expect(line).toHaveTextContent(`Paused until ${NINE_AM}`);
    expect(line).toHaveTextContent(
      "The hourly check-in wakes this session; pause it from the session rail's Scheduled section.",
    );
  });

  it("renders nothing while a question waits for the user", () => {
    setup(
      { sessionStatus: "running", blocks: [pendingQuestion], backgroundTaskCount: 1 },
      { tasks: [checkin()] },
    );
    const { container } = wrap(<AeSessionActivityLine showsWorking={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when idle", () => {
    setup({ sessionStatus: "idle" });
    const { container } = wrap(<AeSessionActivityLine showsWorking={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
