// The session rail's Scheduled section, the pure parts: which scheduled tasks
// are aimed at the session, how each row names itself, and when it fires.

import type { AnyBlock } from "@/lib/blocks";
import type { ScheduledTask } from "@/lib/scheduledTasksApi";

/** The orchestrator check-in's row name (ae_omni_policies schedules.py CHECKIN_NAME). */
export const AE_CHECKIN_NAME = "AE orchestrator check-in";

const CREATE_TOOL = /(^|__)sys_scheduled_task_create$/;
// The created task's id in the tool's JSON answer, escaped or not.
const CREATED_ID = /\\?"id\\?"\s*:\s*\\?"([0-9a-f]{32})\\?"/i;

/** Ids of scheduled tasks this session created through `sys_scheduled_task_create`. */
export function createdScheduleIds(blocks: readonly AnyBlock[]): Set<string> {
  const ids = new Set<string>();
  const calls = new Set<string>();
  const take = (output: string | null) => {
    const match = output ? CREATED_ID.exec(output) : null;
    if (match) ids.add(match[1].toLowerCase());
  };
  for (const block of blocks) {
    if (block.type === "tool_group") {
      for (const execution of block.executions) {
        if (!CREATE_TOOL.test(execution.name)) continue;
        calls.add(execution.callId);
        take(execution.output);
      }
    } else if (block.type === "tool_result") {
      if (CREATE_TOOL.test(block.name) || calls.has(block.callId)) take(block.output);
    }
  }
  return ids;
}

export function isAeCheckin(task: Pick<ScheduledTask, "name">): boolean {
  return task.name === AE_CHECKIN_NAME;
}

/**
 * The tasks aimed at this session, check-ins first: any whose prompt names the
 * session (the check-in hands off to the session its prompt names) and any
 * the session created.
 */
export function schedulesForSession(
  tasks: readonly ScheduledTask[],
  sessionId: string,
  createdIds: ReadonlySet<string>,
): ScheduledTask[] {
  const mine = tasks.filter(
    (task) => task.prompt.includes(sessionId) || createdIds.has(task.id.toLowerCase()),
  );
  return [...mine.filter(isAeCheckin), ...mine.filter((task) => !isAeCheckin(task))];
}

export interface AeRrule {
  freq: string | null;
  interval: number;
  count: number | null;
  /** UNTIL as a time, or `null` when the rule has none or it does not parse. */
  until: Date | null;
}

/** The parts of an RFC 5545 rule the rail shows. */
export function parseAeRrule(rrule: string): AeRrule {
  const parts = new Map<string, string>();
  for (const piece of rrule.replace(/^RRULE:/i, "").split(";")) {
    const [key, value] = piece.split("=");
    if (key && value !== undefined) parts.set(key.trim().toUpperCase(), value.trim());
  }
  const interval = Number(parts.get("INTERVAL") ?? "1");
  const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : null;
  return {
    freq: parts.get("FREQ")?.toUpperCase() ?? null,
    interval: Number.isInteger(interval) && interval > 0 ? interval : 1,
    count: count !== null && Number.isInteger(count) ? count : null,
    until: parseUntil(parts.get("UNTIL")),
  };
}

function parseUntil(value: string | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h = "23", mi = "59", s = "59", z] = m;
  const args = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)] as const;
  return z ? new Date(Date.UTC(...args)) : new Date(...args);
}

const FREQ_UNIT: Record<string, string> = {
  HOURLY: "hour",
  DAILY: "day",
  WEEKLY: "week",
  MONTHLY: "month",
};

/** "Check-in every hour", "Check-in every 2 hours"; any other task keeps its own name. */
export function scheduleTitle(task: Pick<ScheduledTask, "name" | "rrule">): string {
  if (!isAeCheckin(task)) return task.name;
  const rule = parseAeRrule(task.rrule);
  const unit = rule.freq ? FREQ_UNIT[rule.freq] : undefined;
  if (!unit) return "Check-in";
  return rule.interval === 1
    ? `Check-in every ${unit}`
    : `Check-in every ${rule.interval} ${unit}s`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 7:45 AM today, "tomorrow 7:45 AM", "Tue 7:45 AM" within the week, else "Oct 20, 7:45 AM". */
export function formatNextRun(next: Date, now: Date): string {
  const time = next.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay(next, now)) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(next, tomorrow)) return `tomorrow ${time}`;
  const days = (next.getTime() - now.getTime()) / 86_400_000;
  if (days > 0 && days < 6) {
    return `${next.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  }
  return `${next.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** The UNTIL date as the task's own timezone reads it ("Oct 20"). */
function formatUntil(until: Date, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  try {
    return until.toLocaleDateString(undefined, { ...options, timeZone });
  } catch {
    return until.toLocaleDateString(undefined, options);
  }
}

/** "Next 7:45 AM · until Oct 20", "Next 9:00 AM · once", or "Paused". */
export function scheduleWhen(
  task: Pick<ScheduledTask, "state" | "nextRunAt" | "rrule" | "timezone">,
  now: Date,
): string {
  if (task.state === "paused") return "Paused";
  const rule = parseAeRrule(task.rrule);
  const parts: string[] = [];
  const next = task.nextRunAt ? new Date(task.nextRunAt) : null;
  parts.push(
    next && !Number.isNaN(next.getTime()) ? `Next ${formatNextRun(next, now)}` : "No next run",
  );
  if (rule.count === 1) parts.push("once");
  else if (rule.until) parts.push(`until ${formatUntil(rule.until, task.timezone)}`);
  return parts.join(" · ");
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Before closing: 2 schedules active, 5 agents running." */
export function beforeClosingLine(activeSchedules: number, runningAgents: number): string {
  const schedules =
    activeSchedules > 0
      ? `${plural(activeSchedules, "schedule", "schedules")} active`
      : "nothing scheduled";
  const agents =
    runningAgents > 0 ? `${plural(runningAgents, "agent", "agents")} running` : "no agents running";
  return `Before closing: ${schedules}, ${agents}.`;
}
