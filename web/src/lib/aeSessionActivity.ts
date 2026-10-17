// What a session is doing right now, as one state the sidebar row and the chat
// status line both read: needs a response, working, quiet (working but silent),
// waiting on agents or background shells, paused until a schedule wakes it,
// or idle. Pure: every clock reading and count comes in as an input.

import type { AnyBlock, ToolGroup } from "@/lib/blocks";
import {
  formatNextRun,
  isAeCheckin,
  parseAeRrule,
  schedulesForSession,
} from "@/lib/aeRailScheduled";
import type { ScheduledTask } from "@/lib/scheduledTasksApi";
import { formatToolTitle, type ToolTitle } from "@/lib/toolTitle";
import { formatElapsed } from "@/shell/aeAgentsPaneModel";

/** A working session with no event for this long reads as quiet. */
export const AE_QUIET_AFTER_MS = 5 * 60_000;

/** The next scheduled run aimed at a session. */
export interface AeNextRun {
  /** Epoch ms of the fire. */
  at: number;
  /** What fires, as a phrase: "the hourly check-in". */
  waker: string;
}

export interface AeActivityInput {
  /** The session's own turn is in progress. */
  working: boolean;
  /** Why a working turn is parked (a terminal dialog, say); it never reads as quiet. */
  blockedOn?: string | null;
  /** Open approval or question prompts. */
  pendingQuestions: number;
  /** Running background shells; a missing count reads as none. */
  backgroundShells?: number | null;
  /** Running child sessions (subagents, collaborators); a missing count reads as none. */
  runningChildren?: number | null;
  /** Epoch ms of the newest session event, or `null` when none is known. */
  lastEventAt: number | null;
  nextRun: AeNextRun | null;
  now: number;
}

export type AeActivity =
  | { kind: "needs_response"; count: number }
  | { kind: "working"; sinceEventMs: number | null }
  | { kind: "quiet"; quietForMs: number }
  | {
      kind: "waiting";
      agents: number;
      shells: number;
      total: number;
      label: string;
      sinceEventMs: number | null;
    }
  | { kind: "scheduled"; at: number; waker: string }
  | { kind: "idle" };

function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The one state for a session, highest priority first. */
export function deriveAeActivity(input: AeActivityInput): AeActivity {
  const pending = count(input.pendingQuestions);
  if (pending > 0) return { kind: "needs_response", count: pending };
  const sinceEventMs =
    input.lastEventAt === null ? null : Math.max(0, input.now - input.lastEventAt);
  if (input.working) {
    if (!input.blockedOn && sinceEventMs !== null && sinceEventMs >= AE_QUIET_AFTER_MS) {
      return { kind: "quiet", quietForMs: sinceEventMs };
    }
    return { kind: "working", sinceEventMs };
  }
  const agents = count(input.runningChildren);
  const shells = count(input.backgroundShells);
  if (agents + shells > 0) {
    return {
      kind: "waiting",
      agents,
      shells,
      total: agents + shells,
      label: aeWaitingLabel(agents, shells),
      sinceEventMs,
    };
  }
  if (input.nextRun && input.nextRun.at > input.now) {
    return { kind: "scheduled", at: input.nextRun.at, waker: input.nextRun.waker };
  }
  return { kind: "idle" };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Waiting on 2 agents and 1 background shell". */
export function aeWaitingLabel(agents: number, shells: number): string {
  const parts: string[] = [];
  if (agents > 0) parts.push(plural(agents, "agent", "agents"));
  if (shells > 0) parts.push(plural(shells, "background shell", "background shells"));
  return parts.length === 0 ? "Waiting" : `Waiting on ${parts.join(" and ")}`;
}

/** A span in ms as the Agents pane prints it: "3m 05s", or "3m" when `compact`. */
export function aeDuration(ms: number, compact = false): string {
  return formatElapsed(Math.max(0, Math.floor(ms / 1000)), { compact });
}

/** "just now", "4s ago", "2m ago". */
export function aeFormatAgo(ms: number): string {
  if (ms < 2000) return "just now";
  return `${aeDuration(ms, true)} ago`;
}

/** "Working, but no new output for 6m". */
export function aeQuietLabel(quietForMs: number): string {
  return `Working, but no new output for ${aeDuration(quietForMs, true)}`;
}

/** "9 AM" or "9:30 PM" today (as the locale words it), "Tue" within the week, else "Oct 20". */
export function aeShortRunTime(at: number, now: number): string {
  const next = new Date(at);
  const today = new Date(now);
  if (next.toDateString() === today.toDateString()) {
    return next.toLocaleTimeString(
      undefined,
      next.getMinutes() === 0 ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" },
    );
  }
  const days = (at - now) / 86_400_000;
  if (days > 0 && days < 6) return next.toLocaleDateString(undefined, { weekday: "short" });
  return next.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "9:00 AM", "tomorrow 9:00 AM", "Tue 9:00 AM". */
export function aeRunWhen(at: number, now: number): string {
  return formatNextRun(new Date(at), new Date(now));
}

function wakesAt(at: number, now: number): string {
  const when = aeRunWhen(at, now);
  return /^\d/.test(when) ? `at ${when}` : when;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Paused; the hourly check-in wakes it at 9:00 AM". */
export function aeScheduledTooltip(next: AeNextRun, now: number): string {
  return `Paused; ${next.waker} wakes it ${wakesAt(next.at, now)}`;
}

/** "Paused until 9:00 AM". */
export function aeScheduledHeadline(next: AeNextRun, now: number): string {
  return `Paused until ${aeRunWhen(next.at, now)}`;
}

/** "The hourly check-in wakes this session; pause it from the session rail's Scheduled section." */
export function aeScheduledDetail(next: AeNextRun): string {
  return `${capitalize(next.waker)} wakes this session; pause it from the session rail's Scheduled section.`;
}

const CHECKIN_FREQ: Record<string, [single: string, unit: string]> = {
  HOURLY: ["hourly", "hours"],
  DAILY: ["daily", "days"],
  WEEKLY: ["weekly", "weeks"],
  MONTHLY: ["monthly", "months"],
};

/** "the hourly check-in", "the check-in every 2 hours", or `the "Nightly report" schedule`. */
export function aeScheduleWaker(task: Pick<ScheduledTask, "name" | "rrule">): string {
  if (!isAeCheckin(task)) return `the "${task.name}" schedule`;
  const rule = parseAeRrule(task.rrule);
  const freq = rule.freq ? CHECKIN_FREQ[rule.freq] : undefined;
  if (!freq) return "the check-in";
  return rule.interval === 1
    ? `the ${freq[0]} check-in`
    : `the check-in every ${rule.interval} ${freq[1]}`;
}

/** The soonest active schedule aimed at the session that still lies ahead. */
export function aeNextScheduledRun(
  tasks: readonly ScheduledTask[] | undefined,
  sessionId: string,
  createdIds: ReadonlySet<string>,
  now: number,
): AeNextRun | null {
  if (!tasks || tasks.length === 0) return null;
  let best: AeNextRun | null = null;
  for (const task of schedulesForSession(tasks, sessionId, createdIds)) {
    if (task.state !== "active" || !task.nextRunAt) continue;
    const at = Date.parse(task.nextRunAt);
    if (Number.isNaN(at) || at <= now) continue;
    if (best === null || at < best.at) best = { at, waker: aeScheduleWaker(task) };
  }
  return best;
}

/** Epoch ms a block was created, when it carries a wall-clock stamp. */
export function aeBlockAt(block: AnyBlock): number | null {
  const s = block.ctx.createdAtS ?? block.ctx.clientCreatedAtS;
  return typeof s === "number" ? s * 1000 : null;
}

/** Epoch ms of the newest stamped block. */
export function aeNewestBlockAt(blocks: readonly AnyBlock[]): number | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const at = aeBlockAt(blocks[i]!);
    if (at !== null) return at;
  }
  return null;
}

/**
 * Epoch ms the current turn started: the newest of the newest user message and
 * the `others` the caller knows (an unsent message, the switch to running).
 */
export function aeTurnStartedAt(
  blocks: readonly AnyBlock[],
  others: readonly (number | null | undefined)[] = [],
): number | null {
  let start: number | null = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.type === "user_message") {
      start = aeBlockAt(block);
      break;
    }
  }
  for (const at of others) {
    if (typeof at === "number" && (start === null || at > start)) start = at;
  }
  return start;
}

export interface AeStep {
  title: ToolTitle;
  /** Epoch ms the call started, when known. */
  startedAt: number | null;
  /** No result has arrived for the call yet. */
  running: boolean;
}

/**
 * The current turn's newest tool call, preferring one still waiting on its
 * result. The search stops at the turn's user message, so a call an earlier,
 * interrupted turn never answered does not read as running.
 */
export function aeCurrentStep(blocks: readonly AnyBlock[]): AeStep | null {
  const done = new Set<string>();
  let latest: AeStep | null = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.type === "user_message") break;
    if (block.type === "tool_result") {
      done.add(block.callId);
      continue;
    }
    if (block.type !== "tool_group") continue;
    const group = block as ToolGroup;
    for (let j = group.executions.length - 1; j >= 0; j--) {
      const execution = group.executions[j]!;
      const step: AeStep = {
        title: formatToolTitle(execution.name, execution.arguments, execution.argsSummary),
        startedAt: aeBlockAt(group),
        running: !done.has(execution.callId),
      };
      if (step.running) return step;
      latest ??= step;
    }
  }
  return latest;
}

/** The step as words before its code part: "running", "search", "edit". */
export function aeStepVerb(title: ToolTitle): string {
  if (title.verb === null) return "running";
  const verb = title.verb.replace(/:$/, "").trim();
  return verb.charAt(0).toLowerCase() + verb.slice(1);
}

/** Collapse whitespace and clip a step's code part for one line. */
export function aeStepBody(title: ToolTitle, max = 80): string {
  const flat = title.body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Session events can arrive many times a second; one store write a second is
// plenty for "last activity 4s ago" and the five minute quiet threshold.
const AE_LAST_EVENT_THROTTLE_MS = 1000;
const lastStamped = new Map<string, number>();

/** Record that a session event arrived, at most once a second per session. */
export function aeStampLastEvent(
  conversationId: string,
  write: (patch: { lastEventAt: number }) => void,
  now: number = Date.now(),
): void {
  const previous = lastStamped.get(conversationId);
  if (previous !== undefined && now - previous < AE_LAST_EVENT_THROTTLE_MS && now >= previous) {
    return;
  }
  lastStamped.set(conversationId, now);
  write({ lastEventAt: now });
}

/** Test helper: forget the throttle. */
export function aeResetLastEventStamps(): void {
  lastStamped.clear();
}

/**
 * Sidebar states beside the upstream ones (see `SessionState`). A row waits
 * on agents only: the list's shell count refreshes at the next turn end, so a
 * shell that exited after the turn would leave the row waiting.
 */
export type AeSessionState =
  | { kind: "quiet"; quietForMs: number }
  | { kind: "waiting"; agents: number; sinceEventMs: number | null }
  | { kind: "scheduled"; at: number; waker: string };

const AE_SESSION_STATE_KINDS: ReadonlySet<string> = new Set(["quiet", "waiting", "scheduled"]);

export function isAeSessionState(state: { kind: string }): state is AeSessionState {
  return AE_SESSION_STATE_KINDS.has(state.kind);
}
