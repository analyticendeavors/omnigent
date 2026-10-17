import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/identity";
import {
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
      .mockImplementation(() => ok({ available: false, reason: "Offline" }));
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
    vi.mocked(authenticatedFetch).mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const { result } = renderHook(() => useTwo(true));
    expect(result.current.rail.loading).toBe(true);
    act(() => result.current.rail.refresh());
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(new Response(JSON.stringify({ available: true, observedAt: "x" })));
    });
    await waitFor(() => expect(result.current.rail.loading).toBe(false));
    vi.mocked(authenticatedFetch).mockImplementation(() => ok());
    act(() => result.current.rail.refresh());
    expect(result.current.popover.loading).toBe(true);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
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
