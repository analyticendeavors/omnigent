import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import type { GithubInfo } from "@/hooks/useGithub";
import { authenticatedFetch } from "@/lib/identity";
import { useAeRailCodexMcp, useAeRailPrs } from "./aeRailQueries";

const REPO = "analyticendeavors/omnigent-ae";
const url = (n: number) => `https://github.com/${REPO}/pull/${n}`;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function serve(routes: Record<string, () => Response>) {
  vi.mocked(authenticatedFetch).mockImplementation((input) => {
    const path = String(input);
    const route = Object.keys(routes).find((key) => path.includes(key));
    return Promise.resolve(route ? routes[route]() : new Response("{}", { status: 500 }));
  });
}

beforeEach(() => vi.mocked(authenticatedFetch).mockReset());
afterEach(cleanup);

describe("useAeRailPrs", () => {
  const info = {
    object: "session.github.info",
    available: true,
    prs: [
      { url: url(108), host: "github.com", repository: REPO, number: 108, relationship: "created" },
      {
        url: url(108),
        host: "github.com",
        repository: REPO,
        number: 108,
        relationship: "attached",
      },
      {
        url: "https://git.example.com/a/b/pull/3",
        host: "git.example.com",
        repository: "a/b",
        number: 3,
        title: "Elsewhere",
        relationship: "attached",
      },
    ],
  } as GithubInfo;

  it("dedupes linked pull requests and reads cards only while active", async () => {
    serve({
      "/v1/ae/prs/": () =>
        new Response(
          JSON.stringify({
            repo: REPO,
            number: 108,
            url: url(108),
            title: "Add a session rail",
            state: "open",
            draft: false,
            ci: { state: "pending", passing: 0, failing: 0, pending: 1, total: 1 },
          }),
        ),
    });
    const { result, rerender } = renderHook(({ active }) => useAeRailPrs(info, active), {
      wrapper,
      initialProps: { active: false },
    });
    expect(result.current.map((pr) => [pr.number, pr.title])).toEqual([
      [108, null],
      [3, "Elsewhere"],
    ]);
    expect(authenticatedFetch).not.toHaveBeenCalled();
    rerender({ active: true });
    await waitFor(() => expect(result.current[0].title).toBe("Add a session rail"));
    expect(result.current[0].repository).toBe(REPO);
    expect(result.current[1].card).toBeUndefined();
  });
});

describe("useAeRailCodexMcp", () => {
  it("returns names and statuses", async () => {
    const body = {
      available: true,
      servers: [{ name: "ae", status: "connected" }],
      observedAt: "t",
    };
    serve({ "/ae-mcp-status": () => new Response(JSON.stringify(body)) });
    const { result } = renderHook(() => useAeRailCodexMcp("s1", true), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(body));
  });

  it.each([
    [403, "Connector status needs edit access to this session."],
    [404, "This server cannot report Codex connectors yet. Update OmniGent and retry."],
    [500, "Could not load connectors (HTTP 500). Try refresh."],
  ])("explains HTTP %i", async (status, message) => {
    serve({ "/ae-mcp-status": () => new Response("{}", { status }) });
    const { result } = renderHook(() => useAeRailCodexMcp("s1", true), { wrapper });
    await waitFor(() => expect(result.current.error?.message).toBe(message));
  });

  it("does not fetch while disabled", () => {
    renderHook(() => useAeRailCodexMcp("s1", false), { wrapper });
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});
