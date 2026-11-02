// Queued notes survive a reload (omnigent-ae, 2026-11-01). A message sent while the chat is
// busy waits in the client-side queue (`queuedMessages` in chatStore) until the turn ends. That
// queue lived only in page memory, so a reload, a phone tab discard, the chunk-error auto-reload
// or the "Omnigent was updated" reload during a long turn lost it without a word: on 2026-11-01 a
// note went this way during a 28-minute turn.
//
// This module mirrors the queue into sessionStorage (per tab; it survives a reload and usually a
// tab discard) on every change, and puts it back once per page. A Web Lock named after a per-tab
// id decides who owns the stored copy: a duplicated tab copies sessionStorage, and a copy whose
// lock another tab still holds comes back waiting for Retry, never sent on its own. Restored
// notes flush through the existing queue paths only (the chat page's flush and
// `flushBackgroundQueues`); nothing here sends.
//
// Split view runs each pane as a same-origin frame in the same tab, and those frames share one
// sessionStorage, so a pane keys its storage and its tab id by its frame name (review fix,
// 2026-11-01). Each note records the signed-in user it was queued under; a note is never handed
// to another user and its owner is never rewritten.
//
// Kept out: attachments (File objects cannot be stored; their names come back and the note waits
// for Retry), notes older than an hour (they wait for Retry), and anything across devices.

import { showToast } from "@/components/ui/toast";
import { isAeSplitPane } from "@/lib/aeSplitLayout";
import { getCurrentUserId, resolveIdentity } from "@/lib/identity";
import { randomUUID } from "@/lib/randomUUID";
import { readComposerDraft } from "@/lib/replyDraft";
import { isTempConvId } from "@/lib/tempConversationId";
import { useChatStore, type QueuedMessage } from "@/store/chatStore";

/** sessionStorage key of the stored queue document (a split pane adds `:<frame name>`). */
export const AE_QUEUE_STORAGE_KEY = "omnigent:ae-queued-messages:v1";
/** sessionStorage key of this tab's id (a duplicated tab copies it; a split pane adds its name). */
export const AE_QUEUE_TAB_ID_KEY = "omnigent:ae-queue-tab-id:v1";
/** Web Lock name prefix; the full name is the prefix plus the tab id. */
export const AE_QUEUE_LOCK_PREFIX = "omnigent:ae-queue-owner";
/** How long a restore waits for the tab lock (a reload's dying page frees it almost at once). */
export const AE_QUEUE_LOCK_WAIT_MS = 1000;
/** How long a restore waits for `/v1/me`; past it the identity counts as unverifiable. */
export const AE_QUEUE_IDENTITY_WAIT_MS = 10_000;
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
  /** The signed-in user the note was queued under; null when identity was not known yet. */
  userId: string | null;
}

interface StoredDoc {
  v: number;
  entries: StoredEntry[];
}

// Module state: one restore per page, whatever mounts and unmounts.
let started = false;
let restoring = false;
let docKey = AE_QUEUE_STORAGE_KEY;
let tabIdKey = AE_QUEUE_TAB_ID_KEY;
/** Stored notes not restored yet: every write keeps them until the restore decides. */
let pendingEntries: StoredEntry[] = [];
/** Notes of a user this page cannot verify: written back untouched, never restored. */
let carriedEntries: StoredEntry[] = [];
let unsubscribe: (() => void) | null = null;
let restorePromise: Promise<void> = Promise.resolve();
let lockWaitMs = AE_QUEUE_LOCK_WAIT_MS;
let identityWaitMs = AE_QUEUE_IDENTITY_WAIT_MS;
let warnedCap = false;
const firstSeen = new Map<string, number>();
/** Owner of each restored note, kept as stored so a write never relabels it. */
const restoredOwners = new Map<string, string | null>();
/** Attachment names of restored notes, whose File objects a reload could not keep. */
const lostFileNames = new Map<string, string[]>();
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

/** A split pane's frame name, or null outside a pane (the /split parent included). */
function paneScope(): string | null {
  try {
    return isAeSplitPane() && window.name !== "" ? window.name : null;
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
  const userId = typeof raw.userId === "string" ? raw.userId : null;
  const entry: StoredEntry = { text, conversationId, firstSeenAt, userId };
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
    const raw = storage()?.getItem(docKey);
    if (!raw) return null;
    const doc: unknown = JSON.parse(raw);
    if (!isRecord(doc) || doc.v !== DOC_VERSION || !Array.isArray(doc.entries)) return null;
    const entries: StoredEntry[] = [];
    for (const item of doc.entries) {
      const entry = readEntry(item);
      if (entry !== null) entries.push(entry);
    }
    return { v: DOC_VERSION, entries };
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
  // A note queued in this page belongs to this page's user; a restored one keeps its owner.
  const userId = restoredOwners.has(key) ? restoredOwners.get(key)! : getCurrentUserId();
  const entry: StoredEntry = {
    text: message.text,
    conversationId: message.conversationId,
    firstSeenAt: seen,
    userId,
  };
  if (message.agentId !== undefined) entry.agentId = message.agentId;
  if (message.stableId !== undefined) entry.stableId = message.stableId;
  if (message.command !== undefined) entry.command = message.command;
  if (message.replyDraft !== undefined) entry.replyDraft = message.replyDraft;
  if (message.requiresRetry === true) entry.requiresRetry = true;
  const names = (message.files ?? []).map((f) => f.name);
  const lost = lostFileNames.get(key);
  if (names.length > 0) entry.fileNames = names;
  else if (lost !== undefined) entry.fileNames = lost;
  return entry;
}

/** Write the queue (plus notes still waiting or carried) to storage, now. */
function writeQueue(queue: readonly QueuedMessage[]): void {
  const now = Date.now();
  const live = queue.filter((m) => !isTempConvId(m.conversationId));
  // A note that left the queue gets a fresh first-seen time if it ever comes back.
  const liveKeys = new Set(live.map(noteKey));
  for (const key of firstSeen.keys()) {
    if (!liveKeys.has(key)) firstSeen.delete(key);
  }
  const candidates: StoredEntry[] = [
    ...pendingEntries,
    ...carriedEntries,
    ...live.map((m) => toStored(m, now)),
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
      store.removeItem(docKey);
      return;
    }
    const doc: StoredDoc = { v: DOC_VERSION, entries: kept };
    store.setItem(docKey, JSON.stringify(doc));
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
    const existing = store?.getItem(tabIdKey);
    if (existing) return existing;
    const id = newTabId();
    store?.setItem(tabIdKey, id);
    return id;
  } catch {
    return newTabId();
  }
}

type LockResult = "held" | "timeout" | "error";

/**
 * Hold `name` for the page's lifetime. "timeout" only when this call's own wait ran out (the
 * lock is held elsewhere); any other failure is "error".
 */
function holdTabLock(name: string, waitMs: number | null): Promise<LockResult> {
  return new Promise((settle) => {
    const controller = waitMs === null ? null : new AbortController();
    const timer =
      controller === null || waitMs === null ? null : setTimeout(() => controller.abort(), waitMs);
    try {
      navigator.locks
        .request(name, controller === null ? {} : { signal: controller.signal }, () => {
          if (timer !== null) clearTimeout(timer);
          settle("held");
          return new Promise<void>((release) => {
            heldLocks.push(release);
          });
        })
        .catch((error: unknown) => {
          if (timer !== null) clearTimeout(timer);
          // Only this call's own wait running out means another tab holds the lock (a DOMException
          // is not an Error instance in every runtime, so read its name).
          const timedOut =
            controller?.signal.aborted === true &&
            (error as { name?: unknown } | null)?.name === "AbortError";
          settle(timedOut ? "timeout" : "error");
        });
    } catch {
      if (timer !== null) clearTimeout(timer);
      settle("error");
    }
  });
}

type Ownership = "owned" | "other-tab" | "no-locks";

async function claimOwnership(): Promise<Ownership> {
  if (!webLocksAvailable()) return "no-locks";
  const result = await holdTabLock(`${AE_QUEUE_LOCK_PREFIX}:${readTabId()}`, lockWaitMs);
  if (result === "held") return "owned";
  if (result === "error") return "no-locks";
  // Another live (or frozen) tab holds this id: this tab was copied from it. Take a fresh id so
  // this tab's own notes have an owner from now on.
  const fresh = newTabId();
  try {
    storage()?.setItem(tabIdKey, fresh);
  } catch {
    // Without storage the next reload mints another id; nothing to keep.
  }
  void holdTabLock(`${AE_QUEUE_LOCK_PREFIX}:${fresh}`, null);
  return "other-tab";
}

/** The signed-in user, or null when it cannot be verified (failed, or no answer in time). */
async function currentIdentity(): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // A `/v1/me` that hangs (say right after a deploy) must not hold the restore for the page's life.
  const timeout = new Promise<null>((settle) => {
    timer = setTimeout(() => settle(null), identityWaitMs);
  });
  try {
    return await Promise.race([resolveIdentity(), timeout]);
  } catch {
    return getCurrentUserId();
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

async function restore(): Promise<void> {
  const [ownership, userId] = await Promise.all([claimOwnership(), currentIdentity()]);
  const entries = pendingEntries;

  // Ownership is per note: a note of another user is dropped, a note of a user this page
  // cannot verify is carried untouched, and a note queued before identity was known may come
  // back only as a Retry.
  const usable: StoredEntry[] = [];
  const carried: StoredEntry[] = [];
  let otherUser = 0;
  for (const entry of entries) {
    if (entry.userId !== null && userId === null) carried.push(entry);
    else if (entry.userId !== null && entry.userId !== userId) otherUser += 1;
    else usable.push(entry);
  }

  const now = Date.now();
  const current = useChatStore.getState().queuedMessages;
  const currentIds = new Set(current.map((m) => m.stableId).filter((id) => id !== undefined));
  const restored: QueuedMessage[] = [];
  let auto = 0;
  let withFiles = 0;
  let tooOld = 0;
  let wasRetry = 0;
  let unknownOwner = 0;
  for (const entry of usable) {
    const stableId = entry.stableId ?? randomUUID().replace(/-/g, "");
    if (currentIds.has(stableId)) continue;
    currentIds.add(stableId);
    firstSeen.set(stableId, entry.firstSeenAt);
    restoredOwners.set(stableId, entry.userId);
    if (entry.fileNames !== undefined) lostFileNames.set(stableId, entry.fileNames);
    const hasFiles = (entry.fileNames?.length ?? 0) > 0;
    const old = now - entry.firstSeenAt >= AE_QUEUE_AUTO_SEND_MAX_AGE_MS;
    const ownerUnknown = entry.userId === null && userId !== null;
    const sendsItself =
      ownership === "owned" && !hasFiles && !old && !ownerUnknown && entry.requiresRetry !== true;
    if (sendsItself) auto += 1;
    else if (hasFiles) withFiles += 1;
    else if (old) tooOld += 1;
    else if (ownerUnknown) unknownOwner += 1;
    else if (entry.requiresRetry === true) wasRetry += 1;
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

  // The window is over: from here the store and the carried notes are what gets written.
  pendingEntries = [];
  carriedEntries = carried;
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
        `heldBack=${heldBack} carried=${carried.length} otherUser=${otherUser} ownership=${ownership}`,
    );
  }

  if (carried.length > 0) {
    showToast(
      `${plural(carried.length, "queued note", "queued notes")} from before the reload ` +
        `${carried.length === 1 ? "is" : "are"} waiting until your sign-in is confirmed. ` +
        "Reload the page to bring them back; don't retype them.",
    );
  }
  if (heldBack === 0) return;
  if (ownership === "other-tab") {
    showToast(
      `${plural(restored.length, "queued note came", "queued notes came")} back from before the reload. ` +
        `${restored.length === 1 ? "It" : "They"} may also be waiting in a tab this one was copied from; ` +
        "use Retry only for ones that never arrived.",
    );
    return;
  }
  const reasons: string[] = [];
  if (ownership === "no-locks") {
    reasons.push("this browser cannot tell whether another tab already holds them");
  } else {
    if (withFiles > 0)
      reasons.push(`${withFiles} had attachments that a reload cannot keep (attach them again)`);
    if (tooOld > 0) reasons.push(`${plural(tooOld, "was", "were")} queued over an hour ago`);
    if (wasRetry > 0) reasons.push(`${plural(wasRetry, "was", "were")} already waiting for Retry`);
    if (unknownOwner > 0)
      reasons.push(
        `${plural(unknownOwner, "was", "were")} queued before the signed-in user was known`,
      );
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
    const scope = paneScope();
    docKey = scope === null ? AE_QUEUE_STORAGE_KEY : `${AE_QUEUE_STORAGE_KEY}:${scope}`;
    tabIdKey = scope === null ? AE_QUEUE_TAB_ID_KEY : `${AE_QUEUE_TAB_ID_KEY}:${scope}`;
    // Read before the write subscription exists, so the first write cannot wipe what is stored.
    pendingEntries = readDoc()?.entries ?? [];
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
  reset(opts: { lockWaitMs?: number; identityWaitMs?: number } = {}): void {
    unsubscribe?.();
    unsubscribe = null;
    for (const release of heldLocks.splice(0)) release();
    started = false;
    restoring = false;
    docKey = AE_QUEUE_STORAGE_KEY;
    tabIdKey = AE_QUEUE_TAB_ID_KEY;
    pendingEntries = [];
    carriedEntries = [];
    restorePromise = Promise.resolve();
    lockWaitMs = opts.lockWaitMs ?? AE_QUEUE_LOCK_WAIT_MS;
    identityWaitMs = opts.identityWaitMs ?? AE_QUEUE_IDENTITY_WAIT_MS;
    warnedCap = false;
    firstSeen.clear();
    restoredOwners.clear();
    lostFileNames.clear();
    persistedKeys = new Set();
  },
};
