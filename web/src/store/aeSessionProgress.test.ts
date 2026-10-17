import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aeResetLastEventStamps } from "@/lib/aeSessionActivity";
import {
  bindConversationForTest,
  initChatStore,
  pumpStreamEvents,
  useChatStore,
} from "./chatStore";
import { conversationRegistry } from "./conversationRegistry";

function pushableStream() {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    stream,
    push: (event: string, data: Record<string, unknown>) =>
      ctrl!.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
  };
}

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
const immediate = { schedule: (fn: () => void) => fn(), cancel: () => {} };

const CRUNCHING = { label: "Crunching", elapsed: "4m 42s", tokens: "24.5k tokens" };

function bindPumped(conversationId: string) {
  const { set, get } = bindConversationForTest(conversationId, { sessionStatus: "running" });
  const sink = pushableStream();
  const controller = new AbortController();
  void pumpStreamEvents(conversationId, sink.stream, controller, set, get, immediate);
  return { sink, controller };
}

beforeEach(() => {
  initChatStore(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  aeResetLastEventStamps();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })),
  );
});

afterEach(() => {
  conversationRegistry.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("chat store aeProgress", () => {
  it("keeps the latest spinner line and drops it on a clear", async () => {
    const { sink, controller } = bindPumped("conv_prog_a");
    expect(useChatStore.getState().aeProgress).toBeNull();

    sink.push("session.progress", { conversation_id: "conv_prog_a", ...CRUNCHING });
    await tick();
    expect(useChatStore.getState().aeProgress).toEqual(CRUNCHING);

    sink.push("session.progress", {
      conversation_id: "conv_prog_a",
      label: "Crunching",
      elapsed: "4m 44s",
      tokens: null,
    });
    await tick();
    expect(useChatStore.getState().aeProgress).toEqual({
      label: "Crunching",
      elapsed: "4m 44s",
      tokens: null,
    });

    sink.push("session.progress", { conversation_id: "conv_prog_a", label: null });
    await tick();
    expect(useChatStore.getState().aeProgress).toBeNull();
    controller.abort();
  });

  it("clears when a new item lands", async () => {
    const { sink, controller } = bindPumped("conv_prog_b");
    sink.push("session.progress", { conversation_id: "conv_prog_b", ...CRUNCHING });
    await tick();
    expect(useChatStore.getState().aeProgress).toEqual(CRUNCHING);

    sink.push("response.output_item.done", {
      item: {
        type: "function_call",
        id: "fc_1",
        response_id: "resp_1",
        name: "Write",
        arguments: "{}",
        call_id: "call_1",
        status: "completed",
      },
    });
    await tick();
    expect(useChatStore.getState().aeProgress).toBeNull();
    controller.abort();
  });

  it("clears when the session goes idle, and ignores another session's line", async () => {
    const { sink, controller } = bindPumped("conv_prog_c");
    sink.push("session.progress", { conversation_id: "conv_other", ...CRUNCHING });
    await tick();
    expect(useChatStore.getState().aeProgress).toBeNull();

    sink.push("session.progress", { conversation_id: "conv_prog_c", ...CRUNCHING });
    await tick();
    expect(useChatStore.getState().aeProgress).toEqual(CRUNCHING);

    sink.push("session.status", { conversation_id: "conv_prog_c", status: "idle" });
    await tick();
    expect(useChatStore.getState().aeProgress).toBeNull();
    controller.abort();
  });

  it("does not carry a line over to another conversation", async () => {
    const { sink, controller } = bindPumped("conv_prog_d");
    sink.push("session.progress", { conversation_id: "conv_prog_d", ...CRUNCHING });
    await tick();
    expect(useChatStore.getState().aeProgress).toEqual(CRUNCHING);

    bindConversationForTest("conv_prog_e");
    expect(useChatStore.getState().aeProgress).toBeNull();
    controller.abort();
  });
});

describe("chat store lastEventAt counts content only", () => {
  it("ignores status, model and progress events", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { sink, controller } = bindPumped("conv_prog_f");

    sink.push("session.status", { conversation_id: "conv_prog_f", status: "running" });
    sink.push("session.model", { conversation_id: "conv_prog_f", model: "claude-opus-5-5" });
    sink.push("session.progress", { conversation_id: "conv_prog_f", ...CRUNCHING });
    await tick();
    expect(useChatStore.getState().lastEventAt).toBeNull();

    now.mockReturnValue(1_005_000);
    sink.push("response.output_item.done", {
      item: {
        type: "message",
        id: "msg_1",
        response_id: "resp_1",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      },
    });
    await tick();
    expect(useChatStore.getState().lastEventAt).toBe(1_005_000);

    now.mockReturnValue(1_009_000);
    sink.push("session.progress", { conversation_id: "conv_prog_f", ...CRUNCHING });
    await tick();
    expect(useChatStore.getState().lastEventAt).toBe(1_005_000);
    controller.abort();
  });
});
