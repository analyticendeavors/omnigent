import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AE_ACCOUNT_FOLLOW_UP_DELAYS_MS,
  aeRefreshChatAccount,
  aeRefreshChatAccountSoon,
} from "./aeClaudeAccount";

// A real useQuery on the card's own three-part key, to prove the ["ae-limits", id] prefix reaches it.
function Card({ id, fetchLimits }: { id: string; fetchLimits: () => Promise<number> }) {
  useQuery({ queryKey: ["ae-limits", id, null], queryFn: fetchLimits, staleTime: Infinity });
  return null;
}

afterEach(() => vi.useRealTimers());

describe("the Usage card's query", () => {
  it("refetches on the immediate re-read and again at each follow-up delay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const fetchLimits = () => Promise.resolve(++calls);
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <Card id="s1" fetchLimits={fetchLimits} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(calls).toBe(1));

    aeRefreshChatAccount(queryClient, "s1");
    aeRefreshChatAccountSoon(queryClient, "s1");
    await waitFor(() => expect(calls).toBe(2));

    await AE_ACCOUNT_FOLLOW_UP_DELAYS_MS.reduce(async (prev, delay, n) => {
      await prev;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay - (AE_ACCOUNT_FOLLOW_UP_DELAYS_MS[n - 1] ?? 0));
      });
      await waitFor(() => expect(calls).toBe(3 + n));
    }, Promise.resolve());
  });
});
