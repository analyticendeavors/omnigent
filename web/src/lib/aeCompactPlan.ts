// Queued compact (omnigent-ae). Clicking Compact never compacts on the spot: it queues a
// plan for the open chat. At a safe point (no turn running and nothing queued) the chat
// gets one normal turn that asks it to save what is worth keeping, and only when that turn
// ends does the compact event go out. The plan lives in the page: a reload forgets it, and
// nothing compacts by accident.
//
// Background shells do not hold a plan back (2026-11-01). A shell outlives the turn that
// started it and survives /compact, and the page's shell tally stays sticky until the next
// turn ends, so a lead chat with a CI wait running kept its Compact queued forever.
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
  sawTurn: boolean;
  /** What the transcript held when the prepare message went out: history is not this turn's. */
  seenBlocks: WeakSet<object>;
  seenResponses: Set<string>;
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
 * A turn end: no turn streaming or running, nothing queued for this chat. `waiting` counts as
 * idle, because it is the turn-end status a claude-native chat publishes while a background
 * shell still runs (the store's message queue treats it the same way). Background shells are
 * not looked at: they outlive turns, survive /compact, and their tally stays sticky until the
 * next turn ends.
 */
function safeNow(s: StoreState, conversationId: string): boolean {
  if (s.status === "streaming") return false;
  if (s.sessionStatus !== "idle" && s.sessionStatus !== "waiting") return false;
  return !s.queuedMessages.some((m) => m.conversationId === conversationId);
}

/**
 * The blocks the prepare turn added. They follow the prepare message itself, which stays found
 * however history loads or shrinks; without it, whatever was not in the transcript at send time.
 */
function blocksOfPrepareTurn(blocks: StoreState["blocks"], plan: Plan): StoreState["blocks"] {
  let anchor = -1;
  blocks.forEach((b, index) => {
    if (
      b.type === "user_message" &&
      JSON.stringify(b.content).includes(AE_COMPACT_PREP_TEXT.slice(0, 40))
    ) {
      anchor = index;
    }
  });
  if (anchor >= 0) return blocks.slice(anchor + 1);
  return blocks.filter(
    (b) =>
      !plan.seenBlocks.has(b) && !(b.ctx.responseId && plan.seenResponses.has(b.ctx.responseId)),
  );
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
    plan.sawTurn = false;
    for (const b of store.blocks) {
      plan.seenBlocks.add(b);
      if (b.ctx.responseId) plan.seenResponses.add(b.ctx.responseId);
    }
    plan.limitTimer = setTimeout(
      () => fail(conversationId, "Compact cancelled: the chat took too long to save its notes."),
      AE_COMPACT_PREP_LIMIT_MS,
    );
    // Only the server reporting the session running proves the prepare turn started; a busy
    // blip from the send latch, a background shell or a queued message does not.
    plan.startTimer = setTimeout(() => {
      plan.startTimer = null;
      if (!plan.sawTurn) {
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
  // Idle, but the prepare turn has not been seen running: the start timer decides.
  if (!plan.sawTurn) return;
  // A turn that failed, was cancelled, or raised an error did not finish saving: compact nothing.
  const failed = blocksOfPrepareTurn(store.blocks, plan).some(
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
    if (plan.phase === "preparing" && !plan.sawTurn && store.sessionStatus === "running") {
      plan.sawTurn = true;
      if (plan.startTimer) clearTimeout(plan.startTimer);
      plan.startTimer = null;
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
    sawTurn: false,
    seenBlocks: new WeakSet(),
    seenResponses: new Set(),
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
