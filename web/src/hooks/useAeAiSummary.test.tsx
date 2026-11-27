// The AI summary hook: asks once for a derived or generic pending card, never for the
// agent's own line, and fails quiet (omnigent-ae, 2026-11-27).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));

import type { ApprovalSummary } from "@/lib/aeApprovalSummary";
import { aeAiSummaryBody, useAeAiSummary } from "./useAeAiSummary";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const summary = (over: Partial<ApprovalSummary> = {}): ApprovalSummary => ({
  text: "Run pnpm install",
  source: "derived",
  risk: "write",
  kind: "command",
  code: "pnpm install --token=abc123secret",
  ...over,
});

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient();
  mocks.fetch.mockReset();
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("aeAiSummaryBody", () => {
  it("is null for the agent's own line and scrubbed and capped otherwise", () => {
    expect(aeAiSummaryBody(summary({ source: "agent" }))).toBeNull();
    const body = aeAiSummaryBody(summary({ code: `key=sk-abcdef123456 ${"x".repeat(3000)}` }));
    expect(body?.tool).toBe("Run a command");
    expect(body?.args).not.toContain("sk-abcdef123456");
    expect(body?.args.length).toBeLessThanOrEqual(2000);
  });
});

describe("useAeAiSummary", () => {
  it("posts the card once and returns the sentence for derived and generic lines", async () => {
    mocks.fetch.mockImplementation(async () => json({ text: "Installs the project's packages." }));
    const derived = renderHook(() => useAeAiSummary(summary({ source: "derived" })), { wrapper });
    await waitFor(() => expect(derived.result.current).toBe("Installs the project's packages."));
    const generic = renderHook(() => useAeAiSummary(summary({ source: "generic", text: "g" })), {
      wrapper,
    });
    await waitFor(() => expect(generic.result.current).toBe("Installs the project's packages."));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/v1/ae/approval-summary");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).args).not.toContain("abc123secret");
  });

  it("asks once for a repeated render of the same card", async () => {
    mocks.fetch.mockResolvedValue(json({ text: "Installs packages." }));
    const first = renderHook(() => useAeAiSummary(summary()), { wrapper });
    await waitFor(() => expect(first.result.current).toBe("Installs packages."));
    const second = renderHook(() => useAeAiSummary(summary()), { wrapper });
    expect(second.result.current).toBe("Installs packages.");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not ask again when a failed card remounts", async () => {
    mocks.fetch.mockImplementation(async () => json({ error: "down" }, 503));
    const first = renderHook(() => useAeAiSummary(summary()), { wrapper });
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    await tick();
    first.unmount();
    renderHook(() => useAeAiSummary(summary()), { wrapper });
    await tick();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("never calls the service for an agent-written line", async () => {
    const { result } = renderHook(() => useAeAiSummary(summary({ source: "agent" })), { wrapper });
    await tick();
    expect(result.current).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("stays null on a 503 without retrying, and with no provider", async () => {
    mocks.fetch.mockResolvedValue(json({ error: "not set up" }, 503));
    const { result } = renderHook(() => useAeAiSummary(summary()), { wrapper });
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    await tick();
    expect(result.current).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const bare = renderHook(() => useAeAiSummary(summary({ text: "other" })));
    expect(bare.result.current).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
