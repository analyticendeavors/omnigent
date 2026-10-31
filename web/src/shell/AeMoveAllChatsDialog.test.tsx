import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AeMoveAllChatsDialog } from "./AeMoveAllChatsDialog";
import { AE_ACCOUNT_FOLLOW_UP_DELAYS_MS } from "@/lib/aeClaudeAccount";
import { askAeMoveAll, dismissAeMoveAll } from "@/lib/aeMoveAllChats";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ showToast: vi.fn() }));
import { showToast } from "@/components/ui/toast";
import { authenticatedFetch } from "@/lib/identity";

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  vi.mocked(authenticatedFetch).mockReset();
  vi.mocked(showToast).mockReset();
});
afterEach(() => act(() => dismissAeMoveAll()));

let queryClient: QueryClient;

function ask() {
  queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <AeMoveAllChatsDialog />
    </QueryClientProvider>,
  );
  act(() => askAeMoveAll({ account: "AE Backup", label: "AE Backup", hostId: "host" }));
}

describe("AeMoveAllChatsDialog", () => {
  it("asks with the caution and focuses Only new chats", async () => {
    ask();
    expect(await screen.findByText("Move all open chats to AE Backup?")).toBeTruthy();
    expect(screen.getByText(/costs extra tokens on that subscription/)).toBeTruthy();
    expect(screen.getByText(/Chats that are mid-reply are skipped/)).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("ae-move-all-keep")),
    );
  });

  it("Only new chats closes without calling the server", async () => {
    ask();
    fireEvent.click(await screen.findByTestId("ae-move-all-keep"));
    await waitFor(() => expect(screen.queryByTestId("ae-move-all-dialog")).toBeNull());
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it("Move all chats posts the login and reports one line", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({
        moved: ["a", "b", "c", "d"],
        skipped: [{ id: "e", title: "Fix CI", reason: "mid-reply" }],
        pending: [{ id: "f", title: "Slow chat", reason: "still switching" }],
      }),
    );
    ask();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.click(await screen.findByTestId("ae-move-all-confirm"));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "Moved 4 chats; 1 still switching: Slow chat; 1 skipped: Fix CI is mid-reply",
      ),
    );
    // Every moved (or still switching) chat re-reads its labels and its Usage numbers.
    for (const id of ["a", "b", "c", "d", "f"]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["session", id] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["ae-limits", id] });
    }
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["session", "e"] });
    expect(authenticatedFetch).toHaveBeenCalledWith(
      "/v1/ae/claude-account/move-all",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ account: "AE Backup", host_id: "host" }),
      }),
    );
    expect(screen.queryByTestId("ae-move-all-dialog")).toBeNull();
  });

  it("reports a failed move", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ error: { message: "Could not move." } }, 500),
    );
    ask();
    fireEvent.click(await screen.findByTestId("ae-move-all-confirm"));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Could not")),
    );
  });

  describe("follow-up re-reads", () => {
    const last = AE_ACCOUNT_FOLLOW_UP_DELAYS_MS[AE_ACCOUNT_FOLLOW_UP_DELAYS_MS.length - 1];
    const reads = (spy: { mock: { calls: unknown[][] } }, id: string) =>
      spy.mock.calls.filter(([a]) => {
        const key = (a as { queryKey?: unknown[] }).queryKey;
        return key?.[0] === "ae-limits" && key?.[1] === id;
      }).length;
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it("a successful move schedules the schedule for every moved or still-switching chat only", async () => {
      vi.mocked(authenticatedFetch).mockImplementation(() =>
        json({
          moved: ["a", "b"],
          skipped: [{ id: "e", title: "Fix CI", reason: "mid-reply" }],
          pending: [{ id: "f", title: "Slow chat", reason: "still switching" }],
        }),
      );
      ask();
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      fireEvent.click(await screen.findByTestId("ae-move-all-confirm"));
      await waitFor(() => expect(showToast).toHaveBeenCalled());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(last);
      });
      for (const id of ["a", "b", "f"]) {
        expect(reads(invalidate, id)).toBe(1 + AE_ACCOUNT_FOLLOW_UP_DELAYS_MS.length);
      }
      expect(reads(invalidate, "e")).toBe(0);
    });

    it("a failed move schedules nothing", async () => {
      vi.mocked(authenticatedFetch).mockImplementation(() =>
        json({ error: { message: "Could not move." } }, 500),
      );
      ask();
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      fireEvent.click(await screen.findByTestId("ae-move-all-confirm"));
      await waitFor(() => expect(showToast).toHaveBeenCalled());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(last * 2);
      });
      expect(invalidate).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
