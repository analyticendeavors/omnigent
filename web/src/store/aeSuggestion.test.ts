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

function bindPumped(conversationId: string, sessionStatus: "running" | "idle" = "idle") {
  const { set, get } = bindConversationForTest(conversationId, { sessionStatus });
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

describe("chat store aeSuggestion", () => {
  it("keeps the latest suggestion after a turn and clears it when the next turn starts", async () => {
    const { sink, controller } = bindPumped("conv_sug_a");
    expect(useChatStore.getState().aeSuggestion).toBeNull();

    sink.push("session.suggestion", { conversation_id: "conv_sug_a", suggestion: "Open a PR" });
    await tick();
    expect(useChatStore.getState().aeSuggestion).toBe("Open a PR");

    sink.push("session.status", { conversation_id: "conv_sug_a", status: "running" });
    await tick();
    expect(useChatStore.getState().aeSuggestion).toBeNull();
    controller.abort();
  });

  it("drops a suggestion that lands while a turn runs, and another session's", async () => {
    const { sink, controller } = bindPumped("conv_sug_b", "running");
    sink.push("session.suggestion", { conversation_id: "conv_sug_b", suggestion: "stale" });
    sink.push("session.suggestion", { conversation_id: "conv_other", suggestion: "not mine" });
    await tick();
    expect(useChatStore.getState().aeSuggestion).toBeNull();
    controller.abort();
  });

  it("a null suggestion clears it, and nothing carries over to another conversation", async () => {
    const { sink, controller } = bindPumped("conv_sug_c");
    sink.push("session.suggestion", { conversation_id: "conv_sug_c", suggestion: "Ship it" });
    await tick();
    expect(useChatStore.getState().aeSuggestion).toBe("Ship it");
    sink.push("session.suggestion", { conversation_id: "conv_sug_c", suggestion: null });
    await tick();
    expect(useChatStore.getState().aeSuggestion).toBeNull();

    sink.push("session.suggestion", { conversation_id: "conv_sug_c", suggestion: "Again" });
    await tick();
    bindConversationForTest("conv_sug_d");
    expect(useChatStore.getState().aeSuggestion).toBeNull();
    controller.abort();
  });
});
