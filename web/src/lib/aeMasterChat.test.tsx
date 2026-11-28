import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { AeMasterChatRow } from "@/components/AeMasterChatRow";
import {
  isAeMasterChat,
  refreshAeMasterChat,
  useAeMasterChat,
  useAeMasterChatId,
} from "./aeMasterChat";

function IdReader() {
  useAeMasterChatId();
  return null;
}

const gets = () =>
  mocks.fetch.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "GET");

beforeEach(() => {
  vi.useFakeTimers();
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ session_id: "m", waiting: 0 }), { status: 200 })),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("isAeMasterChat", () => {
  it("matches the registry id and not an archived row", () => {
    expect(isAeMasterChat({ id: "m" }, "m")).toBe(true);
    expect(isAeMasterChat({ id: "m", archived: false }, "m")).toBe(true);
    expect(isAeMasterChat({ id: "m", archived: true }, "m")).toBe(false);
    expect(isAeMasterChat({ id: "x" }, "m")).toBe(false);
    expect(isAeMasterChat({ id: "m" }, null)).toBe(false);
  });
});

describe("one refetch timer", () => {
  it("sends one GET on mount and one more after 60 seconds with the row and two id readers", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AeMasterChatRow />
          <IdReader />
          <IdReader />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(gets()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(gets()).toHaveLength(2);
  });
});

function Row() {
  useAeMasterChat();
  return null;
}

describe("shared query options", () => {
  it("does not retry a failing reread when the id reader renders after the row", async () => {
    const qc = new QueryClient(); // the app's default retry, which the row's options override
    render(
      <QueryClientProvider client={qc}>
        <Row />
        <IdReader />
      </QueryClientProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(() => Promise.resolve(new Response("{}", { status: 500 })));
    await act(async () => {
      await refreshAeMasterChat(qc);
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(gets()).toHaveLength(1);
  });
});
