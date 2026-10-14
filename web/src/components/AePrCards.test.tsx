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
    fireEvent.click(screen.getByRole("button", { name: "Squash into main" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Not merged: CI is still running: 1 of 6 checks.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("1 of 6 checks running").dataset.tone).toBe("wait");
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
