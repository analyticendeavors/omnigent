import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { authenticatedFetch } from "@/lib/identity";
import type { AePrCard } from "@/lib/aePrs";
import { AePrDeployStatus } from "./AePrDeployStatus";

const merged = { state: "merged" } as AePrCard;

function renderStatus(repo: string, state: string) {
  vi.mocked(authenticatedFetch).mockResolvedValue(
    new Response(JSON.stringify({ state, running: "ae-v0.18.0.32", mid_turn: 0 })),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AePrDeployStatus prs={[{ repo, number: 179, card: merged }]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.mocked(authenticatedFetch).mockReset());
afterEach(cleanup);

describe("AePrDeployStatus", () => {
  it("says waiting for deploy until the running release has the merge", async () => {
    renderStatus("analyticendeavors/omnigent-ae", "waiting");
    expect((await screen.findByTestId("ae-pr-deploy-status")).textContent).toBe(
      "waiting for deploy",
    );
  });

  it("names the release once live", async () => {
    renderStatus("analyticendeavors/omnigent-ae", "live");
    expect((await screen.findByTestId("ae-pr-deploy-status")).textContent).toBe(
      "live in ae-v0.18.0.32",
    );
  });

  it("shows nothing for another repo, and never asks", () => {
    const { container } = renderStatus("o/other", "waiting");
    expect(container.textContent).toBe("");
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});
