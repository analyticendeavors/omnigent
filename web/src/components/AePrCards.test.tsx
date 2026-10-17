import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { authenticatedFetch } from "@/lib/identity";
import { type AePrCard, parseAePrUrl } from "@/lib/aePrs";
import { AePrCards, AePrCardView } from "./AePrCards";

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

function renderCards(
  prs: { url: string }[],
  sessionId = "s1",
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
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

  // 2026-10-14: a card whose Merge is live says so in one line; the state
  // leads the header and the repo and number sit beside the title.
  it("shows the state, title, repo, branch and one Ready line when Merge is live", async () => {
    serve((path) =>
      path.endsWith("/5")
        ? json(card(5))
        : json(card(6, { review: { ...card(6).review, state: "review_required" } })),
    );
    renderCards([{ url: url(5) }, { url: url(6) }, { url: url(5) }]);
    const cards = await screen.findAllByTestId("ae-pr-card");
    expect(cards).toHaveLength(2);
    await waitFor(() => expect(within(cards[0]).getByText("PR 5")).toBeTruthy());
    const link = within(cards[0]).getByRole("link");
    expect(link.getAttribute("href")).toBe(url(5));
    // The panel's card names the branches on the repo's line, one row, not two.
    const meta = within(cards[0]).getByTestId("ae-pr-meta");
    expect(within(meta).getByText("omnigent-ae #5")).toBeTruthy();
    expect(within(meta).getByText("claude/branch-5 → main")).toBeTruthy();
    expect(meta.getAttribute("title")).toBe(REPO);
    expect(link.contains(meta)).toBe(true);
    const state = within(cards[0]).getByTestId("ae-pr-state");
    expect(state.getAttribute("data-pr-state")).toBe("open");
    expect(state.textContent).toBe("Open pull request");
    const words = (line: HTMLElement) =>
      [...line.children].filter((part) => part.tagName === "SPAN").map((part) => part.textContent);
    expect(words(within(cards[0]).getByTestId("ae-pr-ready"))).toEqual([
      "Ready to merge",
      "· 6/6 checks",
      "· Approved",
    ]);
    expect(within(cards[0]).queryByTestId("ae-pr-chips")).toBeNull();
    await waitFor(() =>
      expect(words(within(cards[1]).getByTestId("ae-pr-ready"))).toEqual([
        "Ready to merge",
        "· 6/6 checks",
        "· Review requested",
      ]),
    );
    expect(authenticatedFetch).toHaveBeenCalledWith(`/v1/ae/prs/${REPO}/5`, { method: "GET" });
  });

  it("disables Merge with the server's reason when the gate is shut", async () => {
    serve(() =>
      json(
        card(7, {
          ci: { state: "failing", passing: 5, failing: 1, pending: 0, total: 6 },
          mergeable: { state: "conflicted", detail: "Conflicts with the base branch." },
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
    expect(screen.queryByTestId("ae-pr-ready")).toBeNull();
    const chips = [...screen.getByTestId("ae-pr-chips").children] as HTMLElement[];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "1 of 6 checks failing",
      "Conflicts",
      "Approved",
    ]);
    expect(chips.map((chip) => chip.dataset.tone)).toEqual(["err", "err", "ok"]);
    // 2026-10-14: an outlined chip read as a button; only a problem is tinted.
    expect(chips.some((chip) => chip.className.includes("border"))).toBe(false);
    expect(chips[0].className).toContain("bg-destructive/10");
    expect(chips[2].className).not.toContain("bg-destructive/10");
    expect(chips[1].getAttribute("title")).toBe("Conflicts with the base branch.");
    // P26: the chips, the reason and the disabled Merge share one status row,
    // the button compact (32 px, 40 px on touch) at the row's end.
    const row = screen.getByTestId("ae-pr-status-row");
    expect(row.contains(screen.getByTestId("ae-pr-chips"))).toBe(true);
    expect(row.contains(screen.getByTestId("ae-pr-why"))).toBe(true);
    expect(row.contains(merge)).toBe(true);
    expect(merge.className).toContain("h-8");
    expect(merge.className).toContain("pointer-coarse:h-10");
    expect(merge.className).toContain("ml-auto");
    expect(merge.className).not.toContain("h-11");
    expect(merge.className).not.toContain("w-full");
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
    // 2026-10-14: the button names the method and the base, the old question's job.
    expect(within(group).getByRole("button", { name: "Squash into main" })).toBeTruthy();
    fireEvent.click(within(group).getByRole("radio", { name: "Merge commit" }));
    fireEvent.click(within(group).getByRole("button", { name: "Merge into main" }));
    const done = await screen.findByRole("status");
    // P26: short and on the status row, without GitHub's echo; purple since 2026-10-14.
    const merged = screen.getByTestId("ae-pr-merged");
    expect(merged.textContent).toBe("Merged (merge commit) m3rg3d0");
    expect(merged.className).toContain("text-purple-700");
    expect(done.textContent).not.toContain("successfully merged");
    expect(screen.getByTestId("ae-pr-status-row").contains(done)).toBe(true);
    // The Ready line spoke for the open pull request; the merged one drops it.
    expect(screen.queryByTestId("ae-pr-ready")).toBeNull();
    expect(screen.queryByTestId("ae-pr-chips")).toBeNull();
    expect(screen.getByTestId("ae-pr-state").getAttribute("data-pr-state")).toBe("merged");
    const merge = calls.find((call) => call.path.endsWith("/merge"))!;
    expect(merge.path).toBe(`/v1/ae/prs/${REPO}/8/merge`);
    expect(merge.init?.method).toBe("POST");
    expect(JSON.parse(String(merge.init?.body))).toEqual({
      sha: SHA,
      method: "merge",
      session_id: "s1",
    });
    const markDone = screen.getByRole("button", { name: "Mark session done" });
    expect(markDone.getAttribute("title")).toBe(
      "Set this session's status to Review (done), which frees one of your slots",
    );
    fireEvent.click(markDone);
    await screen.findByText("Session marked done. Its slot is free.");
    const patch = calls.find((call) => call.path === "/v1/sessions/s1")!;
    expect(patch.init?.method).toBe("PATCH");
    expect(JSON.parse(String(patch.init?.body))).toEqual({ labels: { "ae.status": "review" } });
  });

  // 2026-09-25: a session with four pull requests offered review after the
  // first merge. Review waits for the session's last open one (patch P20).
  function serveMerge(states: Record<number, AePrCard["state"]>) {
    serve((path) => {
      const merged = /\/(\d+)\/merge$/.exec(path);
      if (merged) {
        return json({
          merged: true,
          repo: REPO,
          number: Number(merged[1]),
          method: "squash",
          sha: "m3rg3d0000",
          message: "Pull Request successfully merged",
          session: { id: "s1", status: "working", offer_review: true },
        });
      }
      const number = Number(path.split("/").pop());
      return json(card(number, { state: states[number] ?? "open" }));
    });
  }

  it("holds review back while other tracked pull requests are open", async () => {
    serveMerge({});
    renderCards([{ url: url(11) }, { url: url(12) }, { url: url(13) }, { url: url(14) }]);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Merge" })).toHaveLength(4));
    const first = screen.getAllByTestId("ae-pr-card")[0];
    fireEvent.click(within(first).getByRole("button", { name: "Merge" }));
    fireEvent.click(within(first).getByRole("button", { name: "Squash into main" }));
    expect((await within(first).findByRole("status")).textContent).toContain("Merged (squashed)");
    const more = await within(first).findByTestId("ae-pr-more-open");
    expect(more.textContent).toBe("3 more open pull requests in this session.");
    // P26: the note sits inline on the status row, not on a row of its own.
    expect(more.tagName).toBe("SPAN");
    expect(within(first).getByTestId("ae-pr-status-row").contains(more)).toBe(true);
    expect(screen.queryByTestId("ae-pr-set-review")).toBeNull();
  });

  it("offers review after the last open tracked pull request merges", async () => {
    serveMerge({ 11: "merged", 12: "closed" });
    renderCards([{ url: url(11) }, { url: url(12) }, { url: url(13) }]);
    const last = (await screen.findAllByTestId("ae-pr-card"))[2];
    fireEvent.click(await within(last).findByRole("button", { name: "Merge" }));
    fireEvent.click(within(last).getByRole("button", { name: "Squash into main" }));
    const offer = await within(last).findByTestId("ae-pr-set-review");
    // 2026-09-26: plain words, an outline button (it is optional), and the
    // hint on screen for a phone, where the tooltip never shows.
    expect(offer.textContent).toBe("Mark session done");
    expect(offer.className).toContain("border-border");
    expect(offer.className).not.toContain("bg-primary");
    const hint = document.getElementById(offer.getAttribute("aria-describedby")!);
    expect(hint?.textContent).toBe("frees a slot");
    expect(screen.queryByTestId("ae-pr-more-open")).toBeNull();
  });

  it("exposes the chosen method as the checked radio of one group", async () => {
    serve(() => json(card(15)));
    renderCards([{ url: url(15) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    const group = screen.getByRole("radiogroup", { name: "Merge method" });
    const radios = within(group).getAllByRole("radio");
    // Short labels on the toggle (2026-09-26); the confirm button names the method.
    expect(radios.map((radio) => radio.textContent)).toEqual(["Squash", "Merge commit"]);
    const checked = () =>
      within(group)
        .getAllByRole("radio", { checked: true })
        .map((radio) => radio.textContent);
    expect(checked()).toEqual(["Squash"]);
    fireEvent.click(within(group).getByRole("radio", { name: "Merge commit" }));
    expect(checked()).toEqual(["Merge commit"]);
    expect(within(group).getByRole("radio", { name: "Squash" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  // 2026-09-28: Reid asked the confirm step to say which method to use.
  describe("the recommended method", () => {
    const PROMOTE =
      "Merge commit keeps dev and main in step; a squash would make the next promotion conflict.";
    const promotion = (number: number) =>
      card(number, {
        head_ref: "dev",
        merge: {
          methods: ["squash", "merge"],
          default_method: "merge",
          recommended_method: "merge",
          recommended_reason: PROMOTE,
          allowed: true,
          reason: null,
        },
      });

    it("opens on it and leads the reason line with Recommended", async () => {
      serve(() => json(promotion(21)));
      renderCards([{ url: url(21) }]);
      fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
      const group = screen.getByRole("group", { name: "Confirm merge" });
      const methods = within(group).getByRole("radiogroup", { name: "Merge method" });
      const chosen = within(methods).getByRole("radio", { checked: true });
      // 2026-10-14: no tag inside the segment; the reason stays its tooltip.
      expect(chosen.textContent).toBe("Merge commit");
      expect(chosen.getAttribute("title")).toBe(PROMOTE);
      expect(within(group).getByRole("button", { name: "Merge into main" })).toBeTruthy();
      const why = within(group).getByTestId("ae-pr-recommended-why");
      expect(why.textContent).toBe(`Recommended · ${PROMOTE}`);
      expect(why.className).toContain("text-muted-foreground");
      expect(group.firstElementChild).toBe(why);
    });

    it("still merges with the other method when it is picked", async () => {
      const calls: { path: string; init?: RequestInit }[] = [];
      serve((path, init) => {
        calls.push({ path, init });
        if (path.endsWith("/merge")) {
          return json({
            merged: true,
            repo: REPO,
            number: 22,
            method: "squash",
            sha: "5qu45h0000",
            message: "Pull Request successfully merged",
            session: null,
          });
        }
        return json(promotion(22));
      });
      renderCards([{ url: url(22) }]);
      fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
      const group = screen.getByRole("group", { name: "Confirm merge" });
      fireEvent.click(within(group).getByRole("radio", { name: "Squash" }));
      expect(within(group).getByRole("radio", { checked: true }).textContent).toBe("Squash");
      // The reason stays on the recommendation; the button follows the pick.
      expect(within(group).getByTestId("ae-pr-recommended-why").textContent).toBe(
        `Recommended · ${PROMOTE}`,
      );
      expect(within(group).getByRole("radio", { name: "Merge commit" }).getAttribute("title")).toBe(
        PROMOTE,
      );
      fireEvent.click(within(group).getByRole("button", { name: "Squash into main" }));
      await screen.findByRole("status");
      const merge = calls.find((call) => call.path.endsWith("/merge"))!;
      expect(JSON.parse(String(merge.init?.body))).toEqual({
        sha: SHA,
        method: "squash",
        session_id: "s1",
      });
    });

    it("shows no reason line for a card without a recommendation", async () => {
      serve(() => json(card(23)));
      renderCards([{ url: url(23) }]);
      fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
      expect(screen.getByRole("radio", { checked: true }).textContent).toBe("Squash");
      expect(screen.queryByTestId("ae-pr-recommended-why")).toBeNull();
      expect(screen.getByRole("group", { name: "Confirm merge" }).textContent).not.toContain(
        "Recommended",
      );
    });

    it("gives the reason alone when the repo allows one method", async () => {
      const ONLY = "The only method this repo allows.";
      serve(() =>
        json(
          card(24, {
            merge: {
              methods: ["merge"],
              default_method: "merge",
              recommended_method: "merge",
              recommended_reason: ONLY,
              allowed: true,
              reason: null,
            },
          }),
        ),
      );
      renderCards([{ url: url(24) }]);
      fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
      expect(screen.getByTestId("ae-pr-recommended-why").textContent).toBe(ONLY);
      expect(screen.getByRole("button", { name: "Merge into main" })).toBeTruthy();
    });
  });

  // 2026-09-26: Reid saw the method buttons on one row and Confirm and Cancel
  // on a second, on a 1100 px card. Now all three sit in one wrapping row, the
  // two buttons together at its right end (2026-10-14).
  it("puts the method toggle, Cancel and the confirm button in one row", async () => {
    serve(() => json(card(17)));
    renderCards([{ url: url(17) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    const group = screen.getByRole("group", { name: "Confirm merge" });
    // A section of the card under one divider, not a box inside it.
    expect(group.className).toContain("border-t");
    expect(group.className).not.toContain("rounded");
    const row = within(group).getByTestId("ae-pr-confirm-row");
    expect(row.className).toContain("flex-wrap");
    expect(row.className).not.toContain("flex-col");
    const [toggle, buttons, ...rest] = [...row.children];
    expect(rest).toHaveLength(0);
    expect(toggle.getAttribute("role")).toBe("radiogroup");
    expect([...buttons.children].map((button) => button.textContent)).toEqual([
      "Cancel",
      "Squash into main",
    ]);
    // Cancel stays compact; the confirm button, whose label names the branch,
    // takes the rest of a narrow row (review, 2026-10-14).
    const [cancel, confirm] = [...buttons.children];
    expect(cancel.className).toContain("flex-none");
    expect(cancel.className).not.toContain("flex-1");
    expect(confirm.className).toContain("flex-1");
  });

  it("names the method alone when the base branch is unknown", async () => {
    serve(() => json(card(19, { base_ref: null })));
    renderCards([{ url: url(19) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    expect(screen.getByRole("button", { name: "Squash and merge" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Merge commit" }));
    expect(screen.getByRole("button", { name: "Create merge commit" })).toBeTruthy();
  });

  it("locks the method while the merge is in flight", async () => {
    let finish: (response: Response) => void = () => undefined;
    serve((path) =>
      path.endsWith("/merge")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : json(card(18)),
    );
    renderCards([{ url: url(18) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    const group = screen.getByRole("radiogroup", { name: "Merge method" });
    fireEvent.click(screen.getByRole("button", { name: "Squash into main" }));
    await waitFor(() =>
      expect(within(group).getByRole("radio", { name: "Merge commit" })).toBeDisabled(),
    );
    expect(within(group).getByRole("radio", { name: "Squash" })).toBeDisabled();
    fireEvent.click(within(group).getByRole("radio", { name: "Merge commit" }));
    expect(within(group).getByRole("radio", { name: "Squash" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    finish(new Response(JSON.stringify({ error: { message: "stop" } }), { status: 409 }));
    await waitFor(() => expect(within(group).getByRole("radio", { name: "Squash" })).toBeEnabled());
  });

  it("hides the method choice when the repository allows one method", async () => {
    serve(() => json(card(16, { merge: { ...card(16).merge, methods: ["squash"] } })));
    renderCards([{ url: url(16) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    expect(screen.getByRole("group", { name: "Confirm merge" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    const row = screen.getByTestId("ae-pr-confirm-row");
    expect(
      within(row)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Squash into main"]);
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
        reason: "CI is still running: 5 of 6 checks passed, 1 to go.",
      },
    });
    serve((path) =>
      path.endsWith("/merge")
        ? json(
            {
              error: {
                code: "merge_blocked",
                message: "CI is still running: 5 of 6 checks passed, 1 to go.",
                card: moved,
              },
            },
            409,
          )
        : json(card(10, { merge: { ...card(10).merge, methods: ["squash"] } })),
    );
    renderCards([{ url: url(10) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Squash into main" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Not merged: CI is still running: 5 of 6 checks passed, 1 to go.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("5/6 passed, 1 running").dataset.tone).toBe("wait");
  });

  it("says Merged or Closed, with no chips and no Merge, once GitHub closed it", async () => {
    const shut = (number: number, state: "merged" | "closed", reason: string) =>
      card(number, {
        state,
        mergeable: { state, detail: `The pull request is ${state}.` },
        merge: { ...card(number).merge, allowed: false, reason },
      });
    serve((path) =>
      json(
        path.endsWith("/31")
          ? shut(31, "merged", "Already merged.")
          : shut(32, "closed", "Closed without merging."),
      ),
    );
    renderCards([{ url: url(31) }, { url: url(32) }]);
    const [merged, closed] = await screen.findAllByTestId("ae-pr-card");
    await waitFor(() =>
      expect(within(merged).getByTestId("ae-pr-merged").textContent).toBe("Merged"),
    );
    expect(within(merged).getByTestId("ae-pr-state").getAttribute("data-pr-state")).toBe("merged");
    await waitFor(() =>
      expect(within(closed).getByTestId("ae-pr-closed").textContent).toBe("Closed without merging"),
    );
    expect(within(closed).getByTestId("ae-pr-state").getAttribute("data-pr-state")).toBe("closed");
    expect(screen.queryByTestId("ae-pr-chips")).toBeNull();
    expect(screen.queryByTestId("ae-pr-ready")).toBeNull();
    expect(screen.queryByTestId("ae-pr-why")).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  // Review, 2026-10-14: before GitHub answers (or when the read failed) the
  // header claims no state: a muted icon named "Pull request", never open.
  it("claims no state while the card is loading or could not be read", async () => {
    serve(
      () =>
        new Promise<Response>(() => {
          // Never settles: the card stays at "Reading GitHub…".
        }),
    );
    renderCards([{ url: url(40) }]);
    await screen.findByText("Reading GitHub…");
    const loading = screen.getByTestId("ae-pr-state");
    expect(loading.getAttribute("data-pr-state")).toBe("unknown");
    expect(loading.textContent).toBe("Pull request");
    expect(loading.getAttribute("title")).toBe("Pull request");
    expect(loading.querySelector("svg")?.getAttribute("class")).toContain("text-muted-foreground");
    cleanup();
    serve(() => json({ error: { code: "github_error", message: "GitHub answered 502" } }, 502));
    renderCards([{ url: url(41) }]);
    await screen.findByRole("alert");
    expect(screen.getByTestId("ae-pr-state").getAttribute("data-pr-state")).toBe("unknown");
  });

  it("draws a draft with its own icon and a quiet Draft chip", async () => {
    const DRAFT = "Draft: mark it ready for review on GitHub first.";
    serve(() =>
      json(
        card(33, {
          draft: true,
          mergeable: { state: "draft", detail: DRAFT },
          merge: { ...card(33).merge, allowed: false, reason: DRAFT },
        }),
      ),
    );
    renderCards([{ url: url(33) }]);
    await screen.findByTestId("ae-pr-chips");
    expect(screen.getByTestId("ae-pr-state").getAttribute("data-pr-state")).toBe("draft");
    expect(screen.getByText("Draft").dataset.tone).toBe("muted");
  });

  it("says once that Merge is off without a GitHub token", async () => {
    serve(() => json({ error: { code: "github_not_configured", message: "no token" } }, 503));
    renderCards([{ url: url(1) }, { url: url(2) }]);
    expect((await screen.findAllByTestId("ae-pr-off")).length).toBe(1);
    expect(screen.queryAllByTestId("ae-pr-card")).toHaveLength(0);
  });
});

describe("in-app review", () => {
  it.each(["success", "stale head"])(
    "keeps the %s card when an older GET finishes afterward",
    async (outcome) => {
      const key = ["ae-pr", REPO, 5];
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const draft = card(5, {
        draft: true,
        merge: { ...card(5).merge, allowed: false, reason: "Draft" },
      });
      const fresh = card(5, { head_sha: outcome === "success" ? SHA : "f".repeat(40) });
      let getCount = 0;
      let finishOldGet: ((response: Response) => void) | undefined;
      const oldGet = new Promise<Response>((resolve) => {
        finishOldGet = resolve;
      });
      serve((path) => {
        if (path.endsWith("/ready")) {
          return outcome === "success"
            ? json(fresh)
            : json(
                { error: { code: "merge_head_moved", message: "Head moved", card: fresh } },
                409,
              );
        }
        if (path.endsWith("/5")) return ++getCount === 1 ? json(draft) : oldGet;
        throw new Error(`Unexpected request ${path}`);
      });
      renderCards([{ url: url(5) }], "s1", qc);
      await screen.findByRole("button", { name: "Mark ready for review" });
      void qc.invalidateQueries({ queryKey: key, exact: true });
      await waitFor(() => expect(getCount).toBe(2));
      fireEvent.click(screen.getByRole("button", { name: "Mark ready for review" }));
      await waitFor(() => expect(qc.getQueryData(key)).toEqual(fresh));
      await act(async () => {
        finishOldGet?.(new Response(JSON.stringify(draft)));
        await oldGet;
      });
      expect(qc.getQueryData(key)).toEqual(fresh);
      expect(screen.queryByRole("button", { name: "Mark ready for review" })).toBeNull();
    },
  );

  it("shows the description and marks a draft ready without merging", async () => {
    const draft = card(5, {
      draft: true,
      body: "Change summary\nValidation: tests passed",
      changed_files: 2,
      additions: 10,
      deletions: 3,
      merge: { methods: ["squash"], default_method: "squash", allowed: false, reason: "Draft" },
    });
    let request: RequestInit | undefined;
    serve((path, init) => {
      if (path.endsWith("/ready")) {
        request = init;
        return json(card(5));
      }
      if (path.endsWith("/5")) return json(draft);
      throw new Error(`Unexpected request ${path}`);
    });
    renderCards([{ url: url(5) }]);
    await screen.findByText("Review details");
    fireEvent.click(screen.getByText("Review details"));
    expect(await screen.findByText(/Validation: tests passed/)).toBeTruthy();
    expect(screen.getByText(/2 files/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark ready for review" }));
    await waitFor(() => expect(request?.method).toBe("POST"));
    expect(JSON.parse(request?.body as string)).toEqual({ sha: SHA });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Mark ready for review" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled();
  });

  it("renders the description as markdown", async () => {
    serve(() =>
      json(card(5, { body: "## Validation\n- **pytest** passed\nsecond line\n\n`dist/` matches" })),
    );
    renderCards([{ url: url(5) }]);
    await screen.findByText("Review details");
    fireEvent.click(screen.getByText("Review details"));
    const body = await screen.findByTestId("ae-pr-body");
    expect(await within(body).findByRole("heading", { name: "Validation" })).toBeTruthy();
    expect(within(body).getByText("dist/").tagName).toBe("CODE");
    expect(within(body).getByRole("listitem").querySelector("br")).not.toBeNull();
    expect(body.textContent).not.toMatch(/##|\*\*/);
  });

  it("renders the description only once Review details opens", async () => {
    serve(() => json(card(5, { body: "## Validation" })));
    renderCards([{ url: url(5) }]);
    await screen.findByText("Review details");
    expect(screen.getByTestId("ae-pr-body").childElementCount).toBe(0);
  });

  it.each([
    ["keeps an unmatched marker in a finished description", "Trailing **Note", "Trailing **Note"],
    ["shows a huge description as plain text", `## Log\n${"x".repeat(6_000)}`, "## Log"],
  ])("%s", async (_name, body, shown) => {
    serve(() => json(card(5, { body })));
    renderCards([{ url: url(5) }]);
    await screen.findByText("Review details");
    fireEvent.click(screen.getByText("Review details"));
    const rendered = await screen.findByTestId("ae-pr-body");
    await waitFor(() => expect(rendered.textContent).toContain(shown));
    expect(within(rendered).queryByRole("heading")).toBeNull();
  });

  it("keeps a draft unchanged and shows a failed ready request", async () => {
    serve((path) =>
      path.endsWith("/ready")
        ? json(
            { error: { code: "head_changed", message: "The branch changed. Review it again." } },
            409,
          )
        : json(card(5, { draft: true })),
    );
    renderCards([{ url: url(5) }]);
    await screen.findByText("Review details");
    fireEvent.click(screen.getByText("Review details"));
    fireEvent.click(screen.getByRole("button", { name: "Mark ready for review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The branch changed");
    expect(screen.getByRole("button", { name: "Mark ready for review" })).toBeEnabled();
  });

  it("pins Update branch to the displayed SHA and waits for a changed revision after acceptance", async () => {
    const behind = card(5, { update_branch: { allowed: true, reason: null } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let accept!: (response: Response) => void;
    let request: RequestInit | undefined;
    serve((path, init) => {
      if (path.endsWith("/update-branch")) {
        request = init;
        return new Promise((resolve) => {
          accept = resolve;
        });
      }
      return json(behind);
    });
    renderCards([{ url: url(5) }], "s1", qc);
    fireEvent.click(await screen.findByRole("button", { name: "Update branch" }));
    await waitFor(() => expect(request?.method).toBe("POST"));
    expect(JSON.parse(request!.body as string)).toEqual({ sha: SHA });
    expect(await screen.findByRole("button", { name: "Updating branch..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
    await act(async () =>
      accept(
        new Response(JSON.stringify({ accepted: true, head_sha: SHA, message: "Accepted" }), {
          status: 202,
        }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Waiting for GitHub");
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
    act(() =>
      qc.setQueryData(["ae-pr", REPO, 5], {
        ...behind,
        head_sha: "b".repeat(40),
        update_branch: { allowed: false, reason: "Up to date" },
      }),
    );
    expect(await screen.findByText(/Branch revision changed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update branch" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled();
    expect(
      vi.mocked(authenticatedFetch).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("shows an update refusal and replaces a stale card before retry", async () => {
    const newSha = "b".repeat(40);
    const before = card(5, { update_branch: { allowed: true, reason: null } });
    const writes: string[] = [];
    serve((path, init) => {
      if (path.endsWith("/update-branch")) {
        writes.push(JSON.parse(init!.body as string).sha);
        return json(
          {
            error: {
              code: "head_moved",
              message: "New commits arrived. Review again.",
              card: { ...before, head_sha: newSha },
            },
          },
          409,
        );
      }
      return json(before);
    });
    renderCards([{ url: url(5) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Update branch" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("New commits arrived");
    fireEvent.click(screen.getByRole("button", { name: "Update branch" }));
    await waitFor(() => expect(writes).toEqual([SHA, newSha]));
  });

  it("shares update progress across inline and panel cards, including an open merge confirmation", async () => {
    const qc = new QueryClient();
    let accept!: (response: Response) => void;
    serve((path) =>
      path.endsWith("/update-branch")
        ? new Promise((resolve) => {
            accept = resolve;
          })
        : json(card(5, { update_branch: { allowed: true, reason: null } })),
    );
    render(
      <QueryClientProvider client={qc}>
        <AePrCardView repo={REPO} number={5} url={url(5)} />
        <AePrCardView repo={REPO} number={5} url={url(5)} variant="inline" />
      </QueryClientProvider>,
    );
    const panel = await screen.findByTestId("ae-pr-card");
    const inline = await screen.findByTestId("ae-pr-inline");
    fireEvent.click(within(panel).getByRole("button", { name: "Merge" }));
    expect(within(panel).getByRole("button", { name: "Squash into main" })).toBeEnabled();
    fireEvent.click(within(inline).getByRole("button", { name: "Update branch" }));
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: "Squash into main" })).toBeDisabled(),
    );
    await act(async () =>
      accept(
        new Response(JSON.stringify({ accepted: true, head_sha: SHA, message: "Accepted" }), {
          status: 202,
        }),
      ),
    );
    await waitFor(() =>
      expect(within(panel).getByRole("status")).toHaveTextContent("Waiting for GitHub"),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(within(panel).getByRole("button", { name: "Updating branch..." })).toBeDisabled();
    expect(within(panel).getByRole("button", { name: "Merge" })).toBeDisabled();
  });

  it("does not offer an enabled branch update when conflicts prevent it", async () => {
    serve(() =>
      json(card(5, { update_branch: { allowed: false, reason: "Resolve conflicts first." } })),
    );
    renderCards([{ url: url(5) }]);
    const button = await screen.findByRole("button", { name: "Update branch" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Resolve conflicts first.");
  });

  it("offers a read-only status check after a slow update instead of repeating the write", async () => {
    const behind = card(5, { update_branch: { allowed: true, reason: null } });
    let writes = 0;
    serve((path) => {
      if (path.endsWith("/update-branch")) {
        writes++;
        return json({ accepted: true, head_sha: SHA, message: "Accepted" }, 202);
      }
      return json(behind);
    });
    renderCards([{ url: url(5) }]);
    await screen.findByRole("button", { name: "Update branch" });
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Update branch" }));
        await vi.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      expect(screen.getByRole("button", { name: "Check update" })).toBeEnabled();
      expect(screen.getByRole("status")).toHaveTextContent("not confirmed a new revision");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Check update" }));
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(writes).toBe(1);
      expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("loads the full compliance report only when its separate disclosure opens", async () => {
    const report = {
      body: "## AE Compliance Review\n\n**APPROVED**\n\n### Compliance checks\n\n- `tracking.js` present\n\nFinal finding: preserved",
      verdict: "approved",
      url: `${url(5)}#issuecomment-123`,
      updated_at: "2026-10-17T12:00:00Z",
      reviewed_sha: null,
      revision: "unknown",
    };
    serve((path) => (path.includes("/compliance") ? json({ report }) : json(card(5))));
    renderCards([{ url: url(5) }]);
    const summary = await screen.findByText("AE compliance review");
    expect(
      vi
        .mocked(authenticatedFetch)
        .mock.calls.some(([path]) => String(path).includes("/compliance")),
    ).toBe(false);
    fireEvent.click(summary);
    expect(await screen.findByText(/Approval for this revision is unverified/)).toBeTruthy();
    const body = screen.getByTestId("ae-pr-compliance-body");
    expect(within(body).getByRole("heading", { name: "Compliance checks" })).toBeTruthy();
    expect(within(body).getByText("tracking.js").tagName).toBe("CODE");
    expect(within(body).getByText("Final finding: preserved")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Source comment" })).toHaveAttribute(
      "href",
      report.url,
    );
    expect(screen.getByTestId("ae-pr-review-details")).not.toHaveAttribute("open");
    fireEvent.click(summary);
    await waitFor(() => expect(screen.queryByTestId("ae-pr-compliance-body")).toBeNull());
  });

  it.each([
    ["current", "matches this branch"],
    ["stale", "older revision"],
  ])(
    "labels a blocking report's %s revision without altering the merge gate",
    async (revision, wording) => {
      serve((path) =>
        path.includes("/compliance")
          ? json({
              report: {
                body: "## AE Compliance Review\n\nBLOCKED\n\nFix missing disclosure.",
                verdict: "blocked",
                url: `${url(5)}#issuecomment-123`,
                updated_at: "2026-10-17T12:00:00Z",
                reviewed_sha: SHA,
                revision,
              },
            })
          : json(card(5)),
      );
      renderCards([{ url: url(5) }]);
      fireEvent.click(await screen.findByText("AE compliance review"));
      expect(await screen.findByText("Blocking findings")).toBeTruthy();
      expect(await screen.findByText(new RegExp(wording))).toBeTruthy();
      expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled();
    },
  );

  it("distinguishes a failed compliance read from a missing report and retries in the card", async () => {
    let fail = true;
    serve((path) =>
      path.includes("/compliance")
        ? fail
          ? json({ error: { code: "github_failed", message: "GitHub unavailable" } }, 502)
          : json({ report: null })
        : json(card(5)),
    );
    renderCards([{ url: url(5) }]);
    fireEvent.click(await screen.findByText("AE compliance review"));
    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub unavailable");
    expect(screen.queryByText("No AE compliance review posted yet.")).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
    expect(await screen.findByText("No AE compliance review posted yet.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not carry a cached approval into a new head revision", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let reportReads = 0;
    serve((path) => {
      if (!path.includes("/compliance")) return json(card(5));
      reportReads++;
      if (reportReads > 1) return new Promise(() => {});
      return json({
        report: {
          body: "APPROVED",
          verdict: "approved",
          url: `${url(5)}#issuecomment-123`,
          updated_at: "2026-10-17T12:00:00Z",
          reviewed_sha: SHA,
          revision: "current",
        },
      });
    });
    renderCards([{ url: url(5) }], "s1", qc);
    fireEvent.click(await screen.findByText("AE compliance review"));
    await screen.findByText("Approved report");
    act(() => qc.setQueryData(["ae-pr", REPO, 5], card(5, { head_sha: "b".repeat(40) })));
    await screen.findByText("Reading compliance review...");
    expect(screen.queryByText("Approved report")).toBeNull();
    expect(screen.queryByText(/matches this branch/)).toBeNull();
  });

  it("does not label a report current when its fresh head differs from the displayed card", async () => {
    serve((path) =>
      path.includes("/compliance")
        ? json({
            report: {
              body: "APPROVED",
              verdict: "approved",
              url: `${url(5)}#issuecomment-123`,
              updated_at: "2026-10-17T12:00:00Z",
              reviewed_sha: "b".repeat(40),
              revision: "current",
            },
          })
        : json(card(5)),
    );
    renderCards([{ url: url(5) }]);
    fireEvent.click(await screen.findByText("AE compliance review"));
    expect(await screen.findByText(/does not match this card/)).toBeTruthy();
    expect(screen.queryByText(/matches this branch/)).toBeNull();
  });

  it("marks a cached approval unverified when refreshing the report fails", async () => {
    let fail = false;
    serve((path) =>
      path.includes("/compliance")
        ? fail
          ? json({ error: { code: "github_failed", message: "GitHub unavailable" } }, 502)
          : json({
              report: {
                body: "APPROVED",
                verdict: "approved",
                url: `${url(5)}#issuecomment-123`,
                updated_at: "2026-10-17T12:00:00Z",
                reviewed_sha: SHA,
                revision: "current",
              },
            })
        : json(card(5)),
    );
    renderCards([{ url: url(5) }]);
    fireEvent.click(await screen.findByText("AE compliance review"));
    await screen.findByText("Approved report");
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Approved report")).toBeNull();
    expect(screen.queryByText(/matches this branch/)).toBeNull();
    expect(screen.getByText(/Approval for the current revision is unverified/)).toBeTruthy();
  });

  it("preserves the end of an oversized compliance report in the plain-text fallback", async () => {
    const body = "x".repeat(210_000) + "\nFinal blocking finding";
    serve((path) =>
      path.includes("/compliance")
        ? json({
            report: {
              body,
              verdict: "blocked",
              url: `${url(5)}#issuecomment-123`,
              updated_at: "2026-10-17T12:00:00Z",
              reviewed_sha: null,
              revision: "unknown",
            },
          })
        : json(card(5)),
    );
    renderCards([{ url: url(5) }]);
    fireEvent.click(await screen.findByText("AE compliance review"));
    expect((await screen.findByTestId("ae-pr-compliance-body")).textContent).toBe(body);
  });
});
