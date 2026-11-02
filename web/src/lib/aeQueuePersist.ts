// Queued notes survive a reload (omnigent-ae, 2026-11-01). A message sent while the chat is
// busy waits in the client-side queue (`queuedMessages` in chatStore) until the turn ends. That
// queue lived only in page memory, so a reload, a phone tab discard, the chunk-error auto-reload
// or the "Omnigent was updated" reload during a long turn lost it without a word: on 2026-11-01 a
// note went this way during a 28-minute turn.
//
// This module mirrors the queue into sessionStorage (per tab; it survives a reload and usually a
// tab discard) on every change, and puts it back once per page. A Web Lock named after a per-tab
// id decides who owns the stored copy: a duplicated tab copies sessionStorage, and only the tab
// that still holds the lock may send those notes. Restored notes flush through the existing
// queue paths only (the chat page's flush and `flushBackgroundQueues`); nothing here sends.
//
// Kept out: attachments (File objects cannot be stored; their names come back and the note waits
// for Retry), notes older than an hour (they wait for Retry), and anything across devices.

import { showToast } from "@/components/ui/toast";
import { getCurrentUserId, resolveIdentity } from "@/lib/identity";
import { randomUUID } from "@/lib/randomUUID";
import { readComposerDraft } from "@/lib/replyDraft";
import { isTempConvId } from "@/lib/tempConversationId";
import { useChatStore, type QueuedMessage } from "@/store/chatStore";

/** sessionStorage key of the stored queue document. */
export const AE_QUEUE_STORAGE_KEY = "omnigent:ae-queued-messages:v1";
/** sessionStorage key of this tab's id (a duplicated tab copies it). */
export const AE_QUEUE_TAB_ID_KEY = "omnigent:ae-queue-tab-id:v1";
/** Web Lock name prefix; the full name is the prefix plus the tab id. */
export const AE_QUEUE_LOCK_PREFIX = "omnigent:ae-queue-owner";
/** How long a restore waits for the tab lock (a reload's dying page frees it almost at once). */
export const AE_QUEUE_LOCK_WAIT_MS = 1000;
/** A restored note older than this waits for Retry instead of sending on its own. */
export const AE_QUEUE_AUTO_SEND_MAX_AGE_MS = 60 * 60_000;
/** At most this many notes are stored; past it new ones stay in memory only. */
export const AE_QUEUE_MAX_STORED = 50;
/** Prefix of a restored note's queue id. */
export const AE_QUEUE_RESTORED_ID_PREFIX = "q_ae_";

const DOC_VERSION = 1;
const LOG_PREFIX = "[ae-queue-persist]";

/** One stored note: every QueuedMessage field except `files`, which becomes names only. */
interface StoredEntry {
  text: string;
  conversationId: string;
  agentId?: string;
  stableId?: string;
  command?: "compact";
  replyDraft?: QueuedMessage["replyDraft"];
  requiresRetry?: boolean;
  fileNames?: string[];
  /** When this page first saw the note; stamped once per note and never refreshed. */
  firstSeenAt: number;
}

interface StoredDoc {
  v: number;
  userId: string | null;
  entries: StoredEntry[];
}

// Module state: one restore per page, whatever mounts and unmounts.
let started = false;
let restoring = false;
let pendingEntries: StoredEntry[] = [];
let storedUserId: string | null = null;
let unsubscribe: (() => void) | null = null;
let restorePromise: Promise<void> = Promise.resolve();
let lockWaitMs = AE_QUEUE_LOCK_WAIT_MS;
let warnedCap = false;
const firstSeen = new Map<string, number>();
let persistedKeys = new Set<string>();
const heldLocks: (() => void)[] = [];

function noteKey(entry: { stableId?: string; queueId?: string; text: string }): string {
  return entry.stableId ?? entry.queueId ?? entry.text;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEntry(raw: unknown): StoredEntry | null {
  if (!isRecord(raw)) return null;
  const { text, conversationId, firstSeenAt } = raw;
  if (typeof text !== "string" || typeof conversationId !== "string") return null;
  if (conversationId === "" || isTempConvId(conversationId)) return null;
  if (typeof firstSeenAt !== "number" || !Number.isFinite(firstSeenAt)) return null;
  const entry: StoredEntry = { text, conversationId, firstSeenAt };
  if (typeof raw.agentId === "string") entry.agentId = raw.agentId;
  if (typeof raw.stableId === "string" && raw.stableId !== "") entry.stableId = raw.stableId;
  if (raw.command === "compact") entry.command = "compact";
  const replyDraft = readComposerDraft({ text, replyDraft: raw.replyDraft })?.replyDraft;
  if (replyDraft !== undefined) entry.replyDraft = replyDraft;
  if (raw.requiresRetry === true) entry.requiresRetry = true;
  if (Array.isArray(raw.fileNames)) {
    const names = raw.fileNames.filter((n): n is string => typeof n === "string");
    if (names.length > 0) entry.fileNames = names;
  }
  return entry;
}

/** The stored document, or null when it is missing, malformed or another version. */
function readDoc(): StoredDoc | null {
  try {
    const raw = storage()?.getItem(AE_QUEUE_STORAGE_KEY);
    if (!raw) return null;
    const doc: unknown = JSON.parse(raw);
    if (!isRecord(doc) || doc.v !== DOC_VERSION || !Array.isArray(doc.entries)) return null;
    const entries: StoredEntry[] = [];
    for (const item of doc.entries) {
      const entry = readEntry(item);
      if (entry !== null) entries.push(entry);
    }
    return { v: DOC_VERSION, userId: typeof doc.userId === "string" ? doc.userId : null, entries };
  } catch {
    return null;
  }
}

function toStored(message: QueuedMessage, now: number): StoredEntry {
  const key = noteKey(message);
  let seen = firstSeen.get(key);
  if (seen === undefined) {
    seen = now;
    firstSeen.set(key, seen);
  }
  const entry: StoredEntry = {
    text: message.text,
    conversationId: message.conversationId,
    firstSeenAt: seen,
  };
  if (message.agentId !== undefined) entry.agentId = message.agentId;
  if (message.stableId !== undefined) entry.stableId = message.stableId;
  if (message.command !== undefined) entry.command = message.command;
  if (message.replyDraft !== undefined) entry.replyDraft = message.replyDraft;
  if (message.requiresRetry === true) entry.requiresRetry = true;
  const names = (message.files ?? []).map((f) => f.name);
  if (names.length > 0) entry.fileNames = names;
  return entry;
}

/** Write the queue (plus any notes still waiting to be restored) to storage, now. */
function writeQueue(queue: readonly QueuedMessage[]): void {
  const now = Date.now();
  const candidates: StoredEntry[] = [
    ...pendingEntries,
    ...queue.filter((m) => !isTempConvId(m.conversationId)).map((m) => toStored(m, now)),
  ];
  // Notes already stored always stay; new ones join only while there is room.
  let room = AE_QUEUE_MAX_STORED - candidates.filter((e) => persistedKeys.has(noteKey(e))).length;
  const kept: StoredEntry[] = [];
  let overCap = false;
  for (const entry of candidates) {
    if (persistedKeys.has(noteKey(entry))) {
      kept.push(entry);
    } else if (room > 0) {
      kept.push(entry);
      room -= 1;
    } else {
      overCap = true;
    }
  }
  if (overCap && !warnedCap) {
    warnedCap = true;
    console.warn(
      `${LOG_PREFIX} more than ${AE_QUEUE_MAX_STORED} queued notes: the newest ones are not kept through a reload`,
    );
  }
  persistedKeys = new Set(kept.map(noteKey));
  try {
    const store = storage();
    if (store === null) return;
    if (kept.length === 0) {
      store.removeItem(AE_QUEUE_STORAGE_KEY);
      return;
    }
    const doc: StoredDoc = {
      v: DOC_VERSION,
      userId: getCurrentUserId() ?? storedUserId,
      entries: kept,
    };
    store.setItem(AE_QUEUE_STORAGE_KEY, JSON.stringify(doc));
  } catch {
    // Storage full or unavailable: the queue still works in memory.
  }
}

function webLocksAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.locks !== "undefined" &&
    typeof navigator.locks.request === "function"
  );
}

function newTabId(): string {
  return randomUUID().replace(/-/g, "");
}

function readTabId(): string {
  try {
    const store = storage();
    const existing = store?.getItem(AE_QUEUE_TAB_ID_KEY);
    if (existing) return existing;
    const id = newTabId();
    store?.setItem(AE_QUEUE_TAB_ID_KEY, id);
    return id;
  } catch {
    return newTabId();
  }
}

/** Hold `name` for the page's lifetime; resolve true once held, false if not granted in `waitMs`. */
function holdTabLock(name: string, waitMs: number | null): Promise<boolean> {
  return new Promise((settle) => {
    const controller = waitMs === null ? null : new AbortController();
    const timer =
      controller === null || waitMs === null ? null : setTimeout(() => controller.abort(), waitMs);
    navigator.locks
      .request(name, controller === null ? {} : { signal: controller.signal }, () => {
        if (timer !== null) clearTimeout(timer);
        settle(true);
        return new Promise<void>((release) => {
          heldLocks.push(release);
        });
      })
      .catch(() => {
        if (timer !== null) clearTimeout(timer);
        settle(false);
      });
  });
}

type Ownership = "owned" | "other-tab" | "no-locks";

async function claimOwnership(): Promise<Ownership> {
  if (!webLocksAvailable()) return "no-locks";
  try {
    if (await holdTabLock(`${AE_QUEUE_LOCK_PREFIX}:${readTabId()}`, lockWaitMs)) return "owned";
    // Another live (or frozen) tab holds this id: it was duplicated from this one. Take a fresh
    // id so this tab's own notes have an owner from now on.
    const fresh = newTabId();
    try {
      storage()?.setItem(AE_QUEUE_TAB_ID_KEY, fresh);
    } catch {
      // Without storage the next reload mints another id; nothing to keep.
    }
    void holdTabLock(`${AE_QUEUE_LOCK_PREFIX}:${fresh}`, null);
    return "other-tab";
  } catch {
    return "no-locks";
  }
}

async function currentIdentity(): Promise<string | null> {
  // Only a stored document that names a user needs the comparison; skip the probe otherwise.
  if (pendingEntries.length === 0 || storedUserId === null) return getCurrentUserId();
  try {
    return await resolveIdentity();
  } catch {
    return getCurrentUserId();
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

async function restore(): Promise<void> {
  const [ownership, userId] = await Promise.all([claimOwnership(), currentIdentity()]);
  const entries = pendingEntries;
  const identityMismatch =
    storedUserId !== null && userId !== null && storedUserId !== userId ? entries.length : 0;
  const otherTab = ownership === "other-tab" && identityMismatch === 0 ? entries.length : 0;
  const usable = identityMismatch > 0 || otherTab > 0 ? [] : entries;

  const now = Date.now();
  const current = useChatStore.getState().queuedMessages;
  const currentIds = new Set(current.map((m) => m.stableId).filter((id) => id !== undefined));
  const restored: QueuedMessage[] = [];
  let auto = 0;
  let withFiles = 0;
  let tooOld = 0;
  let wasRetry = 0;
  for (const entry of usable) {
    const stableId = entry.stableId ?? randomUUID().replace(/-/g, "");
    if (currentIds.has(stableId)) continue;
    currentIds.add(stableId);
    firstSeen.set(stableId, entry.firstSeenAt);
    const hasFiles = (entry.fileNames?.length ?? 0) > 0;
    const old = now - entry.firstSeenAt >= AE_QUEUE_AUTO_SEND_MAX_AGE_MS;
    const sendsItself = ownership === "owned" && !hasFiles && !old && entry.requiresRetry !== true;
    if (sendsItself) auto += 1;
    else if (entry.requiresRetry === true) wasRetry += 1;
    else if (hasFiles) withFiles += 1;
    else if (old) tooOld += 1;
    restored.push({
      queueId: `${AE_QUEUE_RESTORED_ID_PREFIX}${stableId}`,
      text: entry.text,
      conversationId: entry.conversationId,
      stableId,
      ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
      ...(entry.command !== undefined ? { command: entry.command } : {}),
      ...(entry.replyDraft !== undefined ? { replyDraft: entry.replyDraft } : {}),
      ...(sendsItself ? {} : { requiresRetry: true }),
    });
  }

  // The window is over: from here the store alone is what gets written.
  pendingEntries = [];
  restoring = false;
  if (restored.length > 0) {
    useChatStore.setState((s) => ({
      queuedMessages: [
        ...restored,
        ...s.queuedMessages.filter((m) => !restored.some((r) => r.stableId === m.stableId)),
      ],
    }));
  }
  writeQueue(useChatStore.getState().queuedMessages);

  const heldBack = restored.length - auto;
  if (entries.length > 0) {
    console.info(
      `${LOG_PREFIX} restore: stored=${entries.length} restored=${restored.length} auto=${auto} ` +
        `heldBack=${heldBack} otherTab=${otherTab} identityMismatch=${identityMismatch} ownership=${ownership}`,
    );
  }

  if (otherTab > 0) {
    showToast(
      `${plural(otherTab, "queued note stays", "queued notes stay")} in the other tab this one was copied from.`,
    );
    return;
  }
  if (heldBack === 0) return;
  const reasons: string[] = [];
  if (ownership === "no-locks") {
    reasons.push("this browser cannot tell whether another tab already holds them");
  } else {
    if (withFiles > 0)
      reasons.push(
        `${plural(withFiles, "had", "had")} attachments that a reload cannot keep (attach them again)`,
      );
    if (tooOld > 0) reasons.push(`${plural(tooOld, "was", "were")} queued over an hour ago`);
    if (wasRetry > 0) reasons.push(`${plural(wasRetry, "was", "were")} already waiting for Retry`);
  }
  showToast(
    `${plural(restored.length, "queued note came", "queued notes came")} back after the reload. ` +
      `${plural(heldBack, "waits", "wait")} for Retry: ${reasons.join("; ")}.`,
  );
}

/**
 * Mirror the message queue into sessionStorage and, the first time per page, put back what a
 * reload left there. Returns the cleanup for the write subscription; the restore and the tab lock
 * live for the page.
 */
export function installAeQueuePersist(): () => void {
  if (!started) {
    started = true;
    // Read before the write subscription exists, so the first write cannot wipe what is stored.
    const doc = readDoc();
    pendingEntries = doc?.entries ?? [];
    storedUserId = doc?.userId ?? null;
    persistedKeys = new Set(pendingEntries.map(noteKey));
    restoring = true;
    restorePromise = restore().catch((error: unknown) => {
      // Never lose the stored notes to a failed restore: they stay in storage for the next load.
      restoring = false;
      console.warn(`${LOG_PREFIX} restore failed`, error);
    });
  }
  unsubscribe?.();
  const stop = useChatStore.subscribe((state, prev) => {
    if (state.queuedMessages !== prev.queuedMessages) writeQueue(state.queuedMessages);
  });
  unsubscribe = stop;
  return () => {
    stop();
    if (unsubscribe === stop) unsubscribe = null;
  };
}

/** Test helpers: wait for the restore, reset module state, shorten the lock wait. */
export const aeQueuePersistTestHooks = {
  restored: (): Promise<void> => restorePromise,
  isRestoring: (): boolean => restoring,
  reset(opts: { lockWaitMs?: number } = {}): void {
    unsubscribe?.();
    unsubscribe = null;
    for (const release of heldLocks.splice(0)) release();
    started = false;
    restoring = false;
    pendingEntries = [];
    storedUserId = null;
    restorePromise = Promise.resolve();
    lockWaitMs = opts.lockWaitMs ?? AE_QUEUE_LOCK_WAIT_MS;
    warnedCap = false;
    firstSeen.clear();
    persistedKeys = new Set();
  },
};
