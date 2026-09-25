import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { authenticatedFetch } from "@/lib/identity";
import { type AePrCard, parseAePrUrl } from "@/lib/aePrs";
import { AePrCards } from "./AePrCards";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const REPO = "analyticendeavors/omnigent-ae";
const url = (n: number) => `https://github.com/${REPO}/pull/${n}`;

function card(number: number, extra: Partial<AePrCard> = {}): AePrCard {
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
    merge: { methods: ["squash", "merge"], default_method: "squash", allowed: true, reason: null },
    ...extra,
  };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

type Route = (path: string, init?: RequestInit) => Promise<Response>;

function serve(route: Route) {
  vi.mocked(authenticatedFetch).mockImplementation((input, init) =>
    route(String(input), init as RequestInit | undefined),
  );
}

function renderCards(prs: { url: string }[], sessionId = "s1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AePrCards sessionId={sessionId} prs={prs} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(authenticatedFetch).mockReset();
});

afterEach(cleanup);

describe("parseAePrUrl", () => {
  it("reads github.com pull request URLs only", () => {
    expect(parseAePrUrl(url(12))).toEqual({ repo: REPO, number: 12 });
    expect(parseAePrUrl("https://github.com/Owner/Repo/pull/3/")).toEqual({
      repo: "owner/repo",
      number: 3,
    });
    expect(parseAePrUrl("https://ghe.example/o/r/pull/3")).toBeNull();
    expect(parseAePrUrl("https://github.com/o/r/issues/3")).toBeNull();
    expect(parseAePrUrl("https://github.com/../r/pull/3")).toBeNull();
  });
});

describe("AePrCards", () => {
  it("renders nothing without a github.com pull request", () => {
    const { container } = renderCards([{ url: "https://gitlab.com/a/b/pull/1" }]);
    expect(container.firstChild).toBeNull();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it("shows title, branch, CI counts, mergeability and review on a card per PR", async () => {
    serve((path) =>
      path.endsWith("/5")
        ? json(card(5))
        : json(card(6, { review: { ...card(6).review, state: "review_required" } })),
    );
    renderCards([{ url: url(5) }, { url: url(6) }, { url: url(5) }]);
    const cards = await screen.findAllByTestId("ae-pr-card");
    expect(cards).toHaveLength(2);
    await waitFor(() => expect(within(cards[0]).getByText("PR 5")).toBeTruthy());
    expect(within(cards[0]).getByText(`${REPO} · claude/branch-5 → main`)).toBeTruthy();
    const chips = within(cards[0]).getByTestId("ae-pr-chips");
    expect([...chips.children].map((chip) => chip.textContent)).toEqual([
      "CI 6/6 passing",
      "no conflicts",
      "approved",
    ]);
    expect(within(cards[0]).getByRole("link").getAttribute("href")).toBe(url(5));
    await waitFor(() => expect(within(cards[1]).getByText("review requested")).toBeTruthy());
    expect(authenticatedFetch).toHaveBeenCalledWith(`/v1/ae/prs/${REPO}/5`, { method: "GET" });
  });

  it("disables Merge with the server's reason when the gate is shut", async () => {
    serve(() =>
      json(
        card(7, {
          ci: { state: "failing", passing: 5, failing: 1, pending: 0, total: 6 },
          merge: {
            methods: ["squash"],
            default_method: "squash",
            allowed: false,
            reason: "CI is failing: 1 of 6 checks.",
          },
        }),
      ),
    );
    renderCards([{ url: url(7) }]);
    const merge = await screen.findByRole("button", { name: "Merge" });
    expect((merge as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("ae-pr-why").textContent).toBe("CI is failing: 1 of 6 checks.");
  });

  it("confirms with the method, merges pinned to the SHA, then offers review", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    serve((path, init) => {
      calls.push({ path, init });
      if (path.endsWith("/merge")) {
        return json({
          merged: true,
          repo: REPO,
          number: 8,
          method: "merge",
          sha: "m3rg3d0000",
          message: "Pull Request successfully merged",
          session: { id: "s1", status: "working", offer_review: true },
        });
      }
      if (path === "/v1/sessions/s1") return json({ id: "s1" });
      return json(card(8));
    });
    renderCards([{ url: url(8) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    const group = screen.getByRole("group", { name: "Confirm merge" });
    expect(group.textContent).toContain("Squash and merge #8 into main?");
    fireEvent.click(within(group).getByRole("radio", { name: "Merge commit" }));
    expect(group.textContent).toContain("Merge commit #8 into main?");
    fireEvent.click(within(group).getByRole("button", { name: "Confirm merge" }));
    const done = await screen.findByRole("status");
    expect(done.textContent).toContain("Merged #8 (merge commit), m3rg3d0.");
    const merge = calls.find((call) => call.path.endsWith("/merge"))!;
    expect(merge.path).toBe(`/v1/ae/prs/${REPO}/8/merge`);
    expect(merge.init?.method).toBe("POST");
    expect(JSON.parse(String(merge.init?.body))).toEqual({
      sha: SHA,
      method: "merge",
      session_id: "s1",
    });
    fireEvent.click(screen.getByTestId("ae-pr-set-review"));
    await screen.findByText("This session is in review.");
    const patch = calls.find((call) => call.path === "/v1/sessions/s1")!;
    expect(patch.init?.method).toBe("PATCH");
    expect(JSON.parse(String(patch.init?.body))).toEqual({ labels: { "ae.status": "review" } });
  });

  it("Cancel closes the confirm step without a request", async () => {
    serve(() => json(card(9)));
    renderCards([{ url: url(9) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm merge" })).toBeNull();
    expect(
      vi.mocked(authenticatedFetch).mock.calls.every(([path]) => !String(path).endsWith("/merge")),
    ).toBe(true);
  });

  it("a refused merge says why and swaps in the fresh card", async () => {
    const moved = card(10, {
      ci: { state: "pending", passing: 5, failing: 0, pending: 1, total: 6 },
      merge: {
        methods: ["squash"],
        default_method: "squash",
        allowed: false,
        reason: "CI is still running: 1 of 6 checks.",
      },
    });
    serve((path) =>
      path.endsWith("/merge")
        ? json(
            {
              error: {
                code: "merge_blocked",
                message: "CI is still running: 1 of 6 checks.",
                card: moved,
              },
            },
            409,
          )
        : json(card(10, { merge: { ...card(10).merge, methods: ["squash"] } })),
    );
    renderCards([{ url: url(10) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm merge" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Not merged: CI is still running: 1 of 6 checks.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("CI 1 running of 6")).toBeTruthy();
  });

  it("says once that Merge is off without a GitHub token", async () => {
    serve(() => json({ error: { code: "github_not_configured", message: "no token" } }, 503));
    renderCards([{ url: url(1) }, { url: url(2) }]);
    expect((await screen.findAllByTestId("ae-pr-off")).length).toBe(1);
    expect(screen.queryAllByTestId("ae-pr-card")).toHaveLength(0);
  });
});
