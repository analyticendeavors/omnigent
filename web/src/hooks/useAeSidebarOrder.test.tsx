// The manual order's server sync: the read only while Manual is on, the
// optimistic queued save, the one replay on a stale revision, the rollback on
// a failure, and the capped page loading Triage and Manual ask for.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));
vi.mock("@/components/ui/toast", () => ({ showToast: mocks.toast }));

import type { SidebarListQuery } from "@/hooks/useSidebarData";
import {
  AE_SIDEBAR_QUERY_KEY,
  type AeOrderOp,
  type AeSidebarOrder,
  aeEnqueueOrder,
  aeOrderSettled,
  useAeLoadAllPages,
  useAeSidebarOrder,
} from "./useAeSidebarOrder";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function putBodies(): { order: string[]; revision: number }[] {
  return mocks.fetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

// Session ids are 32 lowercase hex; the queue sends nothing else.
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const LOADED = [A, B, C];
const moveTop = (id: string): AeOrderOp => ({
  kind: "move",
  id,
  to: "top",
  scopeIds: LOADED,
  units: [LOADED.map((rowId) => ({ id: rowId }))],
});

let client: QueryClient;
const shown = () => client.getQueryData<AeSidebarOrder>(AE_SIDEBAR_QUERY_KEY);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.fetch.mockReset();
  mocks.toast.mockReset();
});

afterEach(() => client.clear());

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useAeSidebarOrder", () => {
  it("reads nothing while Manual is off", async () => {
    renderHook(() => useAeSidebarOrder(false), { wrapper });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("reads the saved order while Manual is on", async () => {
    mocks.fetch.mockResolvedValue(json({ order: [B, A], revision: 4 }));
    const { result } = renderHook(() => useAeSidebarOrder(true), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ order: [B, A], revision: 4 }));
    expect(mocks.fetch).toHaveBeenCalledWith("/v1/ae/sidebar", { method: "GET" });
  });
});

describe("aeEnqueueOrder", () => {
  it("shows a move at once and saves it on the shown revision", async () => {
    client.setQueryData(AE_SIDEBAR_QUERY_KEY, { order: [], revision: 2 });
    mocks.fetch.mockResolvedValueOnce(json({ order: [C, A, B], revision: 3 }));
    expect(aeEnqueueOrder(client, moveTop(C))).toBe(true);
    expect(shown()).toEqual({ order: [C, A, B], revision: 2 });
    await waitFor(() => expect(shown()?.revision).toBe(3));
    expect(putBodies()).toEqual([{ order: [C, A, B], revision: 2 }]);
    const init = mocks.fetch.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("saves nothing for a move that changes nothing", () => {
    client.setQueryData(AE_SIDEBAR_QUERY_KEY, { order: [A, B, C], revision: 1 });
    expect(aeEnqueueOrder(client, moveTop(A))).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("queues quick moves, each save built on the latest order and revision", async () => {
    client.setQueryData(AE_SIDEBAR_QUERY_KEY, { order: [], revision: 0 });
    let answerFirst!: (res: Response) => void;
    mocks.fetch
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          answerFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(json({ order: [B, C, A], revision: 2 }));
    aeEnqueueOrder(client, moveTop(C));
    aeEnqueueOrder(client, moveTop(B));
    expect(shown()?.order).toEqual([B, C, A]);
    expect(putBodies()).toHaveLength(1);
    await act(async () => answerFirst(json({ order: [C, A, B], revision: 1 })));
    await waitFor(() => expect(putBodies()).toHaveLength(2));
    expect(putBodies()[1]).toEqual({ order: [B, C, A], revision: 1 });
    await waitFor(() => expect(shown()).toEqual({ order: [B, C, A], revision: 2 }));
  });

  it("replays the move once on the order a stale save gets back", async () => {
    client.setQueryData(AE_SIDEBAR_QUERY_KEY, { order: [], revision: 0 });
    mocks.fetch
      .mockResolvedValueOnce(
        json({ error: { code: "conflict", message: "stale", order: [B, A, C], revision: 5 } }, 409),
      )
      .mockResolvedValueOnce(json({ order: [C, B, A], revision: 6 }));
    aeEnqueueOrder(client, moveTop(C));
    await waitFor(() => expect(putBodies()).toHaveLength(2));
    expect(putBodies()[1]).toEqual({ order: [C, B, A], revision: 5 });
    await waitFor(() => expect(shown()).toEqual({ order: [C, B, A], revision: 6 }));
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("gives up after a second stale save and shows the saved order", async () => {
    client.setQueryData(AE_SIDEBAR_QUERY_KEY, { order: [], revision: 0 });
    const conflict = (revision: number) =>
      json({ error: { code: "conflict", message: "stale", order: [A], revision } }, 409);
    mocks.fetch.mockResolvedValueOnce(conflict(5)).mockResolvedValueOnce(conflict(6));
    aeEnqueueOrder(client, moveTop(C));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    expect(putBodies()).toHaveLength(2);
    expect(shown()).toEqual({ order: [A], revision: 6 });
    expect(String(mocks.toast.mock.calls[0][0])).toContain("changed on another device");
  });

  it("rolls back to the last saved order when a save fails", async () => {
    client.setQueryData(AE_SIDEBAR_QUERY_KEY, { order: [A, B, C], revision: 7 });
    mocks.fetch.mockResolvedValueOnce(
      json({ error: { code: "invalid_input", message: "bad id" } }, 400),
    );
    aeEnqueueOrder(client, moveTop(C));
    expect(shown()?.order).toEqual([C, A, B]);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    expect(shown()).toEqual({ order: [A, B, C], revision: 7 });
    expect(String(mocks.toast.mock.calls[0][0])).toContain("400: bad id");
    // Every queued change was undone, so the toast speaks of all of them.
    expect(String(mocks.toast.mock.calls[0][0])).toContain("recent changes to it were undone");
  });

  it("keeps the shown order when a read lands while a save is queued", async () => {
    client.setQueryData(AE_SIDEBAR_QUERY_KEY, { order: [], revision: 0 });
    let answerPut!: (res: Response) => void;
    mocks.fetch.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Promise<Response>((resolve) => {
            answerPut = resolve;
          })
        : Promise.resolve(json({ order: [], revision: 0 })),
    );
    const { result } = renderHook(() => useAeSidebarOrder(true), { wrapper });
    aeEnqueueOrder(client, moveTop(C));
    await act(async () => {
      await result.current.refetch();
    });
    expect(mocks.fetch).toHaveBeenCalledWith("/v1/ae/sidebar", { method: "GET" });
    expect(shown()?.order).toEqual([C, A, B]);
    await act(async () => answerPut(json({ order: [C, A, B], revision: 1 })));
  });
});

describe("aeEnqueueOrder ids and settling", () => {
  it("never sends a provisional temp: row's id", async () => {
    client.setQueryData(AE_SIDEBAR_QUERY_KEY, { order: [], revision: 0 });
    mocks.fetch.mockResolvedValueOnce(json({ order: [C, A, B], revision: 1 }));
    aeEnqueueOrder(client, {
      kind: "move",
      id: C,
      to: "top",
      scopeIds: ["temp:new", ...LOADED],
      units: [LOADED.map((rowId) => ({ id: rowId }))],
    });
    aeEnqueueOrder(client, { kind: "set", order: ["temp:new", C, A, B] });
    await waitFor(() => expect(putBodies().length).toBeGreaterThan(0));
    for (const body of putBodies()) expect(body.order).not.toContain("temp:new");
  });

  it("settles true once saved and false once undone", async () => {
    client.setQueryData(AE_SIDEBAR_QUERY_KEY, { order: [], revision: 0 });
    await expect(aeOrderSettled(client)).resolves.toBe(true);
    mocks.fetch
      .mockResolvedValueOnce(json({ order: [], revision: 1 }))
      .mockResolvedValueOnce(json({ error: { code: "invalid_input", message: "no" } }, 400));
    aeEnqueueOrder(client, { kind: "set", order: [] });
    await expect(aeOrderSettled(client)).resolves.toBe(true);
    aeEnqueueOrder(client, { kind: "set", order: [A] });
    await expect(aeOrderSettled(client)).resolves.toBe(false);
  });
});

describe("useAeLoadAllPages", () => {
  function listQuery(loaded: number, hasNextPage = true): SidebarListQuery {
    return {
      data: {
        pages: [
          {
            data: Array.from({ length: loaded }, (_, i) => ({ id: `s${i}` })),
            first_id: null,
            last_id: null,
            has_more: hasNextPage,
          },
        ],
        pageParams: [undefined],
      },
      hasNextPage,
      isFetchingNextPage: false,
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      fetchNextPage: vi.fn(),
    } as unknown as SidebarListQuery;
  }

  it("loads the next page while enabled and under the refresh window", () => {
    const query = listQuery(30);
    renderHook(() => useAeLoadAllPages(query, true), { wrapper });
    expect(query.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("stops at the refresh window, at the end, and while disabled", () => {
    for (const [query, enabled] of [
      [listQuery(100), true],
      [listQuery(30, false), true],
      [listQuery(30), false],
    ] as const) {
      renderHook(() => useAeLoadAllPages(query, enabled), { wrapper });
      expect(query.fetchNextPage).not.toHaveBeenCalled();
    }
  });
});
