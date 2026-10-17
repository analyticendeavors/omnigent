import { afterEach, describe, expect, it } from "vitest";
import type { AnyBlock } from "@/lib/blocks";
import type { ScheduledTask } from "@/lib/scheduledTasksApi";
import {
  AE_QUIET_AFTER_MS,
  aeCurrentStep,
  aeDuration,
  aeFormatAgo,
  aeNewestBlockAt,
  aeNextScheduledRun,
  aeQuietLabel,
  aeResetLastEventStamps,
  aeScheduleWaker,
  aeScheduledDetail,
  aeScheduledHeadline,
  aeScheduledTooltip,
  aeShortRunTime,
  aeStampLastEvent,
  aeStepBody,
  aeStepVerb,
  aeTurnStartedAt,
  aeWaitingLabel,
  deriveAeActivity,
  isAeSessionState,
  type AeActivityInput,
} from "./aeSessionActivity";

const NOW = new Date(2026, 9, 17, 8, 30, 0).getTime();
const NINE = new Date(2026, 9, 17, 9, 0, 0).getTime();

function input(extra: Partial<AeActivityInput> = {}): AeActivityInput {
  return {
    working: false,
    pendingQuestions: 0,
    backgroundShells: 0,
    runningChildren: 0,
    lastEventAt: null,
    nextRun: null,
    now: NOW,
    ...extra,
  };
}

const ctx = (createdAtS?: number) => ({
  agent: null,
  depth: 0,
  turn: 0,
  timestamp: 0,
  responseId: "r",
  itemId: null,
  ...(createdAtS === undefined ? {} : { clientCreatedAtS: createdAtS }),
});

function toolGroup(callId: string, command: string, atS?: number): AnyBlock {
  return {
    type: "tool_group",
    ctx: ctx(atS),
    iteration: 0,
    executions: [
      {
        name: "Bash",
        arguments: { command },
        argsSummary: command,
        callId,
        agentName: "main",
        executedBy: "client",
        output: null,
      },
    ],
  } as AnyBlock;
}

function toolResult(callId: string): AnyBlock {
  return {
    type: "tool_result",
    ctx: ctx(),
    name: "Bash",
    callId,
    agentName: "main",
    output: "ok",
  } as AnyBlock;
}

function userMessage(atS: number): AnyBlock {
  return { type: "user_message", ctx: ctx(atS), content: [] } as AnyBlock;
}

function task(extra: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "a".repeat(32),
    name: "AE orchestrator check-in",
    prompt: "Check in on conv_target",
    rrule: "FREQ=HOURLY;INTERVAL=1",
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
    ...extra,
  };
}

describe("deriveAeActivity", () => {
  it("is idle with nothing going on", () => {
    expect(deriveAeActivity(input())).toEqual({ kind: "idle" });
  });

  it("puts an open question above everything else", () => {
    const activity = deriveAeActivity(
      input({
        pendingQuestions: 2,
        working: true,
        backgroundShells: 3,
        nextRun: { at: NINE, waker: "the hourly check-in" },
      }),
    );
    expect(activity).toEqual({ kind: "needs_response", count: 2 });
  });

  it("is working while the turn runs, with the time since the last event", () => {
    const activity = deriveAeActivity(input({ working: true, lastEventAt: NOW - 4000 }));
    expect(activity).toEqual({ kind: "working", sinceEventMs: 4000 });
  });

  it("stays working just under the quiet threshold and turns quiet at it", () => {
    const under = deriveAeActivity(
      input({ working: true, lastEventAt: NOW - AE_QUIET_AFTER_MS + 1 }),
    );
    expect(under.kind).toBe("working");
    const at = deriveAeActivity(input({ working: true, lastEventAt: NOW - AE_QUIET_AFTER_MS }));
    expect(at).toEqual({ kind: "quiet", quietForMs: AE_QUIET_AFTER_MS });
  });

  it("never turns quiet while the turn is parked on a dialog", () => {
    for (const blockedOn of ["dialog open", "permission prompt"]) {
      const activity = deriveAeActivity(
        input({ working: true, blockedOn, lastEventAt: NOW - 20 * 60_000 }),
      );
      expect(activity).toEqual({ kind: "working", sinceEventMs: 20 * 60_000 });
    }
  });

  it("never reads an unknown last event as quiet", () => {
    expect(deriveAeActivity(input({ working: true, lastEventAt: null }))).toEqual({
      kind: "working",
      sinceEventMs: null,
    });
  });

  it("clamps a last event in the future to zero", () => {
    const activity = deriveAeActivity(input({ working: true, lastEventAt: NOW + 5000 }));
    expect(activity).toEqual({ kind: "working", sinceEventMs: 0 });
  });

  it("puts working above waiting and scheduled", () => {
    const activity = deriveAeActivity(
      input({
        working: true,
        backgroundShells: 1,
        runningChildren: 2,
        nextRun: { at: NINE, waker: "x" },
      }),
    );
    expect(activity.kind).toBe("working");
  });

  it("waits on agents and shells once the turn ends", () => {
    const activity = deriveAeActivity(
      input({ runningChildren: 2, backgroundShells: 1, lastEventAt: NOW - 120_000 }),
    );
    expect(activity).toEqual({
      kind: "waiting",
      agents: 2,
      shells: 1,
      total: 3,
      label: "Waiting on 2 agents and 1 background shell",
      sinceEventMs: 120_000,
    });
  });

  it("puts waiting above a pending schedule", () => {
    const activity = deriveAeActivity(
      input({ backgroundShells: 1, nextRun: { at: NINE, waker: "the hourly check-in" } }),
    );
    expect(activity.kind).toBe("waiting");
  });

  it("reads missing counts as none", () => {
    expect(deriveAeActivity(input({ backgroundShells: null, runningChildren: undefined }))).toEqual(
      { kind: "idle" },
    );
    expect(deriveAeActivity(input({ backgroundShells: Number.NaN, runningChildren: -2 }))).toEqual({
      kind: "idle",
    });
  });

  it("is scheduled when idle with a future run aimed at it", () => {
    const activity = deriveAeActivity(
      input({ nextRun: { at: NINE, waker: "the hourly check-in" } }),
    );
    expect(activity).toEqual({ kind: "scheduled", at: NINE, waker: "the hourly check-in" });
  });

  it("ignores a run that is already due or past", () => {
    expect(deriveAeActivity(input({ nextRun: { at: NOW, waker: "x" } }))).toEqual({
      kind: "idle",
    });
  });
});

describe("labels", () => {
  it("names agents and shells with singular and plural forms", () => {
    expect(aeWaitingLabel(1, 0)).toBe("Waiting on 1 agent");
    expect(aeWaitingLabel(0, 3)).toBe("Waiting on 3 background shells");
    expect(aeWaitingLabel(2, 1)).toBe("Waiting on 2 agents and 1 background shell");
    expect(aeWaitingLabel(0, 0)).toBe("Waiting");
  });

  it("formats durations the way the Agents pane does, long and compact", () => {
    expect(aeDuration(42_000)).toBe("42s");
    expect(aeDuration(192_000)).toBe("3m 12s");
    expect(aeDuration(185_000)).toBe("3m 05s");
    expect(aeDuration(192_000, true)).toBe("3m");
    expect(aeDuration(3_900_000)).toBe("1h 05m");
    expect(aeDuration(3_900_000, true)).toBe("1h");
    expect(aeDuration(-5)).toBe("0s");
  });

  it("formats time ago", () => {
    expect(aeFormatAgo(500)).toBe("just now");
    expect(aeFormatAgo(4000)).toBe("4s ago");
    expect(aeFormatAgo(125_000)).toBe("2m ago");
  });

  it("words quiet and scheduled states", () => {
    expect(aeQuietLabel(6 * 60_000)).toBe("Working, but no new output for 6m");
    const next = { at: NINE, waker: "the hourly check-in" };
    const nineAm = new Date(NINE).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(aeScheduledTooltip(next, NOW)).toBe(`Paused; the hourly check-in wakes it at ${nineAm}`);
    expect(aeScheduledHeadline(next, NOW)).toBe(`Paused until ${nineAm}`);
    expect(aeScheduledDetail(next)).toBe(
      "The hourly check-in wakes this session; pause it from the session rail's Scheduled section.",
    );
  });

  it("drops 'at' for a run on another day", () => {
    const tomorrow = NINE + 86_400_000;
    expect(aeScheduledTooltip({ at: tomorrow, waker: "x" }, NOW)).toMatch(
      /^Paused; x wakes it tomorrow /,
    );
  });

  it("shortens the run time for a sidebar row, keeping the day period", () => {
    const hourOnly = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
    expect(aeShortRunTime(NINE, NOW)).toBe(hourOnly.format(NINE));
    const halfPastNinePm = new Date(2026, 9, 17, 21, 30).getTime();
    const withMinutes = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    expect(aeShortRunTime(halfPastNinePm, NOW)).toBe(withMinutes.format(halfPastNinePm));
    // A 12-hour locale keeps its AM or PM.
    const period = withMinutes
      .formatToParts(halfPastNinePm)
      .find((part) => part.type === "dayPeriod");
    if (period) {
      expect(aeShortRunTime(halfPastNinePm, NOW)).toContain(period.value);
      expect(aeShortRunTime(NINE, NOW)).not.toMatch(/[:.]00/);
    }
    expect(aeShortRunTime(NINE + 2 * 86_400_000, NOW)).toBe(
      new Date(NINE + 2 * 86_400_000).toLocaleDateString(undefined, { weekday: "short" }),
    );
  });

  it("names what wakes the session", () => {
    expect(aeScheduleWaker({ name: "AE orchestrator check-in", rrule: "FREQ=HOURLY" })).toBe(
      "the hourly check-in",
    );
    expect(
      aeScheduleWaker({ name: "AE orchestrator check-in", rrule: "FREQ=HOURLY;INTERVAL=2" }),
    ).toBe("the check-in every 2 hours");
    expect(aeScheduleWaker({ name: "AE orchestrator check-in", rrule: "FREQ=SECONDLY" })).toBe(
      "the check-in",
    );
    expect(aeScheduleWaker({ name: "Nightly report", rrule: "FREQ=DAILY" })).toBe(
      'the "Nightly report" schedule',
    );
  });
});

describe("aeNextScheduledRun", () => {
  it("picks the soonest active future run whose prompt names the session", () => {
    const tasks = [
      task({ id: "1".repeat(32), nextRunAt: new Date(NINE + 3_600_000).toISOString() }),
      task({ id: "2".repeat(32) }),
      task({
        id: "3".repeat(32),
        prompt: "other session",
        nextRunAt: new Date(NOW + 1000).toISOString(),
      }),
      task({ id: "4".repeat(32), state: "paused", nextRunAt: new Date(NOW + 1000).toISOString() }),
      task({ id: "5".repeat(32), nextRunAt: new Date(NOW - 1000).toISOString() }),
      task({ id: "6".repeat(32), nextRunAt: null }),
    ];
    expect(aeNextScheduledRun(tasks, "conv_target", new Set(), NOW)).toEqual({
      at: NINE,
      waker: "the hourly check-in",
    });
  });

  it("includes tasks the session created", () => {
    const created = task({ id: "b".repeat(32), name: "Ping", prompt: "no id here" });
    expect(aeNextScheduledRun([created], "conv_target", new Set(["b".repeat(32)]), NOW)).toEqual({
      at: NINE,
      waker: 'the "Ping" schedule',
    });
  });

  it("is null with no tasks loaded", () => {
    expect(aeNextScheduledRun(undefined, "conv_target", new Set(), NOW)).toBeNull();
    expect(aeNextScheduledRun([], "conv_target", new Set(), NOW)).toBeNull();
  });
});

describe("block readers", () => {
  it("finds the newest running tool call", () => {
    const blocks = [
      userMessage(100),
      toolGroup("c1", "ls", 101),
      toolResult("c1"),
      toolGroup("c2", "pnpm vitest run", 110),
    ];
    const step = aeCurrentStep(blocks);
    expect(step).toMatchObject({ running: true, startedAt: 110_000 });
    expect(aeStepVerb(step!.title)).toBe("running");
    expect(aeStepBody(step!.title)).toBe("pnpm vitest run");
  });

  it("stops at the current turn, so an earlier turn's unanswered call never reads as running", () => {
    const orphan = toolGroup("c0", "sleep 600", 90);
    expect(aeCurrentStep([orphan, userMessage(100)])).toBeNull();
    const blocks = [orphan, userMessage(100), toolGroup("c1", "ls", 101), toolResult("c1")];
    expect(aeCurrentStep(blocks)).toMatchObject({ running: false, startedAt: 101_000 });
  });

  it("falls back to the newest finished call", () => {
    const blocks = [toolGroup("c1", "ls", 101), toolResult("c1")];
    expect(aeCurrentStep(blocks)).toMatchObject({ running: false });
    expect(aeCurrentStep([userMessage(1)])).toBeNull();
  });

  it("words a tool with its own verb", () => {
    expect(aeStepVerb({ verb: "Web search:", body: '"x"' })).toBe("web search");
    expect(aeStepBody({ verb: null, body: "a\n  b".padEnd(100, "c") }, 10)).toBe("a bcccccc…");
  });

  it("reads the turn start and newest stamp", () => {
    const blocks = [userMessage(100), toolGroup("c1", "ls", 105), toolGroup("c2", "ls")];
    expect(aeTurnStartedAt(blocks)).toBe(100_000);
    expect(aeNewestBlockAt(blocks)).toBe(105_000);
    expect(aeTurnStartedAt([])).toBeNull();
    // A later start the caller knows (an unsent message, the switch to running) wins.
    expect(aeTurnStartedAt(blocks, [150_000, null, undefined])).toBe(150_000);
    expect(aeTurnStartedAt(blocks, [50_000])).toBe(100_000);
    expect(aeTurnStartedAt([], [null, 7000])).toBe(7000);
    expect(aeNewestBlockAt([toolGroup("c3", "ls")])).toBeNull();
  });
});

describe("aeStampLastEvent", () => {
  afterEach(aeResetLastEventStamps);

  it("writes at most once a second per session", () => {
    const writes: number[] = [];
    const write = (patch: { lastEventAt: number }) => writes.push(patch.lastEventAt);
    aeStampLastEvent("a", write, 1000);
    aeStampLastEvent("a", write, 1500);
    aeStampLastEvent("b", write, 1500);
    aeStampLastEvent("a", write, 2000);
    expect(writes).toEqual([1000, 1500, 2000]);
  });

  it("writes again when the clock goes backwards", () => {
    const writes: number[] = [];
    const write = (patch: { lastEventAt: number }) => writes.push(patch.lastEventAt);
    aeStampLastEvent("a", write, 5000);
    aeStampLastEvent("a", write, 4000);
    expect(writes).toEqual([5000, 4000]);
  });
});

describe("isAeSessionState", () => {
  it("tells the activity states from the upstream ones", () => {
    expect(isAeSessionState({ kind: "running" })).toBe(false);
    expect(isAeSessionState({ kind: "quiet" })).toBe(true);
    expect(isAeSessionState({ kind: "waiting" })).toBe(true);
    expect(isAeSessionState({ kind: "scheduled" })).toBe(true);
    expect(isAeSessionState({ kind: "unseen" })).toBe(false);
  });
});
