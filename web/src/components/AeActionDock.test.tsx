import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { useAePublishDockQuestions } from "@/hooks/useAeActionDockItems";
import type { AnyBlock } from "@/lib/blocks";
import { authenticatedFetch } from "@/lib/identity";
import type { AePrCard } from "@/lib/aePrs";
import { useChatStore } from "@/store/chatStore";
import { AeActionDock } from "./AeActionDock";

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

function renderDock(texts: string[], pending: Question[] = []) {
  useChatStore.setState({
    conversationId: "s1",
    blocks: texts.map((text, i) => said(text, `m${i}`)),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tracked = texts.flatMap((text) => text.match(/https:\/\/\S+/g) ?? []);
  qc.setQueryData(["github-info", "s1"], {
    available: true,
    prs: tracked.map((u) => ({ url: u })),
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Questions pending={pending} />
        <AeActionDock sessionId="s1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
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
  useChatStore.setState({ conversationId: null, blocks: [] });
});

describe("AeActionDock", () => {
  it("draws nothing when nothing waits", async () => {
    serve({
      7: card(7, { ci: { state: "failing", passing: 1, failing: 1, pending: 0, total: 2 } }),
    });
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
      expect(within(lead).getByTestId("ae-dock-badge").textContent).toContain("2 to merge"),
    );
  });

  it("a badge opens the list; the caret closes it and the choice is remembered", async () => {
    serve({ 180: card(180) });
    renderDock([`See ${url(180)}`], [question]);
    const badge = await screen.findByTestId("ae-dock-badge");
    fireEvent.click(badge);
    const lines = screen.getAllByTestId("ae-dock-line");
    expect(lines.map((line) => line.dataset.kind)).toEqual(["question", "merge"]);
    expect(screen.getByTestId("ae-action-dock").textContent).toContain("2 waiting");
    expect(window.localStorage.getItem("ae-action-dock:open:s1")).toBe("1");
    fireEvent.click(screen.getByTestId("ae-dock-caret"));
    expect(screen.getByTestId("ae-dock-lead")).toBeTruthy();
    expect(window.localStorage.getItem("ae-action-dock:open:s1")).toBeNull();
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

  it("a confirm opened from a list line lifts the list's height cap until Cancel", async () => {
    serve({ 180: card(180) });
    renderDock([`See ${url(180)}`], [question]);
    fireEvent.click(await screen.findByTestId("ae-dock-badge"));
    const list = screen.getByTestId("ae-dock-list");
    expect(list.className).toContain("max-h-[120px]");
    fireEvent.click(within(list).getByTestId("ae-dock-merge"));
    expect(within(list).getByRole("group", { name: "Confirm merge" })).toBeTruthy();
    expect(list.className).not.toContain("max-h-[120px]");
    expect(list.className).not.toContain("overflow-y-auto");
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

  it("hides an item while its card is on screen in the feed", async () => {
    const observed: Element[] = [];
    let report: (entries: Partial<IntersectionObserverEntry>[]) => void = () => {};
    class FakeObserver {
      constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
        report = callback;
      }
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    try {
      const feedCard = document.createElement("article");
      feedCard.setAttribute("data-ae-pr", `${REPO}#180`);
      document.body.appendChild(feedCard);
      serve({ 180: card(180) });
      renderDock([`Opened ${url(180)}`]);
      await screen.findByTestId("ae-dock-merge");
      expect(observed).toContain(feedCard);
      act(() => report([{ target: feedCard, isIntersecting: true }]));
      expect(screen.queryByTestId("ae-action-dock")).toBeNull();
      act(() => report([{ target: feedCard, isIntersecting: false }]));
      expect(screen.getByTestId("ae-dock-merge")).toBeTruthy();
      feedCard.remove();
    } finally {
      vi.unstubAllGlobals();
    }
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
