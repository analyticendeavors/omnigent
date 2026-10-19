// Settings > Chat > Session list: the pointer to the list's filter button, and
// "Reset manual order", which saves an empty order and offers an Undo that
// puts the previous order back.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn(), showToast: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));
vi.mock("@/components/ui/toast", () => ({ showToast: mocks.showToast }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import { AE_SIDEBAR_QUERY_KEY, aeEnqueueOrder } from "@/hooks/useAeSidebarOrder";
import { AeSessionListSetting } from "./AeSessionListSetting";

const A = "a".repeat(32);
const B = "b".repeat(32);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function puts(): { order: string[]; revision: number }[] {
  return mocks.fetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.toast.mockReset();
  mocks.showToast.mockReset();
});

afterEach(cleanup);

describe("AeSessionListSetting", () => {
  it("points at the list's filter button and renders without a query client", () => {
    render(<AeSessionListSetting />);
    expect(screen.getByText("Session list")).toBeInTheDocument();
    expect(screen.getByText(/filter button at the top of the session list/)).toBeInTheDocument();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("resets the order on the current revision and undoes it", async () => {
    const qc = new QueryClient();
    mocks.fetch
      .mockResolvedValueOnce(json({ order: [B, A], revision: 4 }))
      .mockResolvedValueOnce(json({ order: [], revision: 5 }))
      .mockResolvedValueOnce(json({ order: [B, A], revision: 6 }));
    render(
      <QueryClientProvider client={qc}>
        <AeSessionListSetting />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("ae-reset-session-order"));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    expect(puts()).toEqual([{ order: [], revision: 4 }]);
    expect(qc.getQueryData(AE_SIDEBAR_QUERY_KEY)).toEqual({ order: [], revision: 5 });
    const [title, options] = mocks.toast.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(title).toBe("Manual order reset");
    expect(options.action.label).toBe("Undo");
    options.action.onClick();
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith("Manual order restored."));
    expect(puts()[1]).toEqual({ order: [B, A], revision: 5 });
    expect(qc.getQueryData(AE_SIDEBAR_QUERY_KEY)).toEqual({ order: [B, A], revision: 6 });
  });

  it("waits behind a sidebar move still saving, then resets on top of it", async () => {
    const qc = new QueryClient();
    qc.setQueryData(AE_SIDEBAR_QUERY_KEY, { order: [A, B], revision: 2 });
    let answerMove!: (res: Response) => void;
    mocks.fetch
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          answerMove = resolve;
        }),
      )
      .mockResolvedValueOnce(json({ order: [], revision: 4 }));
    // The sidebar's move: B to top, saving when Reset is pressed.
    aeEnqueueOrder(qc, { kind: "set", order: [B, A] });
    render(
      <QueryClientProvider client={qc}>
        <AeSessionListSetting />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("ae-reset-session-order"));
    await act(async () => answerMove(json({ order: [B, A], revision: 3 })));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    // No read raced the move, and the reset went last, on the move's revision.
    expect(mocks.fetch.mock.calls.every(([, init]) => init?.method === "PUT")).toBe(true);
    expect(puts()).toEqual([
      { order: [B, A], revision: 2 },
      { order: [], revision: 3 },
    ]);
    expect(qc.getQueryData(AE_SIDEBAR_QUERY_KEY)).toEqual({ order: [], revision: 4 });
  });

  it("saves nothing when the order is already empty", async () => {
    mocks.fetch.mockResolvedValueOnce(json({ order: [], revision: 0 }));
    render(<AeSessionListSetting />);
    fireEvent.click(screen.getByTestId("ae-reset-session-order"));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledTimes(1));
    expect(puts()).toHaveLength(0);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("offers no Undo when the reset could not be saved", async () => {
    const conflict = (revision: number) =>
      json({ error: { code: "conflict", message: "stale", order: [B], revision } }, 409);
    mocks.fetch
      .mockResolvedValueOnce(json({ order: [A], revision: 1 }))
      .mockResolvedValueOnce(conflict(2))
      .mockResolvedValueOnce(conflict(3));
    render(<AeSessionListSetting />);
    fireEvent.click(screen.getByTestId("ae-reset-session-order"));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledTimes(1));
    expect(String(mocks.showToast.mock.calls[0][0])).toContain("another device");
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
