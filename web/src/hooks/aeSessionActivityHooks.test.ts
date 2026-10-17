import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyBlock } from "@/lib/blocks";
import type { ScheduledTask } from "@/lib/scheduledTasksApi";
import {
  AE_ACTIVITY_SCHEDULED_KEY,
  AE_AFTER_RUN_REFETCH_MS,
  aePendingQuestionCount,
  aeProjectMarker,
  aeRowState,
  aeRunningAgentChips,
  aeSoonestRunAt,
  useAeScheduledTasks,
} from "./aeSessionActivityHooks";
import type { Conversation } from "./useConversations";
import type { ChildSessionInfo } from "./useChildSessions";

const NOW = new Date(2026, 9, 17, 8, 30, 0).getTime();
const NOW_S = Math.floor(NOW / 1000);
const NINE = new Date(2026, 9, 17, 9, 0, 0).getTime();

// Rows still arrive with the server's shell count; the sidebar must ignore it.
type Row = Parameters<typeof aeRowState>[0] & Pick<Conversation, "background_task_count">;

function row(extra: Partial<Row> = {}): Row {
  return { id: "conv_a", status: "idle", updated_at: NOW_S, ...extra };
}

const base = { now: NOW, nextRun: null, lastEventAt: null, turnIdle: false };

function checkin(sessionId: string, at = NINE): ScheduledTask {
  return {
    id: "a".repeat(32),
    name: "AE orchestrator check-in",
    prompt: `Check in on ${sessionId}`,
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
    nextRunAt: new Date(at).toISOString(),
  };
}

describe("aeRowState", () => {
  it("keeps a running row with fresh output as running", () => {
    expect(aeRowState(row({ status: "running" }), { kind: "running" }, base).state).toEqual({
      kind: "running",
    });
  });

  it("turns a running row quiet after five silent minutes", () => {
    const stale = row({ status: "running", updated_at: NOW_S - 6 * 60 });
    expect(aeRowState(stale, { kind: "running" }, base).state).toEqual({
      kind: "quiet",
      quietForMs: 6 * 60_000,
    });
  });

  it("never turns a row quiet while the open chat is parked on a dialog", () => {
    const stale = row({ status: "running", updated_at: NOW_S - 20 * 60 });
    const options = { ...base, blockedOn: "dialog open" };
    expect(aeRowState(stale, { kind: "running" }, options).state).toEqual({ kind: "running" });
  });

  it("uses the newer of the open chat's last event and the row's update time", () => {
    const stale = row({ status: "running", updated_at: NOW_S - 6 * 60 });
    const state = aeRowState(stale, { kind: "running" }, { ...base, lastEventAt: NOW - 1000 });
    expect(state.state).toEqual({ kind: "running" });
    // A stamp from an earlier visit never makes a fresh row quiet.
    const fresh = row({ status: "running", updated_at: NOW_S - 10 });
    const old = { ...base, lastEventAt: NOW - 20 * 60_000 };
    expect(aeRowState(fresh, { kind: "running" }, old).state).toEqual({ kind: "running" });
  });

  it("never calls a parent quiet while its children run", () => {
    const stale = row({ status: "running", updated_at: NOW_S - 600, active_child_count: 1 });
    expect(aeRowState(stale, { kind: "running" }, base).state).toEqual({ kind: "running" });
  });

  it("reads a running parent as waiting when the open chat says its own turn ended", () => {
    const parent = row({ status: "running", active_child_count: 2 });
    expect(aeRowState(parent, { kind: "running" }, { ...base, turnIdle: true }).state).toEqual({
      kind: "waiting",
      agents: 2,
      sinceEventMs: null,
    });
  });

  it("reads an idle row with children as waiting", () => {
    const state = aeRowState(
      row({ background_task_count: 1, active_child_count: 2, updated_at: NOW_S - 120 }),
      null,
      base,
    );
    expect(state).toEqual({
      state: { kind: "waiting", agents: 2, sinceEventMs: 120_000 },
      scheduled: null,
    });
  });

  it("ignores the shell count, which goes stale once a shell exits after the turn", () => {
    const shellOnly = row({ background_task_count: 2 });
    expect(aeRowState(shellOnly, null, base)).toEqual({ state: null, scheduled: null });
    const parent = row({ status: "running", background_task_count: 1 });
    expect(aeRowState(parent, { kind: "running" }, { ...base, turnIdle: true }).state).toEqual({
      kind: "running",
    });
  });

  it("reads missing counts as none", () => {
    expect(aeRowState(row(), null, base)).toEqual({ state: null, scheduled: null });
  });

  it("leaves awaiting, error and disconnected rows alone", () => {
    const busy = row({ background_task_count: 3 });
    for (const upstream of [
      { kind: "awaiting", count: 1 } as const,
      { kind: "error" } as const,
      { kind: "disconnected" } as const,
    ]) {
      expect(aeRowState(busy, upstream, base).state).toEqual(upstream);
    }
  });

  it("offers a schedule only as the fallback below unseen", () => {
    const next = { at: NINE, waker: "the hourly check-in" };
    expect(aeRowState(row(), null, { ...base, nextRun: next })).toEqual({
      state: null,
      scheduled: { kind: "scheduled", at: NINE, waker: "the hourly check-in" },
    });
    // Waiting outranks the schedule; a stale shell count does not.
    expect(
      aeRowState(row({ active_child_count: 1 }), null, { ...base, nextRun: next }).scheduled,
    ).toBeNull();
    expect(
      aeRowState(row({ background_task_count: 1 }), null, { ...base, nextRun: next }).scheduled,
    ).not.toBeNull();
  });
});

describe("aeProjectMarker", () => {
  const opts = { now: NOW, tasks: undefined };

  it("turns a running marker quiet only when every running row is quiet", () => {
    const quiet = row({ id: "q", status: "running", updated_at: NOW_S - 600 });
    const quieter = row({ id: "r", status: "running", updated_at: NOW_S - 900 });
    const fresh = row({ id: "f", status: "running" });
    expect(aeProjectMarker({ kind: "running" }, [quiet, quieter], opts)).toEqual({
      kind: "quiet",
      quietForMs: 600_000,
    });
    expect(aeProjectMarker({ kind: "running" }, [quiet, fresh], opts)).toEqual({
      kind: "running",
    });
  });

  it("puts waiting above unseen and blank, and sums the agents", () => {
    const rows = [
      row({ id: "a", background_task_count: 1, active_child_count: 1 }),
      row({ id: "b", active_child_count: 2 }),
    ];
    const waiting = { kind: "waiting", agents: 3, sinceEventMs: null };
    expect(aeProjectMarker(null, rows, opts)).toEqual(waiting);
    expect(aeProjectMarker({ kind: "unseen" }, rows, opts)).toEqual(waiting);
  });

  it("keeps awaiting, starting, error and disconnected above waiting", () => {
    const rows = [row({ active_child_count: 1 })];
    for (const marker of [
      { kind: "awaiting", count: 1 } as const,
      { kind: "starting" } as const,
      { kind: "error" } as const,
      { kind: "disconnected" } as const,
    ]) {
      expect(aeProjectMarker(marker, rows, opts)).toEqual(marker);
    }
  });

  it("shows the soonest schedule only on an otherwise blank marker", () => {
    const tasks = [checkin("a", NINE + 3_600_000), { ...checkin("b"), id: "b".repeat(32) }];
    const rows = [row({ id: "a" }), row({ id: "b" })];
    expect(aeProjectMarker(null, rows, { now: NOW, tasks })).toEqual({
      kind: "scheduled",
      at: NINE,
      waker: "the hourly check-in",
    });
    expect(aeProjectMarker({ kind: "unseen" }, rows, { now: NOW, tasks })).toEqual({
      kind: "unseen",
    });
  });
});

describe("aeRunningAgentChips", () => {
  const child = (extra: Partial<ChildSessionInfo>): ChildSessionInfo => ({
    id: "c",
    title: "worker:auth",
    task_summary: null,
    tool: "worker",
    session_name: "auth",
    current_task_status: null,
    busy: false,
    last_message_preview: null,
    pending_elicitations_count: 0,
    ...extra,
  });

  it("lists working, launching and approval-held children, as the server counts them", () => {
    const chips = aeRunningAgentChips([
      child({ id: "1", busy: true, task_summary: "Build rail container", created_at: 100 }),
      child({ id: "2", current_task_status: "launching" }),
      child({ id: "3", current_task_status: "completed" }),
      child({ id: "4", busy: true, pending_elicitations_count: 1 }),
    ]);
    expect(chips).toEqual([
      { id: "1", label: "Build rail container", startedAt: 100_000, needsApproval: false },
      { id: "2", label: "auth", startedAt: null, needsApproval: false },
      { id: "4", label: "auth", startedAt: null, needsApproval: true },
    ]);
  });
});

describe("aePendingQuestionCount", () => {
  const ctx = { agent: null, depth: 0, turn: 0, timestamp: 0, responseId: "r", itemId: "it_q" };
  const codexQuestion = {
    type: "text_done",
    ctx,
    fullText: "Which path?",
    codexQuestions: [{ title: "Which path?", options: ["A", "B"] }],
  } as unknown as AnyBlock;
  const elicitation = (target?: string) =>
    ({
      type: "elicitation",
      ctx,
      status: "pending",
      elicitationId: "el",
      ...(target ? { targetSessionId: target } : {}),
    }) as unknown as AnyBlock;

  it("counts elicitations aimed at this session and unanswered Codex questions", () => {
    expect(
      aePendingQuestionCount([elicitation(), elicitation("conv_child")], "conv_a", false),
    ).toBe(1);
    expect(aePendingQuestionCount([codexQuestion], "conv_a", false)).toBe(1);
  });

  it("treats a reply on its way as the Codex answer", () => {
    expect(aePendingQuestionCount([codexQuestion], "conv_a", true)).toBe(0);
    const answered = [codexQuestion, { type: "user_message", ctx, content: [] } as AnyBlock];
    expect(aePendingQuestionCount(answered, "conv_a", false)).toBe(0);
  });
});

describe("scheduled list refetch after a run fires", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mount(tasks: ScheduledTask[]) {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL) =>
        new Response(JSON.stringify({ scheduled_tasks: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(AE_ACTIVITY_SCHEDULED_KEY, tasks);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    // Two rows share one timer.
    const first = renderHook(() => useAeScheduledTasks(), { wrapper });
    const second = renderHook(() => useAeScheduledTasks(), { wrapper });
    const calls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/v1/scheduled-tasks")).length;
    return { first, second, calls };
  }

  it("picks the soonest active run still ahead", () => {
    const tasks = [
      checkin("a", NINE + 60_000),
      { ...checkin("b", NINE), id: "b".repeat(32) },
      { ...checkin("c", NOW + 1000), id: "c".repeat(32), state: "paused" as const },
      { ...checkin("d", NOW - 1000), id: "d".repeat(32) },
    ];
    expect(aeSoonestRunAt(tasks, NOW)).toBe(NINE);
    expect(aeSoonestRunAt(undefined, NOW)).toBeNull();
  });

  it("refetches once, a few seconds after the soonest run", async () => {
    const { calls } = mount([checkin("a", NOW + 60_000)]);
    await vi.advanceTimersByTimeAsync(60_000 + AE_AFTER_RUN_REFETCH_MS - 10);
    expect(calls()).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(calls()).toBe(1);
    // The refetched list has no future run, so nothing else is scheduled.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls()).toBe(1);
  });

  it("clears the timer once every reader unmounts", async () => {
    const { first, second, calls } = mount([checkin("a", NOW + 60_000)]);
    first.unmount();
    second.unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls()).toBe(0);
  });
});
