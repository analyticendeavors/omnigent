import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));
// The family read behind Switch account; the rows are the session list it would find.
const familyRows = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/lib/aeFamilyRead", () => ({
  aeReadFamilySessions: () => Promise.resolve(familyRows.rows),
  aeFamilyOf: () => [],
}));

import { useAePublishDockQuestions } from "@/hooks/useAeActionDockItems";
import type { AnyBlock } from "@/lib/blocks";
import { authenticatedFetch } from "@/lib/identity";
import { dismissAeSwitchFamily, useAeSwitchFamilyRequest } from "@/lib/aeSwitchFamily";
import type { AePrCard } from "@/lib/aePrs";
import { ForkDialogContextProvider } from "@/shell/ForkDialogContext";
import { useChatStore } from "@/store/chatStore";
import { aeRevealDock } from "@/lib/aeDockReveal";
import { AeActionDock } from "./AeActionDock";
import { ComposerWorkspaceBar } from "./composer/ComposerControls";
import { ComposerPrLink } from "./composer/ComposerPrLink";

const realCompact = useChatStore.getState().compact;
const REPO = "analyticendeavors/omnigent-ae";
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const url = (n: number) => `https://github.com/${REPO}/pull/${n}`;

function card(number: number, over: Partial<AePrCard> = {}): AePrCard {
  return {
    repo: REPO,
    number,
    url: url(number),
    title: `PR ${number}`,
    state: "open",
    draft: false,
    author: null,
    head_ref: `b-${number}`,
    base_ref: "main",
    head_sha: SHA,
    ci: { state: "passing", passing: 5, failing: 0, pending: 0, total: 5 },
    mergeable: { state: "clean", detail: "" },
    review: { state: "none", approvals: 0, changes_requested: 0, requested: [] },
    merge: {
      methods: ["squash", "merge"],
      default_method: "squash",
      recommended_method: "squash",
      recommended_reason: "Feature branch into main.",
      allowed: true,
      reason: null,
    },
    ...over,
  };
}

function said(text: string, itemId: string): AnyBlock {
  return {
    type: "text_done",
    ctx: { agent: null, depth: 0, turn: 1, timestamp: 0, responseId: "r1", itemId },
    fullText: text,
    hasCodeBlocks: false,
  } as AnyBlock;
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

type Question = Parameters<typeof useAePublishDockQuestions>[1][number];

function Questions({ pending }: { pending: Question[] }) {
  useAePublishDockQuestions("s1", pending, []);
  return null;
}

function renderDock(texts: string[], pending: Question[] = [], labels?: Record<string, string>) {
  useChatStore.setState({
    conversationId: "s1",
    blocks: texts.map((text, i) => said(text, `m${i}`)),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tracked = texts.flatMap((text) => text.match(/https:\/\/\S+/g) ?? []);
  if (labels) qc.setQueryData(["session", "s1"], { labels });
  qc.setQueryData(["github-info", "s1"], {
    available: true,
    prs: tracked.map((u) => ({ url: u })),
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Questions pending={pending} />
        {/* Mounted where ChatPage mounts it: inside the workspace bar. */}
        <ComposerWorkspaceBar data-testid="composer-workspace-controls">
          <ComposerPrLink state="ready" prCount={7} prNumber={180} onOpen={() => {}} />
          <AeActionDock sessionId="s1" />
          <div className="ml-auto" data-testid="bar-right-cluster" />
        </ComposerWorkspaceBar>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

function serve(cards: Record<number, AePrCard>) {
  vi.mocked(authenticatedFetch).mockImplementation(
    (input: URL | RequestInfo, init?: RequestInit) => {
      const path = String(input);
      const match = /\/v1\/ae\/prs\/[^/]+\/[^/]+\/(\d+)(\/\w+)?/.exec(path);
      const n = Number(match?.[1]);
      if (match?.[2] === "/merge" && init?.method === "POST") {
        return json({
          merged: true,
          repo: REPO,
          number: n,
          method: "squash",
          sha: "f00",
          message: "",
          session: null,
        });
      }
      if (match?.[2] === "/ready" && init?.method === "POST") return json(card(n));
      if (match?.[2] === "/deploy") {
        return json({
          state: "waiting",
          running: "ae-v0.18.0.31",
          latest: "ae-v0.18.0.32",
          mid_turn: 2,
          hold_until: null,
          hold_by: null,
          merged_at: new Date(Date.now() - 4 * 60_000).toISOString(),
          error: null,
        });
      }
      return cards[n] ? json(cards[n]) : json({ error: { message: "nope" } }, 404);
    },
  );
}

function serveLive() {
  vi.mocked(authenticatedFetch).mockImplementation((input: URL | RequestInfo) => {
    const path = String(input);
    if (path.endsWith("/deploy")) {
      return json({
        state: "live",
        running: "ae-v0.18.0.42",
        latest: "ae-v0.18.0.42",
        mid_turn: 0,
        hold_until: null,
        hold_by: null,
        merged_at: new Date().toISOString(),
        error: null,
      });
    }
    return json(card(194, { state: "merged" }));
  });
}

const question: Question = {
  elicitationId: "e1",
  message: "Approve?",
  askUserQuestion: { questions: [{ question: "Run the inotify fix now or park it?" }] },
};

beforeEach(() => {
  vi.mocked(authenticatedFetch).mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  useChatStore.setState({
    conversationId: null,
    blocks: [],
    status: "idle",
    sessionStatus: "idle",
    compact: realCompact,
  });
});

describe("AeActionDock", () => {
  it("draws nothing when nothing waits", async () => {
    serve({ 7: card(7, { state: "closed" }) });
    const { container } = renderDock([`Opened ${url(7)}`]);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    expect(container.querySelector("[data-testid=ae-action-dock]")).toBeNull();
  });

  it("collapsed: leads with the question and badges the merges", async () => {
    serve({ 180: card(180), 181: card(181) });
    renderDock([`Opened ${url(180)} and ${url(181)}`], [question]);
    const lead = await screen.findByTestId("ae-dock-lead");
    expect(lead.textContent).toContain("Run the inotify fix now or park it?");
    expect(within(lead).getByTestId("ae-dock-jump")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("ae-dock-badge").textContent).toContain("2 to merge"),
    );
  });

  it("previews the pull request when its number is hovered or focused", async () => {
    serve({ 180: card(180) });
    renderDock([`Opened ${url(180)}`]);
    const link = await screen.findByTestId("ae-dock-pr-link");
    expect(link).toHaveAttribute("href", url(180));
    expect(link).not.toHaveAttribute("title");
    fireEvent.focus(link);
    const preview = await screen.findByTestId("ae-pr-hover");
    expect(within(preview).getByText("PR 180")).toBeTruthy();
    // Above the bar, like the tray, so it never covers the composer.
    expect(preview.closest("[data-side]")).toHaveAttribute("data-side", "top");
  });

  it("renders inside the workspace bar, the caret after the bar's right cluster", async () => {
    serve({ 180: card(180) });
    renderDock([`Opened ${url(180)}`], [question]);
    await screen.findByTestId("ae-dock-badge");
    const bar = screen.getByTestId("composer-workspace-controls");
    const dock = screen.getByTestId("ae-action-dock");
    expect(dock.parentElement).toBe(bar);
    expect(dock.className).toContain("contents");
    expect(screen.getByTestId("ae-dock-caret").parentElement!.className).toContain("order-last");
    // The chips' icon-only rule keys on this marker (group-has in the bar).
    expect(bar.querySelector("[data-ae-dock-items]")).toBe(dock);
  });

  it("the PR chip has an icon-and-count label for while the dock shares the bar", async () => {
    serve({ 180: card(180) });
    renderDock([`Opened ${url(180)}`]);
    await screen.findByTestId("ae-dock-merge");
    const chip = screen.getByTestId("composer-pr-link");
    const label = chip.querySelector("span")!;
    expect(label.textContent).toBe("7 PRs");
    expect(label.className).toContain("group-has-[[data-ae-dock-items]]/composer-workspace:hidden");
    // The count is the chip's ::after, so the label never shows as "7 P…" or "#180".
    expect(chip.getAttribute("data-ae-count")).toBe("7");
    expect(chip.className).toContain(
      "group-has-[[data-ae-dock-items]]/composer-workspace:after:content-[attr(data-ae-count)]",
    );
  });

  it("leaves the bar as it is when nothing waits", async () => {
    serve({
      7: card(7, { ci: { state: "failing", passing: 1, failing: 1, pending: 0, total: 2 } }),
    });
    renderDock([`Opened ${url(7)}`]);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    const bar = screen.getByTestId("composer-workspace-controls");
    expect(bar.querySelector("[data-ae-dock-items]")).toBeNull();
    expect([...bar.children].map((el) => el.getAttribute("data-testid"))).toEqual([
      "composer-pr-link",
      "bar-right-cluster",
    ]);
  });

  it("badges drop to icon and count before the lead's text truncates", async () => {
    const text = (el: Element) => el.hasAttribute("data-ae-lead-text");
    const scroll = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return text(this) ? 300 : 0;
      });
    const client = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return text(this) ? 120 : 0;
      });
    try {
      serve({ 180: card(180), 181: card(181) });
      renderDock([`Opened ${url(180)} and ${url(181)}`], [question]);
      await waitFor(() =>
        expect(screen.getByTestId("ae-dock-badge").hasAttribute("data-compact")).toBe(true),
      );
      const badge = screen.getByTestId("ae-dock-badge");
      const [label, count] = [...badge.querySelectorAll("span")];
      expect(label!.className).not.toContain("md:inline");
      expect(count!.className).not.toContain("md:hidden");
      expect(
        screen.getByTestId("ae-dock-lead").querySelector("[title]")!.getAttribute("title"),
      ).toBe("Run the inotify fix now or park it?");
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  it("Merge on the strip opens the list with the confirm in its line", async () => {
    serve({ 180: card(180) });
    renderDock([`Opened ${url(180)}`]);
    fireEvent.click(await screen.findByTestId("ae-dock-merge"));
    const list = screen.getByTestId("ae-dock-list");
    expect(within(list).getByRole("group", { name: "Confirm merge" })).toBeTruthy();
    expect(screen.getByTestId("ae-dock-tray")).toBeTruthy();
    expect(screen.getByTestId("ae-dock-caret").getAttribute("aria-expanded")).toBe("true");
    // Opened only for the confirm: Cancel returns to the strip.
    fireEvent.click(within(list).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("ae-dock-tray")).toBeNull();
    expect(screen.getByTestId("ae-dock-merge")).toBeTruthy();
  });

  it("a live deploy alone is a green chip with no caret", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.setItem(
        "ae-action-dock:deploys:s1",
        JSON.stringify([[`${REPO}#194`, Date.now()]]),
      );
      serveLive();
      renderDock([`Merged ${url(194)}`]);
      const chip = await screen.findByTestId("ae-dock-live");
      expect(chip.textContent).toContain("live in ae-v0.18.0.42");
      expect(screen.queryByTestId("ae-dock-caret")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a badge opens the list and the caret closes it", async () => {
    serve({ 180: card(180) });
    renderDock([`See ${url(180)}`], [question]);
    const badge = await screen.findByTestId("ae-dock-badge");
    fireEvent.click(badge);
    const lines = screen.getAllByTestId("ae-dock-line");
    expect(lines.map((line) => line.dataset.kind)).toEqual(["question", "merge"]);
    expect(screen.getByTestId("ae-action-dock").textContent).toContain("2 waiting");
    fireEvent.click(screen.getByTestId("ae-dock-caret"));
    expect(screen.queryByTestId("ae-dock-tray")).toBeNull();
    expect(screen.getByTestId("ae-dock-lead")).toBeTruthy();
  });

  it("starts closed even with an open state saved by an older build, and Escape closes", async () => {
    window.localStorage.setItem("ae-action-dock:open:s1", "1");
    serve({ 180: card(180) });
    renderDock([`See ${url(180)}`], [question]);
    await screen.findByTestId("ae-dock-badge");
    expect(screen.queryByTestId("ae-dock-tray")).toBeNull();
    fireEvent.click(screen.getByTestId("ae-dock-caret"));
    expect(screen.getByTestId("ae-dock-tray")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("ae-dock-tray")).toBeNull();
  });

  it("closing the tray with the caret drops the confirm; Merge on the strip opens it again", async () => {
    serve({ 180: card(180) });
    renderDock([`Opened ${url(180)}`]);
    fireEvent.click(await screen.findByTestId("ae-dock-merge"));
    expect(screen.getByRole("group", { name: "Confirm merge" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("ae-dock-caret"));
    expect(screen.queryByTestId("ae-dock-tray")).toBeNull();
    fireEvent.click(screen.getByTestId("ae-dock-merge"));
    expect(screen.getByRole("group", { name: "Confirm merge" })).toBeTruthy();
  });

  it("merge asks first: the method choice, then Confirm posts the merge", async () => {
    serve({ 180: card(180) });
    renderDock([`Opened ${url(180)}`]);
    const merge = await screen.findByTestId("ae-dock-merge");
    expect(screen.getByTestId("ae-dock-lead").textContent).toContain("ready to merge · 5/5 checks");
    fireEvent.click(merge);
    const confirm = screen.getByRole("group", { name: "Confirm merge" });
    expect(within(confirm).getByRole("radiogroup", { name: "Merge method" })).toBeTruthy();
    const posts = () =>
      vi.mocked(authenticatedFetch).mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts()).toHaveLength(0);
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Squash into main" }));
    });
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [path, init] = posts()[0]!;
    expect(path).toBe(`/v1/ae/prs/${REPO}/180/merge`);
    expect(JSON.parse(String(init!.body))).toMatchObject({ sha: SHA, method: "squash" });
  });

  it("a draft shows with Mark ready, which turns it into the Merge line", async () => {
    serve({
      180: card(180, {
        draft: true,
        mergeable: { state: "draft", detail: "" },
        merge: { ...card(180).merge, allowed: false },
      }),
    });
    renderDock([`Opened ${url(180)}`]);
    const ready = await screen.findByTestId("ae-dock-ready");
    expect(screen.getByTestId("ae-dock-lead").textContent).toContain("draft · 5/5 checks");
    expect(screen.queryByTestId("ae-dock-merge")).toBeNull();
    await act(async () => {
      fireEvent.click(ready);
    });
    const posts = vi
      .mocked(authenticatedFetch)
      .mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts.map(([path]) => path)).toEqual([`/v1/ae/prs/${REPO}/180/ready`]);
    await screen.findByTestId("ae-dock-merge");
    expect(screen.queryByTestId("ae-dock-ready")).toBeNull();
  });

  it("an open pull request still running checks shows its state, then turns into Merge", async () => {
    serve({
      180: card(180, { ci: { state: "pending", passing: 11, failing: 0, pending: 1, total: 12 } }),
    });
    const { qc } = renderDock([`Opened ${url(180)}`]);
    await waitFor(() =>
      expect(screen.getByTestId("ae-dock-lead").textContent).toContain("checks 11/12"),
    );
    // No button names the state, so a phone keeps the word.
    const word = screen.getByTestId("ae-dock-lead").querySelector("[data-ae-lead-text]");
    expect(word).not.toHaveClass("hidden");
    expect(screen.queryByTestId("ae-dock-merge")).toBeNull();
    expect(screen.queryByTestId("ae-dock-update")).toBeNull();
    serve({ 180: card(180) });
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["ae-pr", REPO, 180] });
    });
    await screen.findByTestId("ae-dock-merge");
  });

  it("a pull request behind main offers Update branch, which posts the head it saw", async () => {
    serve({
      180: card(180, {
        mergeable: { state: "behind", detail: "" },
        update_branch: { allowed: true, reason: null },
        merge: { ...card(180).merge, allowed: false },
      }),
    });
    renderDock([`Opened ${url(180)}`]);
    const update = await screen.findByTestId("ae-dock-update");
    expect(screen.getByTestId("ae-dock-lead").textContent).toContain("behind main");
    vi.mocked(authenticatedFetch).mockImplementationOnce(() =>
      json({ accepted: true, message: "", head_sha: SHA }),
    );
    await act(async () => {
      fireEvent.click(update);
    });
    const posts = vi
      .mocked(authenticatedFetch)
      .mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts.map(([path]) => path)).toEqual([`/v1/ae/prs/${REPO}/180/update-branch`]);
    expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({ sha: SHA });
    await waitFor(() => expect(update.textContent).toBe("Updating…"));
    expect(update).toBeDisabled();
  });

  it("an update entry left from an older head does not hold the dock's Confirm", async () => {
    serve({ 180: card(180) });
    const { qc } = renderDock([`Opened ${url(180)}`]);
    qc.setQueryData(["ae-pr-branch-update", REPO, 180], { sha: "old-head", started: Date.now() });
    fireEvent.click(await screen.findByTestId("ae-dock-merge"));
    const confirm = await screen.findByTestId("ae-dock-confirm");
    expect(within(confirm).getByRole("button", { name: "Squash into main" })).not.toBeDisabled();
  });

  it("a failed Mark ready says so on the button", async () => {
    serve({ 180: card(180, { draft: true, mergeable: { state: "draft", detail: "" } }) });
    renderDock([`Opened ${url(180)}`]);
    const ready = await screen.findByTestId("ae-dock-ready");
    vi.mocked(authenticatedFetch).mockImplementationOnce(() =>
      json({ error: { message: "head moved" } }, 409),
    );
    await act(async () => {
      fireEvent.click(ready);
    });
    await waitFor(() => expect(ready.textContent).toBe("Failed, retry"));
    expect(ready.getAttribute("aria-label")).toContain("Could not mark #180 ready");
  });

  it("a confirm opened from a list line gives the list half the screen until Cancel", async () => {
    serve({ 180: card(180) });
    renderDock([`See ${url(180)}`], [question]);
    fireEvent.click(await screen.findByTestId("ae-dock-badge"));
    const list = screen.getByTestId("ae-dock-list");
    expect(list.className).toContain("max-h-[120px]");
    fireEvent.click(within(list).getByTestId("ae-dock-merge"));
    expect(within(list).getByRole("group", { name: "Confirm merge" })).toBeTruthy();
    expect(list.className).not.toContain("max-h-[120px]");
    expect(list.className).toContain("max-h-[50vh]");
    expect(list.className).toContain("overflow-y-auto");
    fireEvent.click(within(list).getByRole("button", { name: "Cancel" }));
    expect(within(list).queryByRole("group", { name: "Confirm merge" })).toBeNull();
    expect(list.className).toContain("max-h-[120px]");
  });

  it("Cancel closes the confirm without merging", async () => {
    serve({ 180: card(180) });
    renderDock([`Opened ${url(180)}`]);
    fireEvent.click(await screen.findByTestId("ae-dock-merge"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm merge" })).toBeNull();
  });

  it("a merged omnigent-ae pull request first seen waiting shows its deploy line", async () => {
    serve({ 179: card(179, { state: "merged" }) });
    renderDock([`Merged ${url(179)}`]);
    const lead = await screen.findByTestId("ae-dock-lead");
    expect(lead.textContent).toContain("#179");
    expect(lead.textContent).toContain("merged 4m ago · deploy waits on 2 busy sessions");
    expect(within(lead).getByRole("link", { name: "Admin Center" })).toBeTruthy();
    fireEvent.click(within(lead).getByTestId("ae-dock-dismiss"));
    expect(screen.queryByTestId("ae-action-dock")).toBeNull();
  });

  it("hides a question while its card is on screen, and keeps the merges", async () => {
    // Every observed element reports itself visible at once.
    class VisibleObserver {
      callback: (entries: Partial<IntersectionObserverEntry>[]) => void;
      constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
        this.callback = callback;
      }
      observe(target: Element) {
        this.callback([{ target, isIntersecting: true }]);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", VisibleObserver);
    const feedCard = document.createElement("article");
    feedCard.setAttribute("data-ae-question", question.elicitationId);
    document.body.appendChild(feedCard);
    try {
      serve({ 180: card(180) });
      renderDock([`Opened ${url(180)}`], [question]);
      const lead = await screen.findByTestId("ae-dock-lead");
      await waitFor(() => expect(within(lead).getByTestId("ae-dock-merge")).toBeTruthy());
      expect(screen.queryByTestId("ae-dock-jump")).toBeNull();
    } finally {
      feedCard.remove();
      vi.unstubAllGlobals();
    }
  });

  it("a confirm whose item leaves the dock closes, with the tray opened for it", async () => {
    serve({ 180: card(180), 181: card(181) });
    const { qc } = renderDock([`Opened ${url(180)} and ${url(181)}`]);
    await waitFor(() => expect(screen.getByTestId("ae-dock-lead").textContent).toContain("#180"));
    fireEvent.click(within(screen.getByTestId("ae-dock-lead")).getByTestId("ae-dock-merge"));
    expect(screen.getByRole("group", { name: "Confirm merge" })).toBeTruthy();
    // Merged from its own card in the feed, so the dock's item goes.
    const [query] = qc.getQueryCache().findAll({
      predicate: (q) => q.queryKey[0] === "ae-pr" && q.queryKey[2] === 180,
    });
    act(() => qc.setQueryData(query.queryKey, card(180, { state: "merged" })));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Confirm merge" })).toBeNull());
    expect(screen.queryByTestId("ae-dock-tray")).toBeNull();
    expect(screen.getByTestId("ae-dock-lead").textContent).toContain("#181");
  });

  it("offers nothing for a pull request the session does not track", async () => {
    serve({ 180: card(180) });
    useChatStore.setState({ conversationId: "s1", blocks: [said(`See ${url(180)}`, "m0")] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["github-info", "s1"], { available: true, prs: [{ url: url(5) }] });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AeActionDock sessionId="s1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    expect(screen.queryByTestId("ae-action-dock")).toBeNull();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it("lists a pull request linked twice with different casing once", async () => {
    serve({ 180: card(180) });
    const upper = url(180).replace("analyticendeavors", "AnalyticEndeavors");
    renderDock([`See ${url(180)} and ${upper}`]);
    await screen.findByTestId("ae-dock-merge");
    expect(screen.getAllByTestId("ae-dock-merge")).toHaveLength(1);
    expect(screen.getByTestId("ae-dock-lead").textContent).not.toContain("more");
  });
});

// ── the usage gate ─────────────────────────────────────────────────────

const RESETS = new Date(Date.now() + 2 * 86_400_000).toISOString();

function limitsAnswer(used: number, harness: "claude" | "codex" = "claude", resets = RESETS) {
  return {
    now: new Date().toISOString(),
    harnesses: {
      [harness]: {
        harness,
        source: "statusline",
        observed_at: new Date().toISOString(),
        plan: null,
        note: null,
        account: null,
        account_label: "AE Default",
        windows: [
          {
            id: "five_hour",
            label: "5-hour limit",
            used_percent: 20,
            resets_at: RESETS,
            window_minutes: 300,
          },
          {
            id: "seven_day",
            label: "Weekly",
            used_percent: used,
            resets_at: resets,
            window_minutes: 10080,
          },
        ],
      },
    },
  };
}

const TWO_LOGINS = [
  { family: "claude-oauth-active", source: "AE Default", env_var: "" },
  { family: "claude-oauth", source: "Personal", env_var: "personal" },
];
const THREE_LOGINS = [...TWO_LOGINS, { family: "claude-oauth", source: "Shared", env_var: "team" }];

function serveLimits(answer: () => unknown, logins: unknown[] = TWO_LOGINS) {
  vi.mocked(authenticatedFetch).mockImplementation(
    (input: URL | RequestInfo, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "PUT" && path.endsWith("/claude-account")) {
        return json({ account: JSON.parse(String(init.body)).account, relaunched: true });
      }
      if (path.startsWith("/v1/ae/limits")) return json(answer());
      if (path.includes("/credentials/detected")) return json({ credentials: logins });
      return json({ error: { message: "nope" } }, 404);
    },
  );
}

function Asked() {
  const ask = useAeSwitchFamilyRequest();
  return (
    <span data-testid="ask">{ask ? `${ask.sessionId}|${ask.account}|${ask.childCount}` : ""}</span>
  );
}

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderLimitDock({
  harness = "claude-native",
  canFork = true,
  disabledReason,
  noModelMenu = false,
  onSwitchModel = vi.fn(),
  openForkDialog = vi.fn(),
}: {
  harness?: string;
  canFork?: boolean;
  disabledReason?: string;
  noModelMenu?: boolean;
  onSwitchModel?: () => void;
  openForkDialog?: () => void;
} = {}) {
  useChatStore.setState({ conversationId: "s1", blocks: [], sessionHarness: harness });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["session", "s1"], { id: "s1", hostId: "h1", labels: {} });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/c/s1"]}>
        <ForkDialogContextProvider
          value={{ currentSessionId: "s1", canFork, disabledReason, openForkDialog }}
        >
          <Where />
          <Asked />
          <ComposerWorkspaceBar data-testid="composer-workspace-controls">
            <AeActionDock sessionId="s1" onSwitchModel={noModelMenu ? undefined : onSwitchModel} />
          </ComposerWorkspaceBar>
        </ForkDialogContextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onSwitchModel, openForkDialog };
}

describe("AeActionDock usage gate", () => {
  afterEach(() => {
    useChatStore.setState({ sessionHarness: null });
    familyRows.rows = [];
  });

  it("leads with the limit and its three buttons", async () => {
    serveLimits(() => limitsAnswer(92));
    renderLimitDock();
    const lead = await screen.findByTestId("ae-dock-lead");
    expect(lead.textContent).toContain("AE Default is at 92% of its weekly limit, resets");
    expect(within(lead).getByTestId("ae-dock-limit-model")).toBeTruthy();
    expect(await within(lead).findByTestId("ae-dock-limit-account")).toBeTruthy();
    expect(within(lead).getByTestId("ae-dock-limit-copy")).toBeTruthy();
    expect(within(lead).getByTestId("ae-dock-limit-new")).toBeTruthy();
    expect(within(lead).getByTestId("ae-dock-dismiss")).toBeTruthy();
  });

  it("draws nothing below 90 percent", async () => {
    serveLimits(() => limitsAnswer(89));
    renderLimitDock();
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    expect(screen.queryByTestId("ae-action-dock")).toBeNull();
  });

  it("each button calls its handler", async () => {
    serveLimits(() => limitsAnswer(95));
    const { onSwitchModel, openForkDialog } = renderLimitDock();
    fireEvent.click(await screen.findByTestId("ae-dock-limit-model"));
    expect(onSwitchModel).toHaveBeenCalledTimes(1);
    // The primary button moves this chat in place; the fork dialog is the second action.
    fireEvent.click(await screen.findByTestId("ae-dock-limit-account"));
    await waitFor(() =>
      expect(authenticatedFetch).toHaveBeenCalledWith(
        "/v1/ae/sessions/s1/claude-account",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ account: "personal" }) }),
      ),
    );
    expect(openForkDialog).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("ae-dock-limit-copy"));
    expect(openForkDialog).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("where").textContent).toBe("/c/s1");
    fireEvent.click(screen.getByTestId("ae-dock-limit-new"));
    expect(screen.getByTestId("where").textContent).toBe("/");
  });

  it("asks about the child chats instead of switching when the chat has some", async () => {
    familyRows.rows = [
      { id: "kid", object: "conversation", labels: { "ae.orch": "s1" } },
      { id: "grandkid", object: "conversation", labels: { "ae.orch": "kid" } },
    ];
    serveLimits(() => limitsAnswer(95));
    renderLimitDock();
    fireEvent.click(await screen.findByTestId("ae-dock-limit-account"));
    await waitFor(() => expect(screen.getByTestId("ask").textContent).toBe("s1|personal|2"));
    expect(authenticatedFetch).not.toHaveBeenCalledWith(
      "/v1/ae/sessions/s1/claude-account",
      expect.anything(),
    );
    act(() => dismissAeSwitchFamily());
  });

  it("switches at once when the chat has no children", async () => {
    familyRows.rows = [
      {
        id: "fork",
        object: "conversation",
        labels: { "ae.orch": "s1", "omnigent.fork.source_id": "s1" },
      },
    ];
    serveLimits(() => limitsAnswer(95));
    renderLimitDock();
    fireEvent.click(await screen.findByTestId("ae-dock-limit-account"));
    await waitFor(() =>
      expect(authenticatedFetch).toHaveBeenCalledWith(
        "/v1/ae/sessions/s1/claude-account",
        expect.objectContaining({ body: JSON.stringify({ account: "personal" }) }),
      ),
    );
    expect(screen.getByTestId("ask").textContent).toBe("");
  });

  it("opens a menu of logins when more than one other login exists", async () => {
    serveLimits(() => limitsAnswer(95), THREE_LOGINS);
    renderLimitDock();
    const button = await screen.findByTestId("ae-dock-limit-account");
    expect(authenticatedFetch).not.toHaveBeenCalledWith(
      "/v1/ae/sessions/s1/claude-account",
      expect.anything(),
    );
    fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByTestId("ae-dock-limit-account-team"));
    await waitFor(() =>
      expect(authenticatedFetch).toHaveBeenCalledWith(
        "/v1/ae/sessions/s1/claude-account",
        expect.objectContaining({ body: JSON.stringify({ account: "team" }) }),
      ),
    );
  });

  it("hides Switch account with no other login", async () => {
    serveLimits(() => limitsAnswer(95), [TWO_LOGINS[0]]);
    renderLimitDock();
    await screen.findByTestId("ae-dock-limit-new");
    await waitFor(() =>
      expect(authenticatedFetch).toHaveBeenCalledWith(
        expect.stringContaining("/credentials/detected"),
      ),
    );
    expect(screen.queryByTestId("ae-dock-limit-account")).toBeNull();
  });

  it("hides Switch account on Codex", async () => {
    serveLimits(() => limitsAnswer(95, "codex"));
    renderLimitDock({ harness: "codex-native" });
    expect(await screen.findByTestId("ae-dock-limit-new")).toBeTruthy();
    expect(screen.getByTestId("ae-dock-lead").textContent).toContain("95% of its weekly limit");
    expect(screen.queryByTestId("ae-dock-limit-account")).toBeNull();
  });

  for (const [why, opts] of [
    ["cannot be forked", { canFork: false }],
    ["has a fork restriction", { disabledReason: "Forking is off for this session." }],
  ] as const) {
    it(`hides Copy to another login when the session ${why}`, async () => {
      serveLimits(() => limitsAnswer(95));
      renderLimitDock(opts);
      await screen.findByTestId("ae-dock-limit-new");
      await waitFor(() =>
        expect(authenticatedFetch).toHaveBeenCalledWith(
          expect.stringContaining("/credentials/detected"),
        ),
      );
      expect(screen.getByTestId("ae-dock-limit-account")).toBeTruthy();
      expect(screen.queryByTestId("ae-dock-limit-copy")).toBeNull();
    });
  }

  it("Switch model is absent without a model menu to open", async () => {
    serveLimits(() => limitsAnswer(95));
    renderLimitDock({ noModelMenu: true });
    await screen.findByTestId("ae-dock-limit-new");
    expect(screen.queryByTestId("ae-dock-limit-model")).toBeNull();
  });

  it("a dismissal holds across a remount until the window resets", async () => {
    let resets = RESETS;
    serveLimits(() => limitsAnswer(93, "claude", resets));
    renderLimitDock();
    fireEvent.click(await screen.findByTestId("ae-dock-dismiss"));
    expect(screen.queryByTestId("ae-action-dock")).toBeNull();
    cleanup();
    renderLimitDock();
    const limitReads = () =>
      vi
        .mocked(authenticatedFetch)
        .mock.calls.filter(([path]) => String(path).startsWith("/v1/ae/limits")).length;
    await waitFor(() => expect(limitReads()).toBe(2));
    await act(async () => {});
    expect(screen.queryByTestId("ae-action-dock")).toBeNull();
    cleanup();
    resets = new Date(Date.now() + 9 * 86_400_000).toISOString();
    renderLimitDock();
    expect(await screen.findByTestId("ae-dock-limit-new")).toBeTruthy();
  });
});

describe("AeActionDock child prompts", () => {
  const ask = {
    type: "elicitation",
    ctx: { agent: null, depth: 0, turn: 1, timestamp: 0, responseId: "r1", itemId: "i1" },
    elicitationId: "fam1",
    targetSessionId: "conv_child",
    familyChild: { title: "Halcyon Orbital" },
    message: "Keep it?",
    phase: "tool_call",
    policyName: "",
    contentPreview: "",
    requestedSchema: {},
    status: "pending",
    response: null,
    askUserQuestion: {
      questions: [
        {
          question: "Keep the Fuel Cost measure?",
          header: "Measure",
          multiSelect: false,
          options: [{ label: "Keep it" }, { label: "Drop it" }],
        },
      ],
    },
  } as unknown as AnyBlock;
  const permission = {
    ...(ask as object),
    elicitationId: "fam2",
    targetSessionId: "conv_other",
    familyChild: { title: "Brightwater" },
    message: "Allow Bash: pbi-tools deploy ./model?",
    askUserQuestion: null,
  } as unknown as AnyBlock;

  function renderChildDock(blocks: AnyBlock[]) {
    useChatStore.setState({ conversationId: "s1", blocks });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["github-info", "s1"], { available: true, prs: [] });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ComposerWorkspaceBar data-testid="composer-workspace-controls">
            <AeActionDock sessionId="s1" />
          </ComposerWorkspaceBar>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("leads with the child's title and question, and badges nothing else", async () => {
    renderChildDock([ask]);
    const lead = await screen.findByTestId("ae-dock-lead");
    expect(lead.textContent).toContain("Halcyon Orbital: Keep the Fuel Cost measure?");
    expect(screen.queryByTestId("ae-dock-jump")).toBeNull();
  });

  it("opens the tray when the rail asks to reveal the child prompts", async () => {
    renderChildDock([ask]);
    await screen.findByTestId("ae-dock-lead");
    expect(screen.queryByTestId("ae-dock-child-prompt")).toBeNull();
    act(() => aeRevealDock("childPrompt"));
    expect(await screen.findByTestId("ae-dock-child-prompt")).toBeTruthy();
  });

  it("scrolls the tray to the child the rail names, not the first waiting one", async () => {
    // jsdom has no layout: give each line a top of 100 per position.
    const top = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        return this.parentElement ? [...this.parentElement.children].indexOf(this) * 100 : 0;
      },
    });
    try {
      renderChildDock([ask, permission]);
      await screen.findByTestId("ae-dock-lead");
      act(() => aeRevealDock("childPrompt", "conv_other"));
      const list = await screen.findByTestId("ae-dock-list");
      await waitFor(() => expect(list.scrollTop).toBe(100));
      act(() => aeRevealDock("childPrompt", "conv_child"));
      await waitFor(() => expect(list.scrollTop).toBe(0));
    } finally {
      if (top) Object.defineProperty(HTMLElement.prototype, "offsetTop", top);
      else delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop;
    }
  });

  it("opens a tray with each prompt's real card, the child's title and an open link", async () => {
    renderChildDock([ask, permission]);
    fireEvent.click(await screen.findByTestId("ae-dock-caret"));
    const cards = await screen.findAllByTestId("ae-dock-child-prompt");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("Halcyon Orbital");
    expect(cards[0]!.textContent).toContain("Keep the Fuel Cost measure?");
    expect(within(cards[0]!).getByText("Keep it")).toBeTruthy();
    expect(cards[1]!.textContent).toContain("Brightwater");
    expect(cards[1]!.textContent).toContain("pbi-tools deploy");
    expect(within(cards[1]!).getAllByRole("button").length).toBeGreaterThan(0);
    const links = screen.getAllByTestId("ae-dock-child-open");
    expect(links[0]!.getAttribute("href")).toBe("/c/conv_child");
    expect(links[1]!.getAttribute("href")).toBe("/c/conv_other");
    // A tall prompt scrolls inside the tray, which gets up to half the screen.
    expect(screen.getByTestId("ae-dock-list").className).toContain("max-h-[50vh]");
  });

  it("the strip's Answer opens the tray", async () => {
    renderChildDock([ask]);
    fireEvent.click(await screen.findByTestId("ae-dock-child-answer"));
    expect(await screen.findByTestId("ae-dock-child-prompt")).toBeTruthy();
  });

  it("answers in the child, not in this chat, and the line leaves the dock", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => json({ queued: false }, 202));
    renderChildDock([ask]);
    fireEvent.click(await screen.findByTestId("ae-dock-child-answer"));
    const prompt = await screen.findByTestId("ae-dock-child-prompt");
    fireEvent.click(within(prompt).getByText("Keep it"));
    fireEvent.click(within(prompt).getByRole("button", { name: /submit/i }));
    await waitFor(() =>
      expect(authenticatedFetch).toHaveBeenCalledWith(
        "/v1/sessions/conv_child/elicitations/fam1/resolve",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = vi
      .mocked(authenticatedFetch)
      .mock.calls.find(([path]) => String(path).includes("/resolve"))!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      action: "accept",
      content: { "Keep the Fuel Cost measure?": "Keep it" },
    });
    await waitFor(() => expect(screen.queryByTestId("ae-action-dock")).toBeNull());
  });
  it("renders an MCP server's confirmation as one button per choice and answers in the child", async () => {
    const field = "Confirm the operation";
    const mcp = {
      ...(ask as object),
      elicitationId: "mcp1",
      targetSessionId: "conv_pbi",
      familyChild: { title: "Halcyon Orbital" },
      message: "powerbi-modeling-sp asks: Delete table Sales?",
      policyName: "claude_native_permission",
      askUserQuestion: null,
      requestedSchema: {
        type: "object",
        properties: {
          [field]: {
            type: "string",
            enum: ["Yes", "No"],
            enumNames: ["Continue the operation", "Decline the operation"],
          },
        },
        required: [field],
      },
    } as unknown as AnyBlock;
    vi.mocked(authenticatedFetch).mockImplementation(() => json({ queued: false }, 202));
    renderChildDock([mcp]);
    fireEvent.click(await screen.findByTestId("ae-dock-child-answer"));
    const prompt = await screen.findByTestId("ae-dock-child-prompt");
    expect(prompt.textContent).toContain("powerbi-modeling-sp asks");
    expect(within(prompt).getByRole("button", { name: "Decline the operation" })).toBeTruthy();
    expect(within(prompt).queryByRole("combobox")).toBeNull();
    fireEvent.click(within(prompt).getByRole("button", { name: "Continue the operation" }));
    await waitFor(() => {
      const call = vi
        .mocked(authenticatedFetch)
        .mock.calls.find(([path]) => String(path).includes("/resolve"))!;
      expect(call[0]).toBe("/v1/sessions/conv_pbi/elicitations/mcp1/resolve");
      expect(JSON.parse(String(call[1]?.body))).toEqual({
        action: "accept",
        content: { [field]: "Yes" },
      });
    });
  });
});

describe("the Compact card", () => {
  const SUGGEST = {
    "ae.handoff": "suggest",
    "ae.handoff_at": "370000",
    "ae.status": "working",
    "omnigent.wrapper": "claude-code-native-ui",
  };
  const snoozeCalls = () =>
    vi.mocked(authenticatedFetch).mock.calls.filter(([u]) => String(u).endsWith("/handoff/snooze"));

  beforeEach(() => {
    vi.mocked(authenticatedFetch).mockImplementation(() => json({ ok: true }));
  });

  it("shows the size and Compact and Not now when the label asks", async () => {
    renderDock([], [], SUGGEST);
    const lead = await screen.findByTestId("ae-dock-lead");
    expect(lead.textContent).toContain(
      "This chat is at 370k tokens. Every reply re-reads all of it.",
    );
    expect(within(lead).getByTestId("ae-dock-compact")).toBeTruthy();
    expect(within(lead).getByTestId("ae-dock-context-later")).toBeTruthy();
    // On a phone the strip drops Not now so Compact is never clipped; the tray keeps it.
    expect(within(lead).getByTestId("ae-dock-context-later").className).toContain("hidden");
  });

  it("is absent without the label, when snoozed, or for a different open chat", async () => {
    const none = renderDock([], [], { "ae.status": "working" });
    await waitFor(() =>
      expect(none.container.querySelector("[data-testid=ae-dock-lead]")).toBeNull(),
    );
    cleanup();
    const snoozed = renderDock([], [], { ...SUGGEST, "ae.handoff": "snoozed" });
    expect(snoozed.container.querySelector("[data-testid=ae-dock-lead]")).toBeNull();
    cleanup();
    const other = renderDock([], [], SUGGEST);
    await screen.findByTestId("ae-dock-lead");
    act(() => useChatStore.setState({ conversationId: "elsewhere" }));
    await waitFor(() =>
      expect(other.container.querySelector("[data-testid=ae-dock-lead]")).toBeNull(),
    );
  });

  it.each([
    ["a family child", { "ae.orch": "conv_lead" }],
    ["a reviewer", { "ae.role": "reviewer" }],
    ["a fork", { "omnigent.fork.source_id": "conv_x" }],
    ["a side chat", { "omnigent.side_chat": "1" }],
    ["a Codex chat", { "omnigent.wrapper": "codex-native-ui" }],
  ])("shows no card for %s with a stale suggest label", async (_name, extra) => {
    const view = renderDock([], [], { ...SUGGEST, ...extra });
    await waitFor(() => expect(authenticatedFetch).not.toHaveBeenCalled());
    expect(view.container.querySelector("[data-testid=ae-dock-lead]")).toBeNull();
    expect(view.container.querySelector("[data-testid=ae-dock-compact]")).toBeNull();
  });

  it("Compact asks twice, compacts the open chat, then snoozes", async () => {
    const compact = vi.fn(() => Promise.resolve());
    renderDock([], [], SUGGEST);
    useChatStore.setState({ compact });
    const button = await screen.findByTestId("ae-dock-compact");
    fireEvent.click(button);
    expect(button.textContent).toBe("Compact now?");
    expect(compact).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(compact).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(snoozeCalls()).toHaveLength(1));
    expect(String(snoozeCalls()[0]![0])).toBe("/v1/ae/sessions/s1/handoff/snooze");
  });

  it("does not snooze when the compact failed", async () => {
    const compact = vi.fn(() => Promise.reject(new Error("409 Conflict")));
    renderDock([], [], SUGGEST);
    useChatStore.setState({ compact });
    const button = await screen.findByTestId("ae-dock-compact");
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByRole("alert");
    expect(snoozeCalls()).toHaveLength(0);
  });

  it("disables Compact while the chat is running", async () => {
    renderDock([], [], SUGGEST);
    act(() => useChatStore.setState({ sessionStatus: "running" }));
    try {
      expect(await screen.findByTestId("ae-dock-compact")).toBeDisabled();
    } finally {
      // The store keeps a per-session copy that the next render of "s1" would restore.
      act(() => useChatStore.setState({ sessionStatus: "idle" }));
    }
  });

  it("Not now posts the snooze and nothing else", async () => {
    const compact = vi.fn(() => Promise.resolve());
    renderDock([], [], SUGGEST);
    useChatStore.setState({ compact });
    fireEvent.click(await screen.findByTestId("ae-dock-context-later"));
    await waitFor(() => expect(snoozeCalls()).toHaveLength(1));
    expect(compact).not.toHaveBeenCalled();
  });

  it("treats a 409 from Not now as a quiet no-op", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ error: { message: "this chat already handed off" } }, 409),
    );
    const seen: unknown[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent).detail.content);
    window.addEventListener("omnigent:toast", listen);
    try {
      renderDock([], [], SUGGEST);
      fireEvent.click(await screen.findByTestId("ae-dock-context-later"));
      await waitFor(() => expect(snoozeCalls()).toHaveLength(1));
      await waitFor(() => expect(screen.getByTestId("ae-dock-context-later")).not.toBeDisabled());
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener("omnigent:toast", listen);
    }
  });

  it("does not toast when the snooze after Compact gets a 409", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ error: { message: "this chat already handed off" } }, 409),
    );
    const seen: unknown[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent).detail.content);
    window.addEventListener("omnigent:toast", listen);
    try {
      const compact = vi.fn(() => Promise.resolve());
      renderDock([], [], SUGGEST);
      useChatStore.setState({ compact });
      const button = await screen.findByTestId("ae-dock-compact");
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(snoozeCalls()).toHaveLength(1));
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
      });
      expect(compact).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener("omnigent:toast", listen);
    }
  });

  it("toasts when the snooze after Compact fails some other way", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ error: { message: "only the owner" } }, 403),
    );
    const seen: unknown[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent).detail.content);
    window.addEventListener("omnigent:toast", listen);
    try {
      const compact = vi.fn(() => Promise.resolve());
      renderDock([], [], SUGGEST);
      useChatStore.setState({ compact });
      const button = await screen.findByTestId("ae-dock-compact");
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(seen).toHaveLength(1));
      expect(String(seen[0])).toContain("could not be snoozed");
    } finally {
      window.removeEventListener("omnigent:toast", listen);
    }
  });

  it("tells the viewer when Not now is refused", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ error: { message: "only the owner can change session s1" } }, 403),
    );
    const seen: unknown[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent).detail.content);
    window.addEventListener("omnigent:toast", listen);
    try {
      renderDock([], [], SUGGEST);
      fireEvent.click(await screen.findByTestId("ae-dock-context-later"));
      await waitFor(() => expect(seen).toHaveLength(1));
      expect(String(seen[0])).toContain("Could not snooze this chat");
    } finally {
      window.removeEventListener("omnigent:toast", listen);
    }
  });
});
