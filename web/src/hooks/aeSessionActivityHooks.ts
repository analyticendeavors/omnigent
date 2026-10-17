// React glue for the session activity state: the sidebar's per-row and
// collapsed-project states, the chat status line's inputs, one scheduled-tasks
// query for the whole sidebar, and the clock that keeps the times current.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { aePendingCodexQuestions } from "@/components/chat/aeCodexQuestions";
import { computeIsWorking, isBackgroundTasksOnly } from "@/components/chat/chatBubbleParts";
import { useChildSessions, type ChildSessionInfo } from "@/hooks/useChildSessions";
import type { Conversation } from "@/hooks/useConversations";
import type { SessionState } from "@/hooks/useSessionState";
import { createdScheduleIds } from "@/lib/aeRailScheduled";
import {
  aeCurrentStep,
  aeNewestBlockAt,
  aeNextScheduledRun,
  aeTurnStartedAt,
  deriveAeActivity,
  type AeActivity,
  type AeNextRun,
  type AeStep,
} from "@/lib/aeSessionActivity";
import type { AeSessionProgress } from "@/lib/aeSessionProgress";
import { listScheduledTasks, type ScheduledTask } from "@/lib/scheduledTasksApi";
import type { AnyBlock } from "@/lib/blocks";
import type { BackgroundTaskInfo } from "@/lib/types";
import { childStatus } from "@/shell/subagentStatus";
import { useChatStore } from "@/store/chatStore";

/**
 * The sidebar's own scheduled-tasks list. It sits under the Tasks page key so
 * every task mutation's invalidation refreshes it, but it never polls: focus,
 * a few minutes of staleness and one refetch just after each run fires are
 * enough for a "next run" hint.
 */
export const AE_ACTIVITY_SCHEDULED_KEY = ["scheduled-tasks", "ae-session-activity"] as const;
const SCHEDULED_STALE_MS = 3 * 60_000;
const ROW_TICK_MS = 30_000;
const NO_IDS: ReadonlySet<string> = new Set();
/** The server moves `next_run_at` on once the run fires; give it this long. */
export const AE_AFTER_RUN_REFETCH_MS = 5000;
// setTimeout overflows past this and would fire at once.
const MAX_TIMER_MS = 2_147_483_647;

/** Epoch ms of the soonest active run still ahead, or `null`. */
export function aeSoonestRunAt(
  tasks: readonly ScheduledTask[] | undefined,
  now: number,
): number | null {
  let soonest: number | null = null;
  for (const task of tasks ?? []) {
    if (task.state !== "active" || !task.nextRunAt) continue;
    const at = Date.parse(task.nextRunAt);
    if (Number.isNaN(at) || at <= now) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}

// Every row reads the same list, so the rows share one timer per fire time.
const afterRunTimers = new Map<number, { timer: ReturnType<typeof setTimeout>; users: number }>();

function useRefetchAfterSoonestRun(tasks: readonly ScheduledTask[] | undefined): void {
  const queryClient = useQueryClient();
  const runAt = useMemo(() => aeSoonestRunAt(tasks, Date.now()), [tasks]);
  useEffect(() => {
    if (runAt === null) return;
    const delay = runAt - Date.now() + AE_AFTER_RUN_REFETCH_MS;
    if (delay > MAX_TIMER_MS) return;
    let entry = afterRunTimers.get(runAt);
    if (entry === undefined) {
      const timer = setTimeout(
        () => {
          afterRunTimers.delete(runAt);
          void queryClient.refetchQueries({ queryKey: AE_ACTIVITY_SCHEDULED_KEY, exact: true });
        },
        Math.max(0, delay),
      );
      entry = { timer, users: 0 };
      afterRunTimers.set(runAt, entry);
    }
    entry.users += 1;
    return () => {
      const current = afterRunTimers.get(runAt);
      if (current === undefined) return;
      current.users -= 1;
      if (current.users > 0) return;
      clearTimeout(current.timer);
      afterRunTimers.delete(runAt);
    };
  }, [queryClient, runAt]);
}

export function useAeScheduledTasks(): ScheduledTask[] | undefined {
  const tasks = useQuery<ScheduledTask[]>({
    queryKey: AE_ACTIVITY_SCHEDULED_KEY,
    queryFn: listScheduledTasks,
    staleTime: SCHEDULED_STALE_MS,
    refetchOnWindowFocus: true,
    retry: false,
  }).data;
  useRefetchAfterSoonestRun(tasks);
  return tasks;
}

/** Wall-clock ms, refreshed every `intervalMs` while it is set. */
export function useAeNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// Rows ignore `background_task_count`: it refreshes only at the next turn end,
// so a shell that exited after the turn would keep the row waiting.
function rowAgents(row: Pick<Conversation, "active_child_count">): number {
  return row.active_child_count ?? 0;
}

/** Whether the open chat says its own turn is over (children may still run). */
function useBoundTurnIdle(conversationId: string): boolean {
  return useChatStore(
    (s) =>
      s.conversationId === conversationId &&
      !s.loadingConversation &&
      s.status === "idle" &&
      !computeIsWorking(s.sessionStatus),
  );
}

function useBoundLastEventAt(conversationId: string): number | null {
  return useChatStore((s) => (s.conversationId === conversationId ? s.lastEventAt : null));
}

function useBoundBlockedOn(conversationId: string): string | null {
  return useChatStore((s) => (s.conversationId === conversationId ? s.blockedOn : null));
}

type RowInput = Pick<Conversation, "id" | "status" | "updated_at" | "active_child_count">;

/**
 * Refine one row's upstream state: running turns quiet after five silent
 * minutes (never while parked on a dialog), an idle row with agents left
 * reads as waiting, and an idle row a schedule will wake gets `scheduled`
 * (shown below the unseen dot).
 */
export function aeRowState(
  row: RowInput,
  upstream: SessionState | null,
  options: {
    now: number;
    nextRun: AeNextRun | null;
    lastEventAt: number | null;
    turnIdle: boolean;
    blockedOn?: string | null;
  },
): { state: SessionState | null; scheduled: SessionState | null } {
  const agents = rowAgents(row);
  const lastEventAt = Math.max(options.lastEventAt ?? 0, row.updated_at * 1000);
  if (upstream?.kind === "running") {
    // A busy child keeps the parent row running; the open chat knows when
    // the parent's own turn is over and the row is only waiting.
    if (options.turnIdle && agents > 0) {
      return { state: { kind: "waiting", agents, sinceEventMs: null }, scheduled: null };
    }
    // Running children keep a parent busy without its own output.
    if (agents > 0) return { state: upstream, scheduled: null };
    const activity = deriveAeActivity({
      working: true,
      blockedOn: options.blockedOn,
      pendingQuestions: 0,
      lastEventAt,
      nextRun: null,
      now: options.now,
    });
    return {
      state:
        activity.kind === "quiet" ? { kind: "quiet", quietForMs: activity.quietForMs } : upstream,
      scheduled: null,
    };
  }
  if (upstream !== null) return { state: upstream, scheduled: null };
  const activity = deriveAeActivity({
    working: false,
    pendingQuestions: 0,
    runningChildren: agents,
    lastEventAt,
    nextRun: options.nextRun,
    now: options.now,
  });
  if (activity.kind === "waiting") {
    return {
      state: { kind: "waiting", agents: activity.agents, sinceEventMs: activity.sinceEventMs },
      scheduled: null,
    };
  }
  if (activity.kind === "scheduled") {
    return {
      state: null,
      scheduled: { kind: "scheduled", at: activity.at, waker: activity.waker },
    };
  }
  return { state: null, scheduled: null };
}

/** A sidebar row's state with the activity refinements; see {@link aeRowState}. */
export function useAeSessionRowState(
  conversation: Conversation,
  upstream: SessionState | null,
): { state: SessionState | null; scheduled: SessionState | null } {
  const tasks = useAeScheduledTasks();
  const turnIdle = useBoundTurnIdle(conversation.id);
  const lastEventAt = useBoundLastEventAt(conversation.id);
  const blockedOn = useBoundBlockedOn(conversation.id);
  const [roughNow] = useState(() => Date.now());
  const candidate = useMemo(
    () => aeNextScheduledRun(tasks, conversation.id, NO_IDS, roughNow),
    [tasks, conversation.id, roughNow],
  );
  const ticks = upstream?.kind === "running" || rowAgents(conversation) > 0 || candidate !== null;
  const now = useAeNow(ticks ? ROW_TICK_MS : null);
  const nextRun = useMemo(
    () => aeNextScheduledRun(tasks, conversation.id, NO_IDS, now),
    [tasks, conversation.id, now],
  );
  return aeRowState(conversation, upstream, { now, nextRun, lastEventAt, turnIdle, blockedOn });
}

/**
 * Roll the activity states into a collapsed project's marker, keeping the
 * upstream order: a running marker turns quiet only when every running row
 * is quiet, waiting outranks unseen, and a schedule shows only on an
 * otherwise blank marker.
 */
export function aeProjectMarker(
  marker: SessionState | null,
  rows: readonly RowInput[],
  options: { now: number; tasks: readonly ScheduledTask[] | undefined },
): SessionState | null {
  if (marker?.kind === "running") {
    let quietest: number | null = null;
    for (const row of rows) {
      if (row.status !== "running") continue;
      const { state } = aeRowState(
        row,
        { kind: "running" },
        {
          now: options.now,
          nextRun: null,
          lastEventAt: null,
          turnIdle: false,
        },
      );
      if (state?.kind !== "quiet") return marker;
      quietest = quietest === null ? state.quietForMs : Math.min(quietest, state.quietForMs);
    }
    return quietest === null ? marker : { kind: "quiet", quietForMs: quietest };
  }
  if (marker !== null && marker.kind !== "unseen") return marker;
  let agents = 0;
  let next: AeNextRun | null = null;
  for (const row of rows) {
    if (row.status === "running") continue;
    agents += rowAgents(row);
    const run = aeNextScheduledRun(options.tasks, row.id, NO_IDS, options.now);
    if (run && (next === null || run.at < next.at)) next = run;
  }
  if (agents > 0) return { kind: "waiting", agents, sinceEventMs: null };
  if (marker === null && next !== null)
    return { kind: "scheduled", at: next.at, waker: next.waker };
  return marker;
}

/** A collapsed project's marker with the activity states; see {@link aeProjectMarker}. */
export function useAeProjectMarker(
  marker: SessionState | null,
  rows: readonly RowInput[],
): SessionState | null {
  const tasks = useAeScheduledTasks();
  const ticks = marker === null || marker.kind === "running" || marker.kind === "unseen";
  const now = useAeNow(ticks ? ROW_TICK_MS : null);
  return aeProjectMarker(marker, rows, { now, tasks });
}

// The chat line's waiting variant lists the shells itself, so the composer's
// background-task pill steps aside while that variant is on screen.
const waitingLines = new Map<string, number>();
const waitingListeners = new Set<() => void>();

function subscribeWaitingLines(listener: () => void): () => void {
  waitingListeners.add(listener);
  return () => waitingListeners.delete(listener);
}

export function useAeRegisterWaitingLine(conversationId: string | null, shown: boolean): void {
  useEffect(() => {
    if (!shown || conversationId === null) return;
    waitingLines.set(conversationId, (waitingLines.get(conversationId) ?? 0) + 1);
    for (const listener of waitingListeners) listener();
    return () => {
      const left = (waitingLines.get(conversationId) ?? 1) - 1;
      if (left > 0) waitingLines.set(conversationId, left);
      else waitingLines.delete(conversationId);
      for (const listener of waitingListeners) listener();
    };
  }, [conversationId, shown]);
}

export function useAeWaitingLineShown(conversationId: string | null): boolean {
  return useSyncExternalStore(subscribeWaitingLines, () =>
    conversationId === null ? false : waitingLines.has(conversationId),
  );
}

export interface AeAgentChip {
  id: string;
  label: string;
  /** Epoch ms the child started, when known. */
  startedAt: number | null;
  /** The child is held on an approval; the server's row count includes it too. */
  needsApproval: boolean;
}

function childLabel(child: ChildSessionInfo): string {
  return (
    child.task_summary?.trim() || child.session_name?.trim() || child.title?.trim() || "Sub-agent"
  );
}

const CHIP_ACTIVITIES: ReadonlySet<string> = new Set(["working", "launching", "awaiting"]);

export function aeRunningAgentChips(children: readonly ChildSessionInfo[]): AeAgentChip[] {
  const chips: AeAgentChip[] = [];
  for (const child of children) {
    const activity = childStatus(child).activity;
    if (!CHIP_ACTIVITIES.has(activity)) continue;
    chips.push({
      id: child.id,
      label: childLabel(child),
      startedAt: typeof child.created_at === "number" ? child.created_at * 1000 : null,
      needsApproval: activity === "awaiting",
    });
  }
  return chips;
}

function aeNewest(times: readonly (number | null)[]): number | null {
  let newest: number | null = null;
  for (const at of times) if (at !== null && (newest === null || at > newest)) newest = at;
  return newest;
}

/** Open questions in the chat: elicitations aimed here plus unanswered Codex questions. */
export function aePendingQuestionCount(
  blocks: AnyBlock[],
  conversationId: string | null,
  hasPendingReply: boolean,
): number {
  let count = 0;
  for (const b of blocks) {
    if (
      b.type === "elicitation" &&
      b.status === "pending" &&
      (b.targetSessionId == null || b.targetSessionId === conversationId)
    ) {
      count += 1;
    }
  }
  // A reply on its way answers the Codex question, as the transcript reads it.
  if (!hasPendingReply) {
    for (const set of aePendingCodexQuestions(blocks)) count += set.questions.length;
  }
  return count;
}

export interface AeChatActivity {
  conversationId: string | null;
  activity: AeActivity;
  blockedOn: string | null;
  step: AeStep | null;
  turnStartedAt: number | null;
  lastEventAt: number | null;
  /** The terminal's live spinner line, while one shows. */
  progress: AeSessionProgress | null;
  agents: AeAgentChip[];
  shells: BackgroundTaskInfo[];
  nextRun: AeNextRun | null;
  now: number;
}

const TICK_MS: Record<AeActivity["kind"], number | null> = {
  working: 1000,
  quiet: 1000,
  waiting: 5000,
  scheduled: 30_000,
  needs_response: null,
  idle: null,
};

/**
 * The open chat's activity. `showsWorking` is the page's own working gate
 * (it already folds in pending prompts, runner liveness and background shells).
 */
export function useAeChatActivity(showsWorking: boolean): AeChatActivity {
  const conversationId = useChatStore((s) => s.conversationId);
  const blocks = useChatStore((s) => s.blocks);
  const sessionStatus = useChatStore((s) => s.sessionStatus);
  const sending = useChatStore((s) => s.status === "streaming");
  const blockedOn = useChatStore((s) => s.blockedOn);
  const bgCount = useChatStore((s) => s.backgroundTaskCount);
  const bgTasks = useChatStore((s) => s.backgroundTasks);
  const storeLastEventAt = useChatStore((s) => s.lastEventAt);
  const progress = useChatStore((s) => s.aeProgress);
  const runningSince = useChatStore((s) => s.aeRunningSince);
  const pendingMessages = useChatStore((s) => s.pendingUserMessages);
  const { children } = useChildSessions(conversationId);
  const tasks = useAeScheduledTasks();
  const agents = useMemo(() => aeRunningAgentChips(children), [children]);
  const pendingQuestions = useMemo(
    () => aePendingQuestionCount(blocks, conversationId, pendingMessages.length > 0),
    [blocks, conversationId, pendingMessages.length],
  );
  const createdIds = useMemo(() => createdScheduleIds(blocks), [blocks]);
  const step = useMemo(() => aeCurrentStep(blocks), [blocks]);
  const pendingSentAt = useMemo(
    () => pendingMessages.map((p) => (p.createdAtS === undefined ? null : p.createdAtS * 1000)),
    [pendingMessages],
  );
  const turnStartedAt = useMemo(
    () => aeTurnStartedAt(blocks, [runningSince, ...pendingSentAt]),
    [blocks, runningSince, pendingSentAt],
  );
  const newestBlockAt = useMemo(() => aeNewestBlockAt(blocks), [blocks]);
  // The store only stamps while bound and a rebind clears it, so the newest
  // block and an unsent message date the activity too.
  const lastEventAt = aeNewest([storeLastEventAt, newestBlockAt, ...pendingSentAt]);
  const agentTurnActive = computeIsWorking(sessionStatus) || sending;
  const working = showsWorking && !isBackgroundTasksOnly(bgCount, blockedOn, agentTurnActive);

  const [kindForTick, setKindForTick] = useState<AeActivity["kind"]>("idle");
  const now = useAeNow(TICK_MS[kindForTick]);
  const nextRun = useMemo(
    () => (conversationId ? aeNextScheduledRun(tasks, conversationId, createdIds, now) : null),
    [tasks, conversationId, createdIds, now],
  );
  const activity = deriveAeActivity({
    working,
    blockedOn,
    pendingQuestions,
    // Shells count only while the page shows them (a known-offline runner hides them).
    backgroundShells: showsWorking ? bgCount : 0,
    runningChildren: agents.length,
    lastEventAt,
    nextRun,
    now,
  });
  useEffect(() => setKindForTick(activity.kind), [activity.kind]);
  return {
    conversationId,
    activity,
    blockedOn,
    step,
    turnStartedAt,
    lastEventAt,
    progress,
    agents,
    shells: showsWorking ? bgTasks.slice(0, bgCount) : [],
    nextRun,
    now,
  };
}
