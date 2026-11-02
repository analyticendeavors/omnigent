import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Identity from "@/lib/identity";
import { serializeReplyDraft } from "@/lib/replyDraft";
import { useChatStore, type QueuedMessage } from "@/store/chatStore";
import {
  AE_QUEUE_AUTO_SEND_MAX_AGE_MS,
  AE_QUEUE_LOCK_PREFIX,
  AE_QUEUE_MAX_STORED,
  AE_QUEUE_STORAGE_KEY,
  AE_QUEUE_TAB_ID_KEY,
  aeQueuePersistTestHooks as persist,
  installAeQueuePersist,
} from "./aeQueuePersist";

const identity = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof Identity>();
  return {
    ...actual,
    getCurrentUserId: () => identity.userId,
    resolveIdentity: () => Promise.resolve(identity.userId),
  };
});

const CONV = "conv_queue";

/** Web Locks with exclusive named locks, abort signals and an "another tab" hold. */
class FakeLocks {
  held = new Set<string>();
  waiters = new Map<string, (() => void)[]>();

  private grant<T>(name: string, cb: (lock: { name: string }) => T | Promise<T>): Promise<T> {
    this.held.add(name);
    const done = Promise.resolve(cb({ name }));
    void done.finally(() => this.free(name));
    return done;
  }

  private free(name: string): void {
    this.held.delete(name);
    const next = this.waiters.get(name)?.shift();
    next?.();
  }

  request<T>(
    name: string,
    opts: { signal?: AbortSignal },
    cb: (lock: { name: string }) => T | Promise<T>,
  ): Promise<T> {
    if (!this.held.has(name)) return this.grant(name, cb);
    return new Promise<T>((resolve, reject) => {
      const waiter = () => {
        this.grant(name, cb).then(resolve, reject);
      };
      const queue = this.waiters.get(name) ?? [];
      queue.push(waiter);
      this.waiters.set(name, queue);
      opts.signal?.addEventListener("abort", () => {
        const at = queue.indexOf(waiter);
        if (at !== -1) queue.splice(at, 1);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }

  /** Another tab holds `name` until the returned release runs. */
  holdElsewhere(name: string): () => void {
    this.held.add(name);
    return () => this.free(name);
  }
}

let locks: FakeLocks;
let send: ReturnType<typeof vi.fn>;
const toasts: string[] = [];
const listen = (event: Event) => toasts.push(String((event as CustomEvent).detail.content));

function setLocks(value: FakeLocks | undefined) {
  Object.defineProperty(navigator, "locks", { value, configurable: true });
}

function setChat(patch: Record<string, unknown> = {}) {
  useChatStore.setState({
    conversationId: CONV,
    boundAgentId: "agent_1",
    status: "idle",
    // Running, so an enqueue does not flush on the spot.
    sessionStatus: "running",
    queuedMessages: [],
    ...patch,
  } as never);
}

function stored(): Record<string, unknown>[] {
  const raw = sessionStorage.getItem(AE_QUEUE_STORAGE_KEY);
  if (raw === null) return [];
  return (JSON.parse(raw) as { entries: Record<string, unknown>[] }).entries;
}

function entry(text: string, extra: Record<string, unknown> = {}) {
  return {
    text,
    conversationId: CONV,
    agentId: "agent_1",
    stableId: `sid_${text}`,
    firstSeenAt: Date.now(),
    ...extra,
  };
}

function seed(entries: unknown[], extra: Record<string, unknown> = {}) {
  sessionStorage.setItem(
    AE_QUEUE_STORAGE_KEY,
    JSON.stringify({ v: 1, userId: null, entries, ...extra }),
  );
}

const queue = (): QueuedMessage[] => useChatStore.getState().queuedMessages;

async function install() {
  const stop = installAeQueuePersist();
  await persist.restored();
  return stop;
}

beforeEach(() => {
  sessionStorage.clear();
  persist.reset({ lockWaitMs: 20 });
  identity.userId = null;
  locks = new FakeLocks();
  setLocks(locks);
  toasts.length = 0;
  window.addEventListener("omnigent:toast", listen);
  send = vi.fn(() => Promise.resolve());
  useChatStore.setState({ send } as never);
  setChat();
});

afterEach(() => {
  persist.reset();
  window.removeEventListener("omnigent:toast", listen);
  vi.restoreAllMocks();
  setLocks(undefined);
});

describe("writes", () => {
  it("enqueue, dequeue, reorder and clear each update storage", async () => {
    await install();
    const s = useChatStore.getState();
    s.enqueueMessage("one");
    s.enqueueMessage("two");
    s.enqueueMessage("three");
    expect(stored().map((e) => e.text)).toEqual(["one", "two", "three"]);
    const [one, two, three] = queue();
    useChatStore.getState().reorderQueuedMessage(three!.queueId, one!.queueId);
    expect(stored().map((e) => e.text)).toEqual(["three", "one", "two"]);
    useChatStore.getState().dequeueMessage(two!.queueId);
    expect(stored().map((e) => e.text)).toEqual(["three", "one"]);
    useChatStore.getState().clearQueuedMessages(CONV);
    expect(sessionStorage.getItem(AE_QUEUE_STORAGE_KEY)).toBeNull();
  });

  it("stores every field but the files, whose names are kept", async () => {
    await install();
    const file = new File(["x"], "notes.txt", { type: "text/plain" });
    useChatStore.getState().enqueueMessage("with file", [file]);
    const [saved] = stored();
    const [live] = queue();
    expect(saved).toMatchObject({
      text: "with file",
      conversationId: CONV,
      agentId: "agent_1",
      stableId: live!.stableId,
      fileNames: ["notes.txt"],
    });
    expect(saved).not.toHaveProperty("files");
    expect(typeof saved!.firstSeenAt).toBe("number");
  });

  it("swallows a quota error", async () => {
    await install();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => useChatStore.getState().enqueueMessage("one")).not.toThrow();
    expect(queue()).toHaveLength(1);
  });

  it("does not store notes for a temp conversation", async () => {
    await install();
    setChat({ conversationId: "temp:abc" });
    useChatStore.getState().enqueueMessage("temp note");
    expect(queue()).toHaveLength(1);
    expect(stored()).toEqual([]);
  });

  it("past the cap keeps every stored note and stops storing new ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seed(Array.from({ length: AE_QUEUE_MAX_STORED }, (_, i) => entry(`n${i}`)));
    await install();
    expect(stored()).toHaveLength(AE_QUEUE_MAX_STORED);
    useChatStore.getState().enqueueMessage("extra");
    useChatStore.getState().enqueueMessage("extra2");
    expect(queue()).toHaveLength(AE_QUEUE_MAX_STORED + 2);
    expect(stored()).toHaveLength(AE_QUEUE_MAX_STORED);
    expect(stored().map((e) => e.text)).toEqual(
      Array.from({ length: AE_QUEUE_MAX_STORED }, (_, i) => `n${i}`),
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("restore", () => {
  it("restores nothing and throws nothing for malformed or wrong-version storage", async () => {
    sessionStorage.setItem(AE_QUEUE_STORAGE_KEY, "{not json");
    await expect(install()).resolves.toBeTypeOf("function");
    expect(queue()).toEqual([]);

    persist.reset({ lockWaitMs: 20 });
    seed([entry("a")], { v: 2 });
    await install();
    expect(queue()).toEqual([]);

    persist.reset({ lockWaitMs: 20 });
    sessionStorage.setItem(AE_QUEUE_STORAGE_KEY, JSON.stringify({ v: 1, entries: [42, null] }));
    await install();
    expect(queue()).toEqual([]);
  });

  it("restores in stored order ahead of current notes, keyed by stable id", async () => {
    seed([entry("a"), entry("b")]);
    setChat({
      queuedMessages: [
        { queueId: "q_9", text: "live", conversationId: CONV, stableId: "sid_live" },
      ],
    });
    await install();
    expect(queue().map((m) => [m.queueId, m.text, m.stableId, m.requiresRetry])).toEqual([
      ["q_ae_sid_a", "a", "sid_a", undefined],
      ["q_ae_sid_b", "b", "sid_b", undefined],
      ["q_9", "live", "sid_live", undefined],
    ]);
    expect(toasts).toEqual([]);
  });

  it("mints a stable id for a stored note without one", async () => {
    seed([{ text: "old", conversationId: CONV, firstSeenAt: Date.now() }]);
    await install();
    const [m] = queue();
    expect(m!.stableId).toMatch(/^[0-9a-f]{32}$/);
    expect(m!.queueId).toBe(`q_ae_${m!.stableId}`);
  });

  it("keeps a reply draft through a reload", async () => {
    const draft = { quotes: [{ before: "", text: "quoted" }], text: "answer" };
    const text = serializeReplyDraft(draft);
    await install();
    useChatStore.getState().enqueueMessage(text, undefined, { version: 1, ...draft });
    persist.reset({ lockWaitMs: 20 });
    setChat();
    await install();
    expect(queue()[0]?.replyDraft).toEqual({ version: 1, ...draft });
  });

  it("restores once when installed twice", async () => {
    seed([entry("a")]);
    const stop = await install();
    stop();
    await install();
    expect(queue().map((m) => m.text)).toEqual(["a"]);
  });

  it("keeps the stored notes in every write during the lock wait", async () => {
    seed([entry("a")]);
    sessionStorage.setItem(AE_QUEUE_TAB_ID_KEY, "tab1");
    const release = locks.holdElsewhere(`${AE_QUEUE_LOCK_PREFIX}:tab1`);
    persist.reset({ lockWaitMs: 1000 });
    installAeQueuePersist();
    expect(persist.isRestoring()).toBe(true);
    useChatStore.getState().enqueueMessage("new");
    expect(stored().map((e) => e.text)).toEqual(["a", "new"]);
    useChatStore.getState().clearQueuedMessages(CONV);
    expect(stored().map((e) => e.text)).toEqual(["a"]);
    // The dying page lets go: this tab owns the notes.
    release();
    await persist.restored();
    expect(queue().map((m) => m.text)).toEqual(["a"]);
    expect(stored().map((e) => e.text)).toEqual(["a"]);
  });

  it("auto-sends a fresh text note and holds back old, attached and lockless ones", async () => {
    const now = Date.now();
    seed([
      entry("fresh"),
      entry("old", { firstSeenAt: now - AE_QUEUE_AUTO_SEND_MAX_AGE_MS - 1 }),
      entry("file", { fileNames: ["a.png"] }),
    ]);
    await install();
    expect(queue().map((m) => [m.text, m.requiresRetry])).toEqual([
      ["fresh", undefined],
      ["old", true],
      ["file", true],
    ]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("3 queued notes came back");
    expect(toasts[0]).toContain("2 wait for Retry");
    expect(toasts[0]).toContain("attachments");
    expect(toasts[0]).toContain("over an hour ago");
  });

  it("holds every note back when the browser has no Web Locks", async () => {
    setLocks(undefined);
    seed([entry("a")]);
    await install();
    expect(queue().map((m) => [m.text, m.requiresRetry])).toEqual([["a", true]]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("another tab");
  });

  it("leaves notes owned by another tab there, clears this copy and takes a new tab id", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    seed([entry("a"), entry("b")]);
    sessionStorage.setItem(AE_QUEUE_TAB_ID_KEY, "tab1");
    locks.holdElsewhere(`${AE_QUEUE_LOCK_PREFIX}:tab1`);
    await install();
    expect(queue()).toEqual([]);
    expect(sessionStorage.getItem(AE_QUEUE_STORAGE_KEY)).toBeNull();
    const tabId = sessionStorage.getItem(AE_QUEUE_TAB_ID_KEY);
    expect(tabId).not.toBe("tab1");
    expect(locks.held.has(`${AE_QUEUE_LOCK_PREFIX}:${tabId}`)).toBe(true);
    expect(toasts).toEqual(["2 queued notes stay in the other tab this one was copied from."]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("otherTab=2"));
  });

  it("drops notes stored for another signed-in user", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    identity.userId = "bob";
    seed([entry("a")], { userId: "alice" });
    await install();
    expect(queue()).toEqual([]);
  });

  it("keeps firstSeenAt through a restore and later writes", async () => {
    const first = Date.now() - 5 * 60_000;
    seed([entry("a", { firstSeenAt: first })]);
    await install();
    expect(stored()[0]!.firstSeenAt).toBe(first);
    useChatStore.getState().enqueueMessage("b");
    expect(stored()[0]!.firstSeenAt).toBe(first);
    const second = stored()[1]!.firstSeenAt;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
    useChatStore.getState().enqueueMessage("c");
    expect(
      stored()
        .map((e) => e.firstSeenAt)
        .slice(0, 2),
    ).toEqual([first, second]);
  });

  it("a restored note waits for the agent, then flushes once with its stable id", async () => {
    seed([entry("a")]);
    setChat({ boundAgentId: null, sessionStatus: "idle" });
    await install();
    useChatStore.getState().maybeFlushQueuedHead();
    expect(send).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(1);

    useChatStore.setState({ boundAgentId: "agent_1" } as never);
    useChatStore.getState().maybeFlushQueuedHead();
    useChatStore.getState().maybeFlushQueuedHead();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      "a",
      "agent_1",
      undefined,
      expect.objectContaining({ stableId: "sid_a", pinnedConversationId: CONV }),
    );
    expect(queue()).toEqual([]);
    expect(sessionStorage.getItem(AE_QUEUE_STORAGE_KEY)).toBeNull();
  });
});
