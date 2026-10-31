// Queued compact (omnigent-ae). Clicking Compact never compacts on the spot: it queues a
// plan for the open chat. At a safe point (the chat idle and quiet) the chat gets one
// normal turn that asks it to save what is worth keeping, and only when that turn ends
// does the compact event go out. The plan lives in the page: a reload forgets it, and
// nothing compacts by accident.
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
  sawBusy: boolean;
  preparingSince: number;
  stableTimer: ReturnType<typeof setTimeout> | null;
  limitTimer: ReturnType<typeof setTimeout> | null;
  onCompacted?: () => void;
}

const plans = new Map<string, Plan>();
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function emit() {
  for (const listener of listeners) listener();
}

type StoreState = ReturnType<typeof useChatStore.getState>;

/** Idle and quiet: no turn, nothing waiting on the user, no background shell, nothing queued. */
function safeNow(s: StoreState, conversationId: string): boolean {
  if (s.status === "streaming") return false;
  if (s.sessionStatus !== "idle") return false;
  if (s.backgroundTasks.some((t) => t.status === "running")) return false;
  return !s.queuedMessages.some((m) => m.conversationId === conversationId);
}

function clearTimers(plan: Plan) {
  if (plan.stableTimer) clearTimeout(plan.stableTimer);
  if (plan.limitTimer) clearTimeout(plan.limitTimer);
  plan.stableTimer = null;
  plan.limitTimer = null;
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
    plan.sawBusy = false;
    plan.preparingSince = Date.now();
    plan.limitTimer = setTimeout(
      () => fail(conversationId, "Compact cancelled: the chat took too long to save its notes."),
      AE_COMPACT_PREP_LIMIT_MS,
    );
    emit();
    // If the prepare turn never shows as running, this re-checks until the start limit.
    schedule(conversationId, plan);
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
  if (!plan.sawBusy) {
    // Idle before the prepare turn ever showed as running: wait for it, up to the start limit.
    if (Date.now() - plan.preparingSince > AE_COMPACT_START_LIMIT_MS) {
      fail(conversationId, "Compact cancelled: the chat never started saving its notes.");
    } else {
      schedule(conversationId, plan);
    }
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

/** Runs on every store change: re-arms the quiet timer while idle, cancels it while busy. */
function onStore() {
  const store = useChatStore.getState();
  for (const [conversationId, plan] of [...plans]) {
    if (plan.phase === "compacting") continue;
    if (store.conversationId !== conversationId) {
      fail(conversationId, "Compact cancelled: you left the chat before it ran.");
      continue;
    }
    if (safeNow(store, conversationId)) {
      if (!plan.stableTimer) schedule(conversationId, plan);
    } else {
      if (plan.stableTimer) clearTimeout(plan.stableTimer);
      plan.stableTimer = null;
      if (plan.phase === "preparing") plan.sawBusy = true;
    }
  }
}

/** Queue a compact for the chat. A chat that already has one queued is left alone. */
export function startAeCompactPlan(conversationId: string, onCompacted?: () => void): void {
  if (plans.has(conversationId)) return;
  const plan: Plan = {
    phase: "queued",
    sawBusy: false,
    preparingSince: 0,
    stableTimer: null,
    limitTimer: null,
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
