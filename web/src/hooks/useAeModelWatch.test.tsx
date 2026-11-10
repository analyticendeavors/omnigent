// The new-model watch's read: served ids feed the Claude model pickers, a failed read leaves the
// built-in list alone, and a picker rerenders when the ids arrive.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));

import type { NativeModelOption } from "@/lib/types";
import { aeSetWatchedModels, aeWatchedModels, useAeClaudeVersions } from "@/lib/aeClaudeModels";
import { aeParseModelWatch, useAeModelWatch } from "./useAeModelWatch";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const SUBSCRIPTION = { kind: "subscription", label: "Subscription", name: "claude" };
const CATALOG: NativeModelOption[] = [
  {
    id: "claude-fable-5-2[1m]",
    model: "claude-fable-5-2",
    displayName: "Fable",
    source: SUBSCRIPTION,
  },
];

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.fetch.mockReset();
  aeSetWatchedModels([]);
});

afterEach(() => {
  client.clear();
  aeSetWatchedModels([]);
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("aeParseModelWatch", () => {
  it("reads served_ids and nothing else", () => {
    expect(aeParseModelWatch({ served_ids: ["claude-fable-5-3", 7] })).toEqual([
      "claude-fable-5-3",
    ]);
    expect(aeParseModelWatch({ models: [] })).toBeNull();
    expect(aeParseModelWatch(null)).toBeNull();
  });
});

describe("useAeModelWatch", () => {
  it("puts the served ids into the known list", async () => {
    mocks.fetch.mockResolvedValue(json({ served_ids: ["claude-fable-5-3"] }));
    renderHook(() => useAeModelWatch(), { wrapper });
    await waitFor(() => expect(aeWatchedModels()).toEqual(["claude-fable-5-3"]));
    expect(mocks.fetch.mock.calls[0][0]).toBe("/v1/ae/model-watch");
  });

  it("leaves the built-in list in place when the read fails", async () => {
    mocks.fetch.mockResolvedValue(json({}, 500));
    renderHook(() => useAeModelWatch(), { wrapper });
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(aeWatchedModels()).toEqual([]);
  });

  it("rereads hourly and on focus, so an open app learns of a new model", async () => {
    mocks.fetch.mockResolvedValue(json({ served_ids: [] }));
    renderHook(() => useAeModelWatch(), { wrapper });
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    const options = client.getQueryCache().find({ queryKey: ["ae", "model-watch"] })?.observers[0]
      ?.options;
    expect(options?.refetchInterval).toBe(60 * 60 * 1000);
    expect(options?.refetchOnWindowFocus).toBe(true);
    expect(options?.staleTime).toBe(60 * 60 * 1000);
  });

  it("does not throw when the read itself rejects", async () => {
    mocks.fetch.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useAeModelWatch(), { wrapper });
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
    expect(aeWatchedModels()).toEqual([]);
  });
});

describe("useAeClaudeVersions with watched ids", () => {
  it("reruns when a watched id arrives and takes the row's place", () => {
    const { result } = renderHook(() => useAeClaudeVersions(CATALOG, true));
    expect(result.current.some((row) => row.id === "claude-fable-5-3[1m]")).toBe(false);
    act(() => aeSetWatchedModels(["claude-fable-5-3"]));
    expect(result.current.find((row) => row.id === "claude-fable-5-3[1m]")?.displayName).toBe(
      "Fable 5.3 (1M context)",
    );
    expect(result.current.some((row) => row.id === "claude-fable-5-2")).toBe(true);
  });
});
