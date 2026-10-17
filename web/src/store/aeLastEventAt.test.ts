import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aeResetLastEventStamps } from "@/lib/aeSessionActivity";
import {
  bindConversationForTest,
  handleSessionEvent,
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
    close: () => ctrl!.close(),
  };
}

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
const immediate = { schedule: (fn: () => void) => fn(), cancel: () => {} };

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

describe("chat store lastEventAt", () => {
  it("starts empty and stamps each content event, at most once a second", async () => {
    const { set, get } = bindConversationForTest("conv_last_a");
    expect(useChatStore.getState().lastEventAt).toBeNull();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const sink = pushableStream();
    const controller = new AbortController();
    void pumpStreamEvents("conv_last_a", sink.stream, controller, set, get, immediate);

    sink.push("response.output_text.delta", { delta: "Hello", item_id: "m1", output_index: 0 });
    await tick();
    expect(useChatStore.getState().lastEventAt).toBe(1_000_000);

    now.mockReturnValue(1_000_400);
    sink.push("response.output_text.delta", { delta: "hi", item_id: "m1", output_index: 0 });
    await tick();
    expect(useChatStore.getState().lastEventAt).toBe(1_000_000);

    now.mockReturnValue(1_002_000);
    sink.push("response.output_text.delta", { delta: " there", item_id: "m1", output_index: 0 });
    await tick();
    expect(useChatStore.getState().lastEventAt).toBe(1_002_000);
    controller.abort();
  });

  it("keeps each session's own value across a switch", async () => {
    const a = bindConversationForTest("conv_last_b");
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    const sink = pushableStream();
    const controller = new AbortController();
    void pumpStreamEvents("conv_last_b", sink.stream, controller, a.set, a.get, immediate);
    sink.push("response.output_text.delta", { delta: "Hi", item_id: "m2", output_index: 0 });
    await tick();
    expect(useChatStore.getState().lastEventAt).toBe(2_000_000);

    // A fresh session starts with no last event.
    bindConversationForTest("conv_last_c");
    expect(useChatStore.getState().lastEventAt).toBeNull();
    controller.abort();
  });

  it("stamps the moment the user sends, so a send after a long gap never reads as quiet", () => {
    bindConversationForTest("conv_last_send", { lastEventAt: 1000 });
    vi.spyOn(Date, "now").mockReturnValue(9_000_000);
    void useChatStore.getState().send("hello", "agent_xyz");
    expect(useChatStore.getState().lastEventAt).toBe(9_000_000);
  });

  it("forgets an earlier stamp when a rebind hydrates the snapshot", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (/\/stream(\?|$)/.test(url)) return new Response(new ReadableStream());
      if (/\/items(\?|$)/.test(url)) {
        return json({ object: "list", data: [], first_id: null, last_id: null, has_more: false });
      }
      if (/^\/v1\/sessions\/conv_last_rebind(\?|$)/.test(url)) {
        return json({ id: "conv_last_rebind", agent_id: "agent_xyz", status: "running" });
      }
      return json({ queued: true, item_id: "ci_1" });
    });
    vi.stubGlobal("fetch", fetchMock);
    // An entry whose stream is gone: the next send rebinds it.
    bindConversationForTest("conv_last_rebind", {
      lastEventAt: 1000,
      aeProgress: { label: "Crunching", elapsed: "4m 42s", tokens: null },
    });
    vi.spyOn(Date, "now").mockReturnValue(9_000_000);
    const sent = useChatStore.getState().send("hello", "agent_xyz");
    expect(useChatStore.getState().lastEventAt).toBe(9_000_000);
    await sent;
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/items"))).toBe(true),
    );
    // The chat line then dates activity by the snapshot's blocks and the unsent message.
    await vi.waitFor(() => expect(useChatStore.getState().lastEventAt).toBeNull());
    // A spinner line from the earlier visit is stale too.
    expect(useChatStore.getState().aeProgress).toBeNull();
  });
});

describe("chat store aeRunningSince", () => {
  it("records when the session switches to running, not on repeated running edges", () => {
    bindConversationForTest("conv_running_since");
    expect(useChatStore.getState().aeRunningSince).toBeNull();
    const now = vi.spyOn(Date, "now").mockReturnValue(5_000_000);
    const running = {
      type: "session_status",
      conversationId: "conv_running_since",
      status: "running",
    } as const;
    handleSessionEvent(running);
    expect(useChatStore.getState().aeRunningSince).toBe(5_000_000);
    now.mockReturnValue(5_060_000);
    handleSessionEvent(running);
    expect(useChatStore.getState().aeRunningSince).toBe(5_000_000);
    // A check-in wakes it after the turn ended: a new start.
    handleSessionEvent({ ...running, status: "idle" });
    now.mockReturnValue(9_000_000);
    handleSessionEvent(running);
    expect(useChatStore.getState().aeRunningSince).toBe(9_000_000);
  });
});
