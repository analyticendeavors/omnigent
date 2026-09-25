import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { authenticatedFetch } from "@/lib/identity";
import { type AePrCard, aePrUrlsIn } from "@/lib/aePrs";
import { AeInlinePrCards } from "./AeInlinePrCards";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const REPO = "analyticendeavors/omnigent-ae";
const url = (n: number, repo = REPO) => `https://github.com/${repo}/pull/${n}`;

function card(number: number): AePrCard {
  return {
    repo: REPO,
    number,
    url: url(number),
    title: `PR ${number}`,
    state: "open",
    draft: false,
    author: "ae-reid-havens",
    head_ref: `claude/branch-${number}`,
    base_ref: "main",
    head_sha: SHA,
    ci: { state: "passing", passing: 6, failing: 0, pending: 0, total: 6 },
    mergeable: { state: "clean", detail: "No conflicts with the base branch." },
    review: { state: "approved", approvals: 1, changes_requested: 0, requested: [] },
    merge: { methods: ["squash"], default_method: "squash", allowed: true, reason: null },
  };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

function renderText(text: string, tracked?: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (tracked) {
    qc.setQueryData(["github-info", "s1"], {
      available: true,
      prs: tracked.map((u) => ({ url: u })),
    });
  }
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/c/s1"]}>
        <Routes>
          <Route path="/c/:conversationId" element={<AeInlinePrCards text={text} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(authenticatedFetch).mockReset();
});

afterEach(cleanup);

describe("aePrUrlsIn", () => {
  it("finds each github.com pull request URL once, in order", () => {
    const text = `Opened ${url(41)} (see ${url(41)}/files), and ${url(7, "o/r")}. Issue https://github.com/o/r/issues/2.`;
    expect(aePrUrlsIn(text)).toEqual([url(41), url(7, "o/r")]);
    expect(aePrUrlsIn("no links here")).toEqual([]);
  });
});

describe("AeInlinePrCards", () => {
  it("renders nothing and calls nothing for a message without a PR URL", () => {
    const { container } = renderText("All done, tests pass.");
    expect(container.textContent).toBe("");
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it("cards only the session's tracked PRs when the list is known", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => json(card(41)));
    renderText(`PR: ${url(41)}. Builds on ${url(6935, "omnigent-ai/omnigent")}.`, [url(41)]);
    const inline = await screen.findByTestId("ae-pr-inline");
    expect(within(inline).getByText("PR 41")).toBeTruthy();
    expect(screen.getAllByTestId("ae-pr-inline")).toHaveLength(1);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(authenticatedFetch).toHaveBeenCalledWith(`/v1/ae/prs/${REPO}/41`, { method: "GET" });
  });

  it("stays silent when the card cannot be read", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ error: { code: "github_unavailable", message: "404" } }, 502),
    );
    const { container } = renderText(`See ${url(9)}`);
    await vi.waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    expect(container.querySelector("[data-testid=ae-pr-inline]")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("merges from the thread with this session named", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    vi.mocked(authenticatedFetch).mockImplementation((input, init) => {
      calls.push({ path: String(input), init: init as RequestInit });
      if (String(input).endsWith("/merge")) {
        return json({
          merged: true,
          repo: REPO,
          number: 41,
          method: "squash",
          sha: "abcdef1234",
          message: "Pull Request successfully merged",
          session: { id: "s1", status: "working", offer_review: true },
        });
      }
      return json(card(41));
    });
    renderText(`Opened ${url(41)}`, [url(41)]);
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm merge" }));
    expect((await screen.findByRole("status")).textContent).toContain("Merged #41 (squashed)");
    const merge = calls.find((call) => call.path.endsWith("/merge"))!;
    expect(JSON.parse(String(merge.init?.body))).toEqual({
      sha: SHA,
      method: "squash",
      session_id: "s1",
    });
    expect(screen.getByTestId("ae-pr-set-review")).toBeTruthy();
  });
});
