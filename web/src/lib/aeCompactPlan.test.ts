import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/store/chatStore";
import {
  AE_COMPACT_PREP_TEXT,
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

  it.each([
    ["a background shell is running", { backgroundTasks: [{ status: "running" }] }],
    ["the chat waits on the user", { sessionStatus: "waiting" }],
    [
      "a message is queued ahead",
      { queuedMessages: [{ queueId: "q1", text: "next", conversationId: ID }] },
    ],
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
});
