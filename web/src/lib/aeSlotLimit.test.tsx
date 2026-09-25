// Tests for the server's slot limit in the UI (omnigent-ae, 2026-09-24):
// `limit` from `GET /v1/ae/capacity`, three only until it answers.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));

import {
  AE_SLOT_LIMIT_QUERY_KEY,
  fetchAeSlotLimit,
  parseAeSlotLimit,
  readAeSlotLimit,
  rememberAeSlotLimit,
  useAeSlotLimit,
} from "./aeSlotLimit";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function Probe() {
  return <span data-testid="limit">{useAeSlotLimit()}</span>;
}

function renderProbe(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
}

// A block body: a function returned from beforeEach runs as its teardown.
beforeEach(() => {
  mocks.fetch.mockReset();
});
afterEach(cleanup);

describe("parseAeSlotLimit", () => {
  it("takes a whole number of one or more and nothing else", () => {
    expect(parseAeSlotLimit(4)).toBe(4);
    expect(parseAeSlotLimit(1)).toBe(1);
    for (const bad of [0, -1, 3.5, "4", null, undefined]) {
      expect(parseAeSlotLimit(bad)).toBeNull();
    }
  });
});

describe("fetchAeSlotLimit", () => {
  it("reads limit from the capacity route", async () => {
    mocks.fetch.mockResolvedValue(json(200, { limit: 4, working: [] }));
    await expect(fetchAeSlotLimit()).resolves.toBe(4);
    expect(mocks.fetch).toHaveBeenCalledWith("/v1/ae/capacity", { method: "GET" });
  });

  it("throws when the route fails or carries no limit", async () => {
    mocks.fetch.mockResolvedValueOnce(json(404, { detail: "Not Found" }));
    await expect(fetchAeSlotLimit()).rejects.toThrow("404");
    mocks.fetch.mockResolvedValueOnce(json(200, { working: [] }));
    await expect(fetchAeSlotLimit()).rejects.toThrow("no slot limit");
  });
});

describe("rememberAeSlotLimit and readAeSlotLimit", () => {
  it("falls back to three, then keeps what a capacity answer carried", () => {
    const qc = new QueryClient();
    expect(readAeSlotLimit(qc)).toBe(3);
    expect(rememberAeSlotLimit(qc, "five")).toBeNull();
    expect(readAeSlotLimit(qc)).toBe(3);
    expect(rememberAeSlotLimit(qc, 5)).toBe(5);
    expect(readAeSlotLimit(qc)).toBe(5);
  });
});

describe("useAeSlotLimit", () => {
  it("shows three until the server answers, then the server's limit", async () => {
    let answer: (response: Response) => void = () => undefined;
    mocks.fetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    );
    const qc = new QueryClient();
    renderProbe(qc);
    expect(screen.getByTestId("limit")).toHaveTextContent("3");
    answer(json(200, { limit: 4 }));
    await waitFor(() => expect(screen.getByTestId("limit")).toHaveTextContent("4"));
    expect(qc.getQueryData(AE_SLOT_LIMIT_QUERY_KEY)).toBe(4);
  });

  it("stays on three when the route cannot answer", async () => {
    mocks.fetch.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    renderProbe(new QueryClient());
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(screen.getByTestId("limit")).toHaveTextContent("3");
  });
});
