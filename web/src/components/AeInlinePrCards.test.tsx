import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { authenticatedFetch } from "@/lib/identity";
import { type AePrCard, aePrUrlsIn } from "@/lib/aePrs";
import { AE_PR_POLL_MS } from "./AePrCards";
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
    // Compact: the repo and number only, no branch line (2026-10-14).
    expect(within(inline).getByTestId("ae-pr-meta").textContent).toBe("omnigent-ae #41");
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
    fireEvent.click(screen.getByRole("button", { name: "Squash into main" }));
    const done = await screen.findByRole("status");
    expect(done.textContent).toContain("Merged (squashed) abcdef1");
    expect(done.textContent).not.toContain("Pull Request successfully merged");
    const merge = calls.find((call) => call.path.endsWith("/merge"))!;
    expect(JSON.parse(String(merge.init?.body))).toEqual({
      sha: SHA,
      method: "squash",
      session_id: "s1",
    });
    expect((await screen.findByTestId("ae-pr-set-review")).textContent).toBe("Mark session done");
  });

  it("does not offer review while another tracked pull request is open (2026-09-25)", async () => {
    vi.mocked(authenticatedFetch).mockImplementation((input) => {
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
      return json(card(Number(String(input).split("/").pop())));
    });
    renderText(`Opened ${url(41)}`, [url(41), url(42)]);
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Squash into main" }));
    expect((await screen.findByTestId("ae-pr-more-open")).textContent).toBe(
      "1 more open pull request in this session.",
    );
    expect(screen.queryByTestId("ae-pr-set-review")).toBeNull();
  });

  describe("merged and closed pull requests (2026-10-20)", () => {
    const states = new Map<number, AePrCard["state"]>();
    const respond = (input: unknown) => {
      const number = Number(String(input).split("/").pop());
      return json({ ...card(number), state: states.get(number) ?? "open" });
    };

    beforeEach(() => {
      states.clear();
    });

    it("folds every merged and closed pull request into one row", async () => {
      states.set(167, "merged").set(161, "merged").set(169, "closed");
      vi.mocked(authenticatedFetch).mockImplementation(respond);
      renderText(`Done: ${url(167)}, ${url(161)}, ${url(169)}.`);
      const toggle = await screen.findByTestId("ae-pr-fold-toggle");
      expect(toggle.textContent).toBe("2 merged, 1 closed");
      expect(screen.getByTestId("ae-pr-fold").textContent).toBe(
        "2 merged, 1 closed#167#161#169omnigent-ae",
      );
      expect(screen.queryByTestId("ae-pr-inline")).toBeNull();
      expect(screen.queryByTestId("ae-pr-fold-line")).toBeNull();

      fireEvent.click(toggle);
      const lines = screen.getAllByTestId("ae-pr-fold-line");
      expect(lines.map((line) => line.textContent)).toEqual([
        "PR 167#167Open on GitHub",
        "PR 161#161Open on GitHub",
        "PR 169#169Open on GitHub",
      ]);

      fireEvent.click(within(lines[0]).getByRole("button"));
      const full = await within(lines[0]).findByTestId("ae-pr-inline");
      expect(within(full).getByTestId("ae-pr-merged").textContent).toBe("Merged");
    });

    it("links each number in the row, with the chat's preview, without opening the fold", async () => {
      states.set(173, "merged").set(172, "merged");
      vi.mocked(authenticatedFetch).mockImplementation(respond);
      renderText(`Done: ${url(173)}, ${url(172)}.`);
      await screen.findByTestId("ae-pr-fold-toggle");
      const chips = screen.getAllByTestId("ae-pr-fold-chip");
      expect(chips.map((chip) => chip.tagName)).toEqual(["A", "A"]);
      expect(chips[0]).toHaveAttribute("href", url(173));
      expect(chips[0]).toHaveAttribute("target", "_blank");
      // One line on a phone: the numbers scroll sideways rather than wrap.
      const row = screen.getByTestId("ae-pr-fold-chips");
      expect(row).not.toHaveClass("flex-wrap");
      expect(row).toHaveClass("overflow-x-auto");
      expect(chips[0]).toHaveClass("shrink-0", "whitespace-nowrap");

      fireEvent.click(chips[0]);
      expect(screen.getByTestId("ae-pr-fold-toggle")).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("ae-pr-fold-line")).toBeNull();

      fireEvent.focus(chips[0]);
      const preview = await screen.findByTestId("ae-pr-hover");
      expect(preview).toHaveAttribute("data-pr-state", "merged");
      expect(preview).toHaveTextContent(`${REPO}#173`);
      expect(preview).toHaveTextContent("PR 173");
    });

    it("gives each opened line a caret that turns down while its card is open", async () => {
      states.set(167, "merged");
      vi.mocked(authenticatedFetch).mockImplementation(respond);
      renderText(`Done: ${url(167)}.`);
      fireEvent.click(await screen.findByTestId("ae-pr-fold-toggle"));
      const line = screen.getByTestId("ae-pr-fold-line");
      const button = within(line).getByRole("button");
      // Chevron-right, turned a quarter to point down (the header's caret does the same).
      const caret = () => button.querySelector("svg")!;
      expect(button).toHaveAttribute("aria-expanded", "false");
      expect(caret().querySelector("path")).toHaveAttribute("d", "M9 6l6 6l-6 6");
      expect(caret()).not.toHaveClass("rotate-90");
      expect(caret()).toHaveClass("size-4", "text-muted-foreground");

      fireEvent.click(button);
      expect(button).toHaveAttribute("aria-expanded", "true");
      expect(caret()).toHaveClass("rotate-90");
      await within(line).findByTestId("ae-pr-inline");
    });

    it("keeps an open pull request's full card, with Merge, above the fold", async () => {
      states.set(167, "merged");
      vi.mocked(authenticatedFetch).mockImplementation(respond);
      renderText(`Open: ${url(171)}. Merged: ${url(167)}.`);
      const inline = await screen.findByTestId("ae-pr-inline");
      expect(inline.getAttribute("data-pr")).toBe(url(171));
      expect(within(inline).getByRole("button", { name: "Merge" })).toBeTruthy();
      expect((await screen.findByTestId("ae-pr-fold-toggle")).textContent).toContain("1 merged");
    });

    it("leaves a card merged from this view unfolded, with its merged note", async () => {
      vi.mocked(authenticatedFetch).mockImplementation((input) => {
        if (String(input).endsWith("/merge")) {
          states.set(41, "merged");
          return json({
            merged: true,
            repo: REPO,
            number: 41,
            method: "squash",
            sha: "abcdef1234",
            message: "Pull Request successfully merged",
            session: { id: "s1", status: "working", offer_review: false },
          });
        }
        return respond(input);
      });
      renderText(`Opened ${url(41)}`, [url(41)]);
      fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
      fireEvent.click(screen.getByRole("button", { name: "Squash into main" }));
      expect((await screen.findByRole("status")).textContent).toContain("Merged (squashed)");
      await vi.waitFor(() =>
        expect(
          vi
            .mocked(authenticatedFetch)
            .mock.calls.filter(([path]) => path === `/v1/ae/prs/${REPO}/41`).length,
        ).toBeGreaterThan(1),
      );
      expect(screen.queryByTestId("ae-pr-fold")).toBeNull();
      expect(screen.getByTestId("ae-pr-inline")).toBeTruthy();
    });

    describe("on the 30 s poll", () => {
      beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
      afterEach(() => vi.useRealTimers());

      it("folds a pull request merged somewhere else while the card shows", async () => {
        vi.mocked(authenticatedFetch).mockImplementation(respond);
        renderText(`Opened ${url(41)}`);
        await screen.findByTestId("ae-pr-inline");
        states.set(41, "merged");
        await vi.advanceTimersByTimeAsync(AE_PR_POLL_MS);
        expect((await screen.findByTestId("ae-pr-fold-toggle")).textContent).toContain("1 merged");
        expect(screen.queryByTestId("ae-pr-inline")).toBeNull();
      });

      it("unfolds a closed pull request that is reopened", async () => {
        states.set(9, "closed");
        vi.mocked(authenticatedFetch).mockImplementation(respond);
        renderText(`Closed ${url(9)}`);
        expect((await screen.findByTestId("ae-pr-fold-toggle")).textContent).toContain("1 closed");
        states.delete(9);
        await vi.advanceTimersByTimeAsync(AE_PR_POLL_MS);
        expect(await screen.findByTestId("ae-pr-inline")).toBeTruthy();
        expect(screen.queryByTestId("ae-pr-fold")).toBeNull();
      });
    });

    it("names the repo beside each number when the fold spans two repos", async () => {
      vi.mocked(authenticatedFetch).mockImplementation((input) => {
        const [, repo, number] = /prs\/(.+)\/(\d+)$/.exec(String(input))!;
        return json({ ...card(Number(number)), repo, state: "merged" });
      });
      renderText(`Done: ${url(12)} and ${url(12, "o/site")}.`);
      const fold = await screen.findByTestId("ae-pr-fold");
      await vi.waitFor(() => expect(fold.textContent).toBe("2 mergedomnigent-ae #12site #12"));
    });
  });
});
