import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AE_ACCOUNT_FOLLOW_UP_DELAYS_MS } from "@/lib/aeClaudeAccount";
import { authenticatedFetch } from "@/lib/identity";
import { useAeSwitchClaudeAccount } from "./useAeSwitchClaudeAccount";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

// The card's real key is three parts (session, named account); the ["ae-limits", id] prefix must match it.
const limitsKey = (id: string) => ["ae-limits", id, null];
const stale = (id: string) => queryClient.getQueryState(limitsKey(id))?.isInvalidated === true;
const seed = (id: string) => queryClient.setQueryData(limitsKey(id), { ok: true });
const limitsCalls = (spy: ReturnType<typeof vi.spyOn>, id: string) =>
  spy.mock.calls.filter(([a]) => {
    const key = (a as { queryKey?: unknown[] } | undefined)?.queryKey;
    return key?.[0] === "ae-limits" && key?.[1] === id;
  }).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(authenticatedFetch).mockReset();
  queryClient = new QueryClient();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

async function switchTo(result: { current: ReturnType<typeof useAeSwitchClaudeAccount> }) {
  await act(async () => {
    await result.current.mutateAsync({ account: "Backup" }).catch(() => {});
  });
}

const total = AE_ACCOUNT_FOLLOW_UP_DELAYS_MS.length;
const last = AE_ACCOUNT_FOLLOW_UP_DELAYS_MS[total - 1];

describe("useAeSwitchClaudeAccount", () => {
  it("re-reads once now and again at each delay after a switch that went through", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ account: "Backup", relaunched: true }),
    );
    seed("s1");
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useAeSwitchClaudeAccount("s1"), { wrapper });
    await switchTo(result);
    expect(limitsCalls(spy, "s1")).toBe(1);
    expect(stale("s1")).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(last);
    });
    expect(limitsCalls(spy, "s1")).toBe(1 + total);
  });

  it("a rejected switch re-reads once and schedules no follow-ups", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ error: { message: "Chat is busy." } }, 409),
    );
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useAeSwitchClaudeAccount("s1"), { wrapper });
    await switchTo(result);
    await act(async () => {
      vi.advanceTimersByTime(last * 2);
    });
    expect(limitsCalls(spy, "s1")).toBe(1);
  });

  it("keeps re-reading after the hook unmounts (the composer menu closes)", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ account: "Backup", relaunched: true }),
    );
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const { result, unmount } = renderHook(() => useAeSwitchClaudeAccount("s1"), { wrapper });
    await switchTo(result);
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(last);
    });
    expect(limitsCalls(spy, "s1")).toBe(1 + total);
  });

  it("a second switch for the same chat replaces the first schedule; another chat keeps its own", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ account: "Backup", relaunched: true }),
    );
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const one = renderHook(() => useAeSwitchClaudeAccount("s1"), { wrapper });
    const two = renderHook(() => useAeSwitchClaudeAccount("s2"), { wrapper });
    await switchTo(one.result);
    await switchTo(two.result);
    await act(async () => {
      vi.advanceTimersByTime(AE_ACCOUNT_FOLLOW_UP_DELAYS_MS[0]);
    });
    await switchTo(one.result);
    await act(async () => {
      vi.advanceTimersByTime(last);
    });
    // s1: immediate, first schedule's 2 s read, immediate again, then one full schedule.
    expect(limitsCalls(spy, "s1")).toBe(2 + 1 + total);
    expect(limitsCalls(spy, "s2")).toBe(1 + total);
  });
});
