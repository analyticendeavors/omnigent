import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionEvent, useChatStore } from "@/store/chatStore";
import {
  AE_COMPACT_PREP_TEXT,
  AE_COMPACT_PREP_LIMIT_MS,
  AE_COMPACT_START_LIMIT_MS,
  cancelAeCompactPlan,
  resetAeCompactPlans,
  startAeCompactPlan,
} from "./aeCompactPlan";

const ID = "conv_plan";

function setChat(patch: Record<string, unknown> = {}) {
  useChatStore.setState({
    conversationId: ID,
    boundAgentId: "agent_1",
    status: "idle",
    sessionStatus: "idle",
    backgroundTasks: [],
    backgroundTaskCount: 0,
    blocks: [],
    queuedMessages: [],
    ...patch,
  } as never);
}

const toasts: string[] = [];
const listen = (event: Event) => toasts.push(String((event as CustomEvent).detail.content));

let send: ReturnType<typeof vi.fn>;
let compact: ReturnType<typeof vi.fn>;

async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  toasts.length = 0;
  window.addEventListener("omnigent:toast", listen);
  // A real turn flips the session to running as soon as the message lands.
  send = vi.fn(() => {
    setChat({ sessionStatus: "running" });
    return Promise.resolve();
  });
  compact = vi.fn(() => Promise.resolve());
  useChatStore.setState({ send, compact } as never);
  setChat();
});

afterEach(() => {
  resetAeCompactPlans();
  window.removeEventListener("omnigent:toast", listen);
  vi.useRealTimers();
});

describe("queued compact", () => {
  it("asks the chat to save its notes at a safe point, then compacts when that turn ends", async () => {
    const done = vi.fn();
    startAeCompactPlan(ID, done);
    expect(send).not.toHaveBeenCalled();
    await tick(2000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(AE_COMPACT_PREP_TEXT);
    expect(send.mock.calls[0]![1]).toBe("agent_1");
    expect(compact).not.toHaveBeenCalled();
    // The prepare turn ends.
    setChat({ sessionStatus: "idle" });
    await tick(2000);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("waits out a running turn and only counts quiet time from its end", async () => {
    setChat({ status: "streaming", sessionStatus: "running" });
    startAeCompactPlan(ID);
    await tick(10_000);
    expect(send).not.toHaveBeenCalled();
    setChat();
    await tick(1500);
    // Busy again before the quiet period ran out: the clock restarts.
    setChat({ sessionStatus: "running" });
    setChat();
    await tick(1500);
    expect(send).not.toHaveBeenCalled();
    await tick(500);
    expect(send).toHaveBeenCalledTimes(1);
  });

  // Background shells outlive turns and survive /compact, and `waiting` is the turn end a
  // claude-native chat publishes while one still runs: none of them holds a compact back.
  it.each([
    ["a background shell is running", { backgroundTasks: [{ status: "running" }] }],
    ["an older runner reports only a shell count", { backgroundTaskCount: 1 }],
    ["the turn ended with a shell still running", { sessionStatus: "waiting" }],
  ])("is a safe point while %s", async (_name, patch) => {
    setChat(patch);
    startAeCompactPlan(ID);
    await tick(1999);
    expect(send).not.toHaveBeenCalled();
    await tick(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a message is queued ahead",
      { queuedMessages: [{ queueId: "q1", text: "next", conversationId: ID }] },
    ],
    ["the session is launching", { sessionStatus: "launching" }],
  ])("is not a safe point while %s", async (_name, patch) => {
    setChat(patch);
    startAeCompactPlan(ID);
    await tick(10_000);
    expect(send).not.toHaveBeenCalled();
    setChat();
    await tick(2000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("queues one compact per chat", async () => {
    startAeCompactPlan(ID);
    startAeCompactPlan(ID);
    await tick(2000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("cancels cleanly before the safe point", async () => {
    startAeCompactPlan(ID);
    cancelAeCompactPlan(ID);
    await tick(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
  });

  it("cancels while the chat is saving its notes, and never compacts", async () => {
    startAeCompactPlan(ID);
    await tick(2000);
    cancelAeCompactPlan(ID);
    setChat({ sessionStatus: "idle" });
    await tick(10_000);
    expect(compact).not.toHaveBeenCalled();
  });

  it("drops the plan, with a toast, when the user leaves the chat", async () => {
    startAeCompactPlan(ID);
    setChat({ conversationId: "conv_other" });
    await tick(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(toasts.join("\n")).toContain("you left the chat");
  });

  it("compacts nothing when the prepare turn never starts", async () => {
    send.mockImplementation(() => Promise.resolve());
    startAeCompactPlan(ID);
    await tick(2000);
    expect(send).toHaveBeenCalledTimes(1);
    await tick(AE_COMPACT_START_LIMIT_MS + 4000);
    expect(compact).not.toHaveBeenCalled();
    expect(toasts.join("\n")).toContain("never started saving its notes");
  });

  it("compacts nothing when the prepare message cannot be sent", async () => {
    send.mockImplementation(() => Promise.reject(new Error("503 Unavailable")));
    startAeCompactPlan(ID);
    await tick(2000);
    expect(compact).not.toHaveBeenCalled();
    expect(toasts.join("\n")).toContain("503 Unavailable");
  });

  it("compacts nothing when the chat has no agent to ask", async () => {
    setChat({ boundAgentId: null });
    startAeCompactPlan(ID);
    await tick(2000);
    expect(send).not.toHaveBeenCalled();
    expect(toasts.join("\n")).toContain("no agent");
  });

  it("says what failed when the compact is refused, and does not call the after hook", async () => {
    compact.mockImplementation(() => Promise.reject(new Error("409 Conflict")));
    const done = vi.fn();
    startAeCompactPlan(ID, done);
    await tick(2000);
    setChat({ sessionStatus: "idle" });
    await tick(2000);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    expect(toasts.join("\n")).toContain("Could not compact the session (409 Conflict)");
  });
  it("does not count a send-latch blip or a background shell as the prepare turn", async () => {
    // Busy states other than the server reporting the session running prove nothing.
    send.mockImplementation(() => {
      setChat({ status: "streaming" });
      setChat({ status: "idle", backgroundTasks: [{ status: "running" }] });
      setChat();
      return Promise.resolve();
    });
    startAeCompactPlan(ID);
    await tick(2000);
    await tick(AE_COMPACT_START_LIMIT_MS + 4000);
    expect(compact).not.toHaveBeenCalled();
    expect(toasts.join("\n")).toContain("never started saving its notes");
  });

  it("gives up when the prepare turn runs past the limit", async () => {
    startAeCompactPlan(ID);
    await tick(2000);
    // Running, and it never ends.
    await tick(AE_COMPACT_PREP_LIMIT_MS + 1000);
    expect(compact).not.toHaveBeenCalled();
    expect(toasts.join("\n")).toContain("took too long");
  });

  it("waits for a message the user sends during the prepare turn", async () => {
    startAeCompactPlan(ID);
    await tick(2000);
    setChat({
      sessionStatus: "idle",
      queuedMessages: [{ queueId: "q1", text: "also this", conversationId: ID }],
    });
    await tick(5000);
    expect(compact).not.toHaveBeenCalled();
    setChat({ sessionStatus: "running", queuedMessages: [] });
    setChat({ sessionStatus: "idle" });
    await tick(2000);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("cannot be cancelled once the compact event is going out", async () => {
    let finishCompact: () => void = () => {};
    compact.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCompact = resolve;
        }),
    );
    const done = vi.fn();
    startAeCompactPlan(ID, done);
    await tick(2000);
    setChat({ sessionStatus: "idle" });
    await tick(2000);
    expect(compact).toHaveBeenCalledTimes(1);
    cancelAeCompactPlan(ID);
    finishCompact();
    await tick(0);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      "the turn ended failed",
      [{ type: "response_end", status: "failed", ctx: { responseId: "r2" } }],
    ],
    [
      "the turn was cancelled",
      [{ type: "response_end", status: "cancelled", ctx: { responseId: "r2" } }],
    ],
    [
      "the turn raised an error",
      [{ type: "error", level: "error", message: "boom", ctx: { responseId: "" } }],
    ],
  ])("compacts nothing when %s", async (_name, blocks) => {
    startAeCompactPlan(ID);
    await tick(2000);
    setChat({ sessionStatus: "idle", blocks });
    await tick(2000);
    expect(compact).not.toHaveBeenCalled();
    expect(toasts.join("\n")).toContain("did not finish saving its notes cleanly");
  });

  it("still compacts after a clean finish, and ignores history that was there before the send", async () => {
    const old = { type: "response_end", status: "failed", ctx: { responseId: "r1" } };
    setChat({ blocks: [old] });
    startAeCompactPlan(ID);
    await tick(2000);
    setChat({
      sessionStatus: "idle",
      blocks: [
        // Rehydrated copy of the old block: a new object, the same response.
        { ...old },
        { type: "response_end", status: "completed", ctx: { responseId: "r2" } },
        { type: "error", level: "info", message: "note", ctx: { responseId: "r2" } },
      ],
    });
    await tick(2000);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("still sees a failure when the transcript is replaced by a shorter one mid-turn", async () => {
    setChat({
      blocks: [
        { type: "user_message", ctx: { responseId: "r0" } },
        { type: "user_message", ctx: { responseId: "r0" } },
        { type: "user_message", ctx: { responseId: "r1" } },
      ],
    });
    startAeCompactPlan(ID);
    await tick(2000);
    setChat({
      sessionStatus: "idle",
      blocks: [{ type: "response_end", status: "failed", ctx: { responseId: "r2" } }],
    });
    await tick(2000);
    expect(compact).not.toHaveBeenCalled();
  });

  it("judges only what follows the prepare message when it is in the transcript", async () => {
    startAeCompactPlan(ID);
    await tick(2000);
    const prep = {
      type: "user_message",
      content: [{ type: "input_text", text: AE_COMPACT_PREP_TEXT }],
      ctx: { responseId: "" },
    };
    // An old non-info error with an empty id, rehydrated as a new object, is history, not this turn.
    setChat({
      sessionStatus: "idle",
      blocks: [{ type: "error", level: "error", message: "old", ctx: { responseId: "" } }, prep],
    });
    await tick(2000);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("catches a failure that carries a reused response id once it follows the prepare message", async () => {
    setChat({ blocks: [{ type: "user_message", content: [], ctx: { responseId: "r1" } }] });
    startAeCompactPlan(ID);
    await tick(2000);
    const prep = {
      type: "user_message",
      content: [{ type: "input_text", text: AE_COMPACT_PREP_TEXT }],
      ctx: { responseId: "r1" },
    };
    setChat({
      sessionStatus: "idle",
      blocks: [prep, { type: "response_end", status: "failed", ctx: { responseId: "r1" } }],
    });
    await tick(2000);
    expect(compact).not.toHaveBeenCalled();
  });

  it("runs after a claude-native turn ends with a background shell still running", async () => {
    // Driven through the real store reducer with the event shapes a claude-native chat sends.
    const status = (value: string, extra: Record<string, unknown> = {}) =>
      handleSessionEvent({
        type: "session_status",
        conversationId: ID,
        status: value,
        ...extra,
      } as never);
    send.mockImplementation(() => Promise.resolve());
    useChatStore.setState({ activeResponse: null } as never);
    status("running", { responseId: "r1" });
    startAeCompactPlan(ID);
    await tick(10_000);
    expect(send).not.toHaveBeenCalled();
    // Stop hook: the turn ended, a shell (a CI wait) still runs. Then the bare PTY idle edge,
    // which leaves the shell tally sticky.
    status("waiting", { responseId: "r1", backgroundTaskCount: 1 });
    status("idle");
    expect(useChatStore.getState().backgroundTaskCount).toBe(1);
    await tick(2000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(AE_COMPACT_PREP_TEXT);
    // The prepare turn runs and ends with the shell still running.
    status("running", { responseId: "r2" });
    await tick(5000);
    expect(compact).not.toHaveBeenCalled();
    status("waiting", { responseId: "r2", backgroundTaskCount: 1 });
    await tick(2000);
    expect(compact).toHaveBeenCalledTimes(1);
  });
});
