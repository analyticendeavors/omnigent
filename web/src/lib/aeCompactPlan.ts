// Queued compact (omnigent-ae). Clicking Compact never compacts on the spot: it queues a
// plan for the open chat. At a safe point (no turn running and nothing queued) the chat
// gets one normal turn that asks it to save what is worth keeping, and only when that turn
// ends does the compact event go out. The plan lives in the page: a reload forgets it, and
// nothing compacts by accident.
//
// Background shells do not hold a plan back (2026-11-01). A shell outlives the turn that
// started it and survives /compact, and the server reports a turn that ends with a shell still
// running as `idle` with a shell count that stays sticky until the next turn ends, so a lead chat
// with a CI wait running kept its Compact queued forever.
//
// The prepare turn is the one that carries the prepare message. Another turn (a shell's task
// notification, a scheduled prompt, a sub-agent hand-back) can run while that message is still in
// flight or buffered by the runner, so nothing counts until the prepare message itself is in the
// transcript (2026-11-01).
//
// The driver is module level, not a component effect, so folding the rail or losing the
// dock card never drops a queued compact.

import { useSyncExternalStore } from "react";
import { showToast } from "@/components/ui/toast";
import { useChatStore } from "@/store/chatStore";

export type AeCompactPhase = "queued" | "preparing" | "compacting";

/** The text the chat gets at the safe point. */
export const AE_COMPACT_PREP_TEXT =
  "Compaction runs right after this turn. Save anything worth keeping to memory or a handoff note now: " +
  "decisions and why, open work, file paths, what to do next. Start no new work and do not compact yourself. " +
  "Reply with one line, 'ready', when you are done.";

/** The chat must stay idle this long before a step goes ahead (turns hand off to queued work). */
export const AE_COMPACT_STABLE_MS = 2000;
/** The prepare turn never started within this long: give up, compact nothing. */
export const AE_COMPACT_START_LIMIT_MS = 30_000;
/** The prepare turn never finished within this long: give up, compact nothing. */
export const AE_COMPACT_PREP_LIMIT_MS = 15 * 60_000;

interface Plan {
  phase: AeCompactPhase;
  /** Any turn ran after the prepare message went out: only the 30 s start timer reads it. */
  sawRunning: boolean;
  /** The session ran while the prepare message was in the transcript: the prepare turn. */
  sawTurn: boolean;
  /**
   * The prepare messages the transcript already held at send time (an earlier compact's), by
   * object and by server item id: neither is this plan's anchor.
   */
  seenBlocks: WeakSet<object>;
  seenItems: Set<string>;
  stableTimer: ReturnType<typeof setTimeout> | null;
  limitTimer: ReturnType<typeof setTimeout> | null;
  startTimer: ReturnType<typeof setTimeout> | null;
  onCompacted?: () => void;
}

const plans = new Map<string, Plan>();
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function emit() {
  for (const listener of listeners) listener();
}

type StoreState = ReturnType<typeof useChatStore.getState>;

/**
 * A turn end: no turn streaming or running, nothing queued for this chat. Background shells are
 * not looked at: they outlive turns, survive /compact, and their count on an `idle` status stays
 * sticky until the next turn ends. `waiting` counts as idle for parity with the store's message
 * queue (`maybeFlushQueuedHead`), which treats it as free to take a turn.
 */
function safeNow(s: StoreState, conversationId: string): boolean {
  if (s.status === "streaming") return false;
  if (s.sessionStatus !== "idle" && s.sessionStatus !== "waiting") return false;
  return !s.queuedMessages.some((m) => m.conversationId === conversationId);
}

function isPrepareMessage(b: StoreState["blocks"][number]): boolean {
  return (
    b.type === "user_message" &&
    JSON.stringify(b.content).includes(AE_COMPACT_PREP_TEXT.slice(0, 40))
  );
}

/**
 * Where this plan's prepare message sits in the transcript, or -1 while it is not there yet. It
 * lands only once the runner consumed it (`session_input_consumed`), and keeps its server item id
 * however history loads or shrinks; a prepare message that was there at send time is not it.
 */
function prepareAnchor(blocks: StoreState["blocks"], plan: Plan): number {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const b = blocks[index]!;
    if (!isPrepareMessage(b) || plan.seenBlocks.has(b)) continue;
    if (b.ctx.itemId && plan.seenItems.has(b.ctx.itemId)) continue;
    return index;
  }
  return -1;
}

function clearTimers(plan: Plan) {
  if (plan.stableTimer) clearTimeout(plan.stableTimer);
  if (plan.limitTimer) clearTimeout(plan.limitTimer);
  if (plan.startTimer) clearTimeout(plan.startTimer);
  plan.stableTimer = null;
  plan.limitTimer = null;
  plan.startTimer = null;
}

function finish(conversationId: string) {
  const plan = plans.get(conversationId);
  if (!plan) return;
  clearTimers(plan);
  plans.delete(conversationId);
  if (plans.size === 0 && unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  emit();
}

function fail(conversationId: string, message: string) {
  finish(conversationId);
  showToast(message);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function advance(conversationId: string) {
  const plan = plans.get(conversationId);
  if (!plan) return;
  const store = useChatStore.getState();
  if (store.conversationId !== conversationId || !safeNow(store, conversationId)) return;
  if (plan.phase === "queued") {
    const agentId = store.boundAgentId;
    if (agentId === null) {
      fail(conversationId, "Compact cancelled: this chat has no agent to ask to save its notes.");
      return;
    }
    plan.phase = "preparing";
    plan.sawRunning = false;
    plan.sawTurn = false;
    for (const b of store.blocks) {
      if (!isPrepareMessage(b)) continue;
      plan.seenBlocks.add(b);
      if (b.ctx.itemId) plan.seenItems.add(b.ctx.itemId);
    }
    plan.limitTimer = setTimeout(
      () => fail(conversationId, "Compact cancelled: the chat took too long to save its notes."),
      AE_COMPACT_PREP_LIMIT_MS,
    );
    // Only the server reporting the session running proves a turn started; a busy blip from the
    // send latch, a background shell or a queued message does not. Any turn keeps the plan alive
    // here (the prepare message may wait behind it); the 15 minute limit ends a plan whose
    // prepare turn never comes.
    plan.startTimer = setTimeout(() => {
      plan.startTimer = null;
      if (!plan.sawRunning && !plan.sawTurn) {
        fail(conversationId, "Compact cancelled: the chat never started saving its notes.");
      }
    }, AE_COMPACT_START_LIMIT_MS);
    emit();
    try {
      await store.send(AE_COMPACT_PREP_TEXT, agentId, undefined, {
        onError: (error: unknown) => {
          if (plans.get(conversationId) === plan) {
            fail(
              conversationId,
              `Compact cancelled: could not ask the chat to save its notes (${reason(error)}).`,
            );
          }
        },
      });
    } catch (error) {
      if (plans.get(conversationId) === plan) {
        fail(
          conversationId,
          `Compact cancelled: could not ask the chat to save its notes (${reason(error)}).`,
        );
      }
    }
    return;
  }
  if (plan.phase !== "preparing") return;
  // Idle, but the prepare turn has not been seen running: keep waiting; the start timer and the
  // 15 minute limit end it.
  if (!plan.sawTurn) return;
  const anchor = prepareAnchor(store.blocks, plan);
  if (anchor < 0) return;
  // A turn that failed, was cancelled, or raised an error did not finish saving: compact nothing.
  const failed = store.blocks
    .slice(anchor + 1)
    .some(
      (b) =>
        (b.type === "response_end" && b.status !== "completed") ||
        (b.type === "error" && b.level !== "info"),
    );
  if (failed) {
    fail(
      conversationId,
      "Compact cancelled: the chat did not finish saving its notes cleanly, so nothing was compacted.",
    );
    return;
  }
  plan.phase = "compacting";
  if (plan.limitTimer) clearTimeout(plan.limitTimer);
  plan.limitTimer = null;
  emit();
  try {
    // A shell that finishes between the quiet window and this call wakes the chat into a new
    // turn; Claude Code queues the typed /compact and runs it after that turn.
    await store.compact();
    const done = plan.onCompacted;
    finish(conversationId);
    done?.();
  } catch (error) {
    fail(
      conversationId,
      `Could not compact the session (${reason(error)}). Try again, or send /compact from the composer.`,
    );
  }
}

function schedule(conversationId: string, plan: Plan) {
  if (plan.stableTimer) clearTimeout(plan.stableTimer);
  plan.stableTimer = setTimeout(() => {
    plan.stableTimer = null;
    void advance(conversationId);
  }, AE_COMPACT_STABLE_MS);
}

/** Runs on every store change: re-arms the quiet timer at a turn end, cancels it while busy. */
function onStore() {
  const store = useChatStore.getState();
  for (const [conversationId, plan] of [...plans]) {
    if (plan.phase === "compacting") continue;
    if (store.conversationId !== conversationId) {
      fail(conversationId, "Compact cancelled: you left the chat before it ran.");
      continue;
    }
    // The prepare turn is the session running while this plan's prepare message is in the
    // transcript: a turn that ran and ended before the message landed was some other turn.
    if (plan.phase === "preparing" && !plan.sawTurn && store.sessionStatus === "running") {
      plan.sawRunning = true;
      if (prepareAnchor(store.blocks, plan) >= 0) {
        plan.sawTurn = true;
        if (plan.startTimer) clearTimeout(plan.startTimer);
        plan.startTimer = null;
      }
    }
    if (safeNow(store, conversationId)) {
      if (!plan.stableTimer) schedule(conversationId, plan);
    } else {
      if (plan.stableTimer) clearTimeout(plan.stableTimer);
      plan.stableTimer = null;
    }
  }
}

/** Queue a compact for the chat. A chat that already has one queued is left alone. */
export function startAeCompactPlan(conversationId: string, onCompacted?: () => void): void {
  if (plans.has(conversationId)) return;
  const plan: Plan = {
    phase: "queued",
    sawRunning: false,
    sawTurn: false,
    seenBlocks: new WeakSet(),
    seenItems: new Set(),
    stableTimer: null,
    limitTimer: null,
    startTimer: null,
    onCompacted,
  };
  plans.set(conversationId, plan);
  unsubscribe ??= useChatStore.subscribe(onStore);
  emit();
  onStore();
}

/** Cancel a plan before it compacts. Once the compact event is going out it cannot be stopped. */
export function cancelAeCompactPlan(conversationId: string): void {
  const plan = plans.get(conversationId);
  if (!plan || plan.phase === "compacting") return;
  finish(conversationId);
}

/** Where the chat's plan stands, or `null` when none is queued. */
export function useAeCompactPlan(conversationId: string | null | undefined): AeCompactPhase | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => (conversationId ? (plans.get(conversationId)?.phase ?? null) : null),
    () => null,
  );
}

/** Test helper: drop every plan without a toast. */
export function resetAeCompactPlans(): void {
  for (const id of [...plans.keys()]) finish(id);
}
