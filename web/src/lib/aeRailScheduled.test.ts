// Tests for the Scheduled section's pure parts: which tasks are this
// session's, the check-in's name, the when line and the before-closing line.

import { describe, expect, it } from "vitest";
import type { AnyBlock, BlockContext } from "@/lib/blocks";
import type { ScheduledTask } from "@/lib/scheduledTasksApi";
import {
  AE_CHECKIN_NAME,
  beforeClosingLine,
  createdScheduleIds,
  formatNextRun,
  parseAeRrule,
  scheduleTitle,
  scheduleWhen,
  schedulesForSession,
} from "./aeRailScheduled";

const ctx: BlockContext = {
  agent: null,
  depth: 0,
  turn: 0,
  timestamp: 0,
  responseId: "r",
  itemId: null,
};
const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

function task(extra: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: ID_A,
    name: "Task",
    prompt: "",
    rrule: "FREQ=DAILY",
    ownerUserId: null,
    agentId: "agent",
    timezone: "America/Los_Angeles",
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
    nextRunAt: null,
    ...extra,
  };
}

describe("createdScheduleIds", () => {
  it("reads the id from the create tool's answer, inline or as a separate result", () => {
    const blocks: AnyBlock[] = [
      {
        type: "tool_group",
        ctx,
        iteration: 0,
        executions: [
          {
            name: "sys_scheduled_task_create",
            arguments: {},
            argsSummary: "",
            callId: "c1",
            agentName: "",
            executedBy: "server",
            output: JSON.stringify({ id: ID_A, name: "Recheck CI" }),
          },
          {
            name: "mcp__omnigent__sys_scheduled_task_create",
            arguments: {},
            argsSummary: "",
            callId: "c2",
            agentName: "",
            executedBy: "server",
            output: null,
          },
          {
            name: "sys_scheduled_task_list",
            arguments: {},
            argsSummary: "",
            callId: "c3",
            agentName: "",
            executedBy: "server",
            output: JSON.stringify({ id: "c".repeat(32) }),
          },
        ],
      },
      {
        type: "tool_result",
        ctx,
        name: "",
        callId: "c2",
        agentName: "",
        // An MCP wrapper carries the JSON escaped inside a text part.
        output: `[{"type":"text","text":"{\\"id\\": \\"${ID_B.toUpperCase()}\\"}"}]`,
      },
    ];
    expect([...createdScheduleIds(blocks)].sort()).toEqual([ID_A, ID_B]);
  });
});

describe("schedulesForSession", () => {
  it("keeps the tasks that name the session or that it created, check-ins first", () => {
    const tasks = [
      task({ id: "1".repeat(32), name: "Other", prompt: "about conv_other" }),
      task({ id: ID_B, name: "Created here" }),
      task({
        id: "2".repeat(32),
        name: AE_CHECKIN_NAME,
        prompt: "post_message with session_id conv_me",
      }),
      task({ id: "3".repeat(32), name: "Mentions", prompt: "Look at conv_me again" }),
    ];
    const kept = schedulesForSession(tasks, "conv_me", new Set([ID_B]));
    expect(kept.map((t) => t.name)).toEqual([AE_CHECKIN_NAME, "Created here", "Mentions"]);
  });
});

describe("parseAeRrule", () => {
  it("reads FREQ, INTERVAL, COUNT and UNTIL", () => {
    const rule = parseAeRrule("FREQ=HOURLY;INTERVAL=2;UNTIL=20261021T065959Z");
    expect(rule.freq).toBe("HOURLY");
    expect(rule.interval).toBe(2);
    expect(rule.count).toBeNull();
    expect(rule.until?.toISOString()).toBe("2026-10-21T06:59:59.000Z");
    expect(parseAeRrule("RRULE:FREQ=DAILY;COUNT=1")).toMatchObject({ freq: "DAILY", count: 1 });
    expect(parseAeRrule("nonsense").freq).toBeNull();
  });
});

describe("scheduleTitle", () => {
  it("names the check-in by its rule and keeps other names", () => {
    expect(scheduleTitle({ name: AE_CHECKIN_NAME, rrule: "FREQ=HOURLY;INTERVAL=1" })).toBe(
      "Check-in every hour",
    );
    expect(scheduleTitle({ name: AE_CHECKIN_NAME, rrule: "FREQ=HOURLY;INTERVAL=3" })).toBe(
      "Check-in every 3 hours",
    );
    expect(scheduleTitle({ name: "Recheck CI", rrule: "FREQ=HOURLY" })).toBe("Recheck CI");
  });
});

describe("scheduleWhen", () => {
  const now = new Date(2026, 9, 17, 6, 0);
  const at = new Date(2026, 9, 17, 7, 45);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  it("shows the next run and the end", () => {
    const when = scheduleWhen(
      {
        state: "active",
        nextRunAt: at.toISOString(),
        rrule: "FREQ=HOURLY;UNTIL=20261021T065959Z",
        timezone: "America/Los_Angeles",
      },
      now,
    );
    expect(when).toBe(`Next ${time} · until Oct 20`);
  });

  it("says once, paused, and no next run", () => {
    const base = { nextRunAt: at.toISOString(), timezone: "UTC" };
    expect(scheduleWhen({ ...base, state: "active", rrule: "FREQ=DAILY;COUNT=1" }, now)).toBe(
      `Next ${time} · once`,
    );
    expect(scheduleWhen({ ...base, state: "paused", rrule: "FREQ=DAILY" }, now)).toBe("Paused");
    expect(
      scheduleWhen({ ...base, nextRunAt: null, state: "active", rrule: "FREQ=DAILY" }, now),
    ).toBe("No next run");
  });

  it("names tomorrow and days further out", () => {
    const tomorrow = new Date(2026, 9, 18, 7, 45);
    expect(formatNextRun(tomorrow, now)).toBe(`tomorrow ${time}`);
    const later = new Date(2026, 10, 2, 7, 45);
    expect(formatNextRun(later, now)).toContain("Nov");
  });
});

describe("beforeClosingLine", () => {
  it("counts schedules and agents, and says when there are none", () => {
    expect(beforeClosingLine(2, 5)).toBe("Before closing: 2 schedules active, 5 agents running.");
    expect(beforeClosingLine(1, 1)).toBe("Before closing: 1 schedule active, 1 agent running.");
    expect(beforeClosingLine(0, 0)).toBe("Before closing: nothing scheduled, no agents running.");
  });
});
