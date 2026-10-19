// The PATCH contract for editing a global policy's params (AE patch): the
// body carries only the fields given, and a refusal surfaces the server's
// reason instead of the bare status line.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAddDefaultPolicy, useUpdateDefaultPolicy } from "./useDefaultPolicies";

function mockResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.ok === false ? "Bad Request" : "OK",
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderMutation<T>(hook: () => T) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(hook, { wrapper });
}

const renderUpdate = () => renderMutation(useUpdateDefaultPolicy);

describe("useUpdateDefaultPolicy with factory_params", () => {
  it("PATCHes the new params and nothing else", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ id: "r1" }));
    const { result } = renderUpdate();
    result.current.mutate({ policyId: "r1", factory_params: { hours: 4, turns: 80 } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/policies/r1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ factory_params: { hours: 4, turns: 80 } });
  });

  it("throws the server's reason when the params are refused", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(
        { error: { message: "Policy 'ae_slot_cap' rejected these params: bad mode." } },
        { ok: false, status: 400 },
      ),
    );
    const { result } = renderUpdate();
    result.current.mutate({ policyId: "s1", factory_params: { mode: "nope" } });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe(
      "Policy 'ae_slot_cap' rejected these params: bad mode.",
    );
  });
});

describe("useAddDefaultPolicy", () => {
  it("throws the server's reason too, since the dialog shows both", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(
        { error: { message: "Policy 'budget' rejected these params: max_cost_usd must be > 0." } },
        { ok: false, status: 400 },
      ),
    );
    const { result } = renderMutation(useAddDefaultPolicy);
    result.current.mutate({
      name: "budget",
      type: "python",
      handler: "omnigent.policies.builtins.cost.cost_budget",
      factory_params: { max_cost_usd: -1 },
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe(
      "Policy 'budget' rejected these params: max_cost_usd must be > 0.",
    );
  });
});
