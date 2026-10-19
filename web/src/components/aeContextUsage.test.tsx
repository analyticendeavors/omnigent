import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/identity";
import { useChatStore } from "@/store/chatStore";
import {
  AE_CONTEXT_RETRY_DELAYS_MS,
  AE_CONTEXT_SNAPSHOT_TTL_MS,
  aeContextIdentity,
  resetAeContextSnapshots,
  useAeContextSnapshot,
} from "./aeContextUsage";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

const ok = (body: Record<string, unknown> = { available: true }) =>
  Promise.resolve(new Response(JSON.stringify({ observedAt: "2026-10-17T12:00:00Z", ...body })));

const identity = aeContextIdentity("claude-native", "claude-opus-5-5");

function useTwo(enabled: boolean, session = "conv_a") {
  return {
    rail: useAeContextSnapshot(session, { enabled, identity }),
    popover: useAeContextSnapshot(session, { enabled, identity }),
  };
}

beforeEach(() => {
  resetAeContextSnapshots();
  vi.mocked(authenticatedFetch).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("shared context snapshot", () => {
  it("fetches nothing until a subscriber is enabled, then once for every subscriber", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => ok());
    const { result, rerender } = renderHook(({ on }) => useTwo(on), {
      initialProps: { on: false },
    });
    expect(authenticatedFetch).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(result.current.rail.data?.available).toBe(true));
    expect(result.current.popover.data).toBe(result.current.rail.data);
    expect(result.current.rail.fresh).toBe(true);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(authenticatedFetch).toHaveBeenCalledWith("/v1/sessions/conv_a/context-usage");
  });

  it("keys by session and identity, and skips draft sessions", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => ok());
    renderHook(() => useAeContextSnapshot("conv_a", { enabled: true, identity }));
    renderHook(() =>
      useAeContextSnapshot("conv_a", { enabled: true, identity: aeContextIdentity("x", "y") }),
    );
    renderHook(() => useAeContextSnapshot(null, { enabled: true, identity }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
  });

  it("reuses a snapshot for three minutes, then fetches again on the next open", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => ok());
    const first = renderHook(() => useAeContextSnapshot("conv_a", { enabled: true, identity }));
    await waitFor(() => expect(first.result.current.data).toBeDefined());
    first.unmount();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start + AE_CONTEXT_SNAPSHOT_TTL_MS - 1000);
    const second = renderHook(() => useAeContextSnapshot("conv_a", { enabled: true, identity }));
    // The cached one shows at once, with no second request.
    expect(second.result.current.data?.available).toBe(true);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    second.unmount();
    clock.mockReturnValue(start + AE_CONTEXT_SNAPSHOT_TTL_MS + 1000);
    renderHook(() => useAeContextSnapshot("conv_a", { enabled: true, identity }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
  });

  it("refreshes every three minutes while a subscriber stays enabled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.mocked(authenticatedFetch).mockImplementation(() => ok());
    const { unmount } = renderHook(() =>
      useAeContextSnapshot("conv_a", { enabled: true, identity }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AE_CONTEXT_SNAPSHOT_TTL_MS - 1000);
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AE_CONTEXT_SNAPSHOT_TTL_MS * 3);
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  });

  it("reports an error per key and clears it on the next success", async () => {
    vi.mocked(authenticatedFetch)
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(() => ok({ available: false, offline: true, reason: "Offline" }));
    const { result } = renderHook(() => useTwo(true));
    await waitFor(() => expect(result.current.rail.error).toMatch(/HTTP 503/));
    expect(result.current.popover.error).toBe(result.current.rail.error);
    expect(result.current.rail.loading).toBe(false);
    act(() => result.current.popover.refresh());
    await waitFor(() => expect(result.current.rail.data?.reason).toBe("Offline"));
    expect(result.current.rail.error).toBeUndefined();
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  });

  it("refresh asks again at once but never doubles a request in flight", async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(authenticatedFetch)
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      )
      .mockImplementation(() => ok());
    const { result } = renderHook(() => useTwo(true));
    expect(result.current.rail.loading).toBe(true);
    act(() => result.current.rail.refresh());
    act(() => result.current.popover.refresh());
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(new Response(JSON.stringify({ available: true, observedAt: "x" })));
    });
    // The refreshes made in flight become one follow-up read, never a parallel one.
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.rail.loading).toBe(false));
    act(() => result.current.rail.refresh());
    expect(result.current.popover.loading).toBe(true);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(3));
  });

  it("keeps the entry it just created when more than twenty sessions were watched", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => ok());
    for (let n = 0; n < 22; n += 1) {
      renderHook(() => useAeContextSnapshot(`conv_${n}`, { enabled: false, identity }));
    }
    const { result } = renderHook(() =>
      useAeContextSnapshot("conv_last", { enabled: true, identity }),
    );
    await waitFor(() => expect(result.current.data?.available).toBe(true));
  });
});

const PENDING = { available: false, pending: true, reason: "Claude is starting." };

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("while Claude starts", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    cleanup();
    useChatStore.setState({ conversationId: null, sessionStatus: "idle" });
  });

  it("retries a pending answer quietly and never caches it as fresh", async () => {
    vi.mocked(authenticatedFetch)
      .mockImplementationOnce(() => ok(PENDING))
      .mockImplementationOnce(() => ok(PENDING))
      .mockImplementation(() => ok());
    const { result, unmount } = renderHook(() =>
      useAeContextSnapshot("conv_a", { enabled: true, identity }),
    );
    await advance(0);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(true);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeUndefined();
    expect(result.current.fresh).toBe(false);
    await advance(AE_CONTEXT_RETRY_DELAYS_MS[0]);
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(result.current.pending).toBe(true);
    await advance(AE_CONTEXT_RETRY_DELAYS_MS[1]);
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
    expect(result.current.data?.available).toBe(true);
    expect(result.current.pending).toBe(false);
    expect(result.current.loading).toBe(false);
    unmount();
    // Once real, it is fresh: reopening reuses it with no request.
    renderHook(() => useAeContextSnapshot("conv_a", { enabled: true, identity }));
    await advance(0);
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
  });

  it("shows a plain unavailable answer at once and retries only pending ones", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      ok({ available: false, reason: "Could not read Claude context." }),
    );
    const { result } = renderHook(() =>
      useAeContextSnapshot("conv_a", { enabled: true, identity }),
    );
    await advance(0);
    expect(result.current.pending).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.data?.reason).toBe("Could not read Claude context.");
    await advance(60_000);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the settled reason through later automatic reloads once the window ends", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => ok(PENDING));
    useChatStore.setState({ conversationId: "conv_window", sessionStatus: "idle" });
    const { result } = renderHook(() =>
      useAeContextSnapshot("conv_window", { enabled: true, identity }),
    );
    await advance(120_000);
    expect(result.current.pending).toBe(false);
    expect(authenticatedFetch).toHaveBeenCalledTimes(8);
    // The three-minute reload answers pending again but opens no new quiet window.
    await advance(AE_CONTEXT_SNAPSHOT_TTL_MS);
    expect(authenticatedFetch).toHaveBeenCalledTimes(9);
    expect(result.current.pending).toBe(false);
    await advance(30_000);
    expect(authenticatedFetch).toHaveBeenCalledTimes(9);
    // A status change opens a new window for the next pending answer.
    act(() => useChatStore.setState({ sessionStatus: "running" }));
    await advance(AE_CONTEXT_SNAPSHOT_TTL_MS - 30_000);
    expect(authenticatedFetch).toHaveBeenCalledTimes(10);
    expect(result.current.pending).toBe(true);
  });

  it("opens a new quiet window on refresh after the last one ran out", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => ok(PENDING));
    const { result } = renderHook(() =>
      useAeContextSnapshot("conv_a", { enabled: true, identity }),
    );
    await advance(120_000);
    expect(result.current.pending).toBe(false);
    act(() => result.current.refresh());
    await advance(0);
    expect(result.current.pending).toBe(true);
  });

  it("drops pending when the last watcher goes, so a disabled view stops loading", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => ok(PENDING));
    const { result, rerender } = renderHook(
      ({ on }) => useAeContextSnapshot("conv_a", { enabled: on, identity }),
      { initialProps: { on: true } },
    );
    await advance(0);
    expect(result.current.pending).toBe(true);
    rerender({ on: false });
    expect(result.current.pending).toBe(false);
    expect(result.current.loading).toBe(false);
    await advance(60_000);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it("asks past the runner's cache on refresh, even while a plain read is in flight", async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(authenticatedFetch)
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      )
      .mockImplementation(() => ok());
    const { result } = renderHook(() =>
      useAeContextSnapshot("conv_a", { enabled: true, identity }),
    );
    act(() => result.current.refresh());
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(new Response(JSON.stringify({ available: true, observedAt: "x" })));
    });
    await advance(0);
    expect(vi.mocked(authenticatedFetch).mock.calls.map(([url]) => url)).toEqual([
      "/v1/sessions/conv_a/context-usage",
      "/v1/sessions/conv_a/context-usage?fresh=true",
    ]);
  });

  it("stops retrying after about two minutes and lets the reason show", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => ok(PENDING));
    const { result } = renderHook(() =>
      useAeContextSnapshot("conv_a", { enabled: true, identity }),
    );
    await advance(0);
    // 2, 4, 8, 16, then 30 s: answers at 0, 2, 6, 14, 30, 60, 90 and 120 s.
    await advance(119_000);
    expect(result.current.pending).toBe(true);
    await advance(1000);
    expect(authenticatedFetch).toHaveBeenCalledTimes(8);
    expect(result.current.pending).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.data?.reason).toBe("Claude is starting.");
    // No more quiet retries; the next is the ordinary three-minute reload.
    await advance(60_000);
    expect(authenticatedFetch).toHaveBeenCalledTimes(8);
  });

  it("shows an offline answer at once, with no quiet retry", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      ok({ available: false, offline: true, reason: "The runner is offline." }),
    );
    const { result } = renderHook(() =>
      useAeContextSnapshot("conv_a", { enabled: true, identity }),
    );
    await advance(0);
    expect(result.current.pending).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.data?.reason).toBe("The runner is offline.");
    await advance(60_000);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it("shows a final answer at once, retries nothing and reuses it", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      ok({ available: false, final: true, reason: "Another harness." }),
    );
    const { result, unmount } = renderHook(() =>
      useAeContextSnapshot("conv_a", { enabled: true, identity }),
    );
    await advance(0);
    expect(result.current.pending).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.data?.reason).toBe("Another harness.");
    await advance(60_000);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    unmount();
    renderHook(() => useAeContextSnapshot("conv_a", { enabled: true, identity }));
    await advance(0);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it("cancels the quiet retry when the last subscriber goes", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => ok(PENDING));
    const { unmount } = renderHook(() =>
      useAeContextSnapshot("conv_a", { enabled: true, identity }),
    );
    await advance(0);
    unmount();
    await advance(3 * 60_000);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it("reads anew once per turn end, however many sections watch the session", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => ok());
    useChatStore.setState({ conversationId: "conv_shared", sessionStatus: "running" });
    const { result } = renderHook(() => useTwo(true, "conv_shared"));
    await vi.waitFor(() => expect(result.current.rail.data?.available).toBe(true));
    const fresh = () =>
      vi.mocked(authenticatedFetch).mock.calls.filter(([url]) => String(url).includes("fresh"))
        .length;
    act(() => useChatStore.setState({ sessionStatus: "idle" }));
    await vi.waitFor(() => expect(fresh()).toBe(1));
    await advance(5000);
    expect(fresh()).toBe(1);
    // A later turn is a newer edge and reads anew once more.
    act(() => useChatStore.setState({ sessionStatus: "running" }));
    act(() => useChatStore.setState({ sessionStatus: "idle" }));
    await vi.waitFor(() => expect(fresh()).toBe(2));
    await advance(5000);
    expect(fresh()).toBe(2);
  });

  it("asks again when the session's turn ends", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => ok());
    useChatStore.setState({ conversationId: "conv_turn", sessionStatus: "running" });
    const { result } = renderHook(() =>
      useAeContextSnapshot("conv_turn", { enabled: true, identity }),
    );
    await vi.waitFor(() => expect(result.current.data?.available).toBe(true));
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    act(() => useChatStore.setState({ sessionStatus: "idle" }));
    await vi.waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(authenticatedFetch).mock.calls[1][0]).toBe(
      "/v1/sessions/conv_turn/context-usage?fresh=true",
    );
    // Another session's turn, or no turn at all, asks nothing.
    act(() => useChatStore.setState({ conversationId: "conv_b", sessionStatus: "running" }));
    act(() => useChatStore.setState({ sessionStatus: "idle" }));
    await advance(0);
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
  });
});
