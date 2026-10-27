import { describe, expect, it } from "vitest";
import {
  AE_BRANCH_UPDATE_MS,
  AE_DOCK_LIVE_MS,
  type AeDockItem,
  type AeDockPr,
  aeAgo,
  aeBranchUpdatePending,
  aeDeployText,
  aeDeployTrack,
  aeDockArrange,
  aeDockBadgeLabel,
  aeDockChildPrompts,
  aeDockChildPromptText,
  aeDockDeploys,
  aeDockDrafts,
  aeDockMerges,
  aeDockPrAnchor,
  aeDockQuestions,
  aeDockQuestionText,
  aeDockSummary,
  aeDockWaiting,
  aeDraftText,
  aeHolderName,
  aeWaitingText,
} from "@/lib/aeActionDock";
import type { AePrDeploy } from "@/lib/aePrDeploy";
import type { AePrCard } from "@/lib/aePrs";

const REPO = "analyticendeavors/omnigent-ae";
const NOW = Date.parse("2026-10-20T22:00:00Z");
const clock = (iso: string) => `at ${iso.slice(11, 16)}`;

function card(number: number, over: Partial<AePrCard> = {}): AePrCard {
  return {
    repo: REPO,
    number,
    url: `https://github.com/${REPO}/pull/${number}`,
    title: `PR ${number}`,
    state: "open",
    draft: false,
    author: null,
    head_ref: "b",
    base_ref: "main",
    head_sha: "abc",
    ci: { state: "passing", passing: 5, failing: 0, pending: 0, total: 5 },
    mergeable: { state: "clean", detail: "" },
    review: { state: "none", approvals: 0, changes_requested: 0, requested: [] },
    merge: { methods: ["squash"], default_method: "squash", allowed: true, reason: null },
    ...over,
  };
}

function pr(number: number, over: Partial<AePrCard> = {}, repo = REPO): AeDockPr {
  return {
    url: `https://github.com/${repo}/pull/${number}`,
    repo,
    number,
    card: card(number, { repo, ...over }),
  };
}

function deploy(over: Partial<AePrDeploy> = {}): AePrDeploy {
  return {
    state: "waiting",
    running: "ae-v0.18.0.31",
    latest: "ae-v0.18.0.32",
    mid_turn: 0,
    hold_until: null,
    hold_by: null,
    merged_at: "2026-10-20T21:56:00Z",
    error: null,
    ...over,
  };
}

const anchor = (n: number) => aeDockPrAnchor(REPO, n);

describe("questions", () => {
  it("reads the first AskUserQuestion, then a command, then the prompt", () => {
    expect(
      aeDockQuestionText({
        id: "e1",
        message: "Claude wants to ask",
        askUserQuestion: { questions: [{ question: "Run the fix now or park it?" }] },
      }),
    ).toBe("Run the fix now or park it?");
    expect(aeDockQuestionText({ id: "e2", codexCommand: { command: "rm -rf build" } })).toBe(
      "Run rm -rf build?",
    );
    expect(aeDockQuestionText({ id: "e3", message: "Allow Bash?\nmore" })).toBe("Allow Bash?");
    expect(aeDockQuestionText({ id: "e4" })).toBe("A question is waiting");
  });

  it("keeps the transcript's order as age and anchors on the card id", () => {
    const items = aeDockQuestions([{ id: "a" }, { id: "b" }]);
    expect(items.map((item) => [item.anchor, item.order])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });
});

describe("merges", () => {
  it("takes only cards ready to merge", () => {
    const items = aeDockMerges([
      pr(1),
      pr(2, { ci: { state: "pending", passing: 1, failing: 0, pending: 1, total: 2 } }),
      pr(3, { draft: true, merge: { ...card(3).merge, allowed: false } }),
      { url: "u", repo: REPO, number: 4 },
      pr(5, { state: "merged" }),
    ]);
    expect(items.map((item) => item.number)).toEqual([1]);
    expect(items[0]!.anchor).toBe(`${REPO}#1`);
  });
});

describe("drafts", () => {
  const draft = { draft: true, mergeable: { state: "draft", detail: "" } } as const;

  it("takes open drafts whatever their checks, never ready, closed or unfetched ones", () => {
    const items = aeDockDrafts([
      pr(1),
      pr(2, draft),
      pr(3, { ...draft, ci: { state: "failing", passing: 4, failing: 1, pending: 0, total: 5 } }),
      { url: "u", repo: REPO, number: 4 },
      pr(5, { ...draft, state: "closed" }),
    ]);
    expect(items.map((item) => item.number)).toEqual([2, 3]);
    expect(aeDockMerges([pr(6, { draft: true })])).toEqual([]);
    expect(items[0]!.key).toBe(`draft:${anchor(2)}`);
    expect(aeDraftText(items[0]!)).toBe("draft · 5/5 checks");
  });

  it("ranks after merges and before deploys, with its own badge", () => {
    const drafts = aeDockDrafts([pr(182, draft), pr(183, draft)]);
    const arranged = aeDockArrange([...sample(), ...drafts], new Set());
    expect(arranged.map((item) => item.key).slice(2)).toEqual([
      `merge:${anchor(180)}`,
      `merge:${anchor(181)}`,
      `draft:${anchor(182)}`,
      `draft:${anchor(183)}`,
      `deploy:${anchor(179)}`,
    ]);
    expect(aeDockSummary(arranged, clock)!.badges).toContainEqual({
      kind: "draft",
      count: 2,
      label: "2 drafts",
    });
    expect(aeDockBadgeLabel(drafts.slice(0, 1))).toBe("#182 draft");
  });
});

describe("waiting", () => {
  const running = {
    ci: { state: "pending", passing: 11, failing: 0, pending: 1, total: 12 },
  } as const;
  const merge = card(0).merge;

  it("takes every other open pull request with its receipt's word and tone", () => {
    const items = aeDockWaiting([
      pr(1),
      pr(2, running),
      pr(3, {
        mergeable: { state: "conflicted", detail: "" },
        merge: { ...merge, allowed: false },
      }),
      pr(4, { ci: { state: "failing", passing: 4, failing: 1, pending: 0, total: 5 } }),
      pr(5, {
        mergeable: { state: "behind", detail: "" },
        update_branch: { allowed: true, reason: null },
        merge: { ...merge, allowed: false },
      }),
      pr(6, { mergeable: { state: "blocked", detail: "" }, merge: { ...merge, allowed: false } }),
      pr(7, { draft: true, mergeable: { state: "draft", detail: "" } }),
      pr(8, { state: "closed" }),
      pr(9, { state: "merged" }),
      { url: "u", repo: REPO, number: 10 },
    ]);
    expect(items.map((item) => [item.number, aeWaitingText(item), item.receipt.tone])).toEqual([
      [2, "checks 11/12", "amber"],
      [3, "conflicts", "red"],
      [4, "1 check failed", "red"],
      [5, "behind main", "blue"],
      [6, "blocked", "amber"],
    ]);
    expect(items[0]!.key).toBe(`waiting:${anchor(2)}`);
  });

  it("never overlaps merges or drafts, so a pull request shows once", () => {
    const prs = [
      pr(1),
      pr(2, running),
      pr(3, { draft: true, mergeable: { state: "draft", detail: "" } }),
    ];
    const keys = [...aeDockMerges(prs), ...aeDockDrafts(prs), ...aeDockWaiting(prs)].map(
      (item) => item.anchor,
    );
    expect(keys).toEqual([anchor(1), anchor(3), anchor(2)]);
  });

  it("ranks after drafts and before deploys, with its own badge", () => {
    const waiting = aeDockWaiting([pr(228, running), pr(229, running)]);
    const arranged = aeDockArrange([...sample(), ...waiting], new Set());
    expect(arranged.map((item) => item.key).slice(-3)).toEqual([
      `waiting:${anchor(228)}`,
      `waiting:${anchor(229)}`,
      `deploy:${anchor(179)}`,
    ]);
    expect(aeDockSummary(arranged, clock)!.badges).toContainEqual({
      kind: "waiting",
      count: 2,
      label: "2 not ready",
    });
    expect(aeDockBadgeLabel(waiting.slice(0, 1))).toBe("#228 checks 11/12");
  });
});

describe("branch update", () => {
  it("counts as running only while the head is unmoved and inside the window", () => {
    const entry = { sha: "abc", started: NOW };
    expect(aeBranchUpdatePending(entry, "abc", NOW + 1_000)).toBe(true);
    expect(aeBranchUpdatePending(entry, "def", NOW + 1_000)).toBe(false);
    expect(aeBranchUpdatePending(entry, "abc", NOW + AE_BRANCH_UPDATE_MS)).toBe(false);
    expect(aeBranchUpdatePending(null, "abc", NOW)).toBe(false);
    expect(aeBranchUpdatePending(undefined, "abc", NOW)).toBe(false);
  });
});

describe("deploy lifecycle", () => {
  it("tracks a pull request seen waiting, then the time it turned live", () => {
    const waiting = new Map([[anchor(9), deploy()]]);
    const t1 = aeDeployTrack({}, waiting, NOW);
    expect(t1).toEqual({ [anchor(9)]: { liveAt: null } });
    expect(aeDeployTrack(t1, waiting, NOW + 1)).toBe(t1);
    const live = new Map([[anchor(9), deploy({ state: "live" })]]);
    expect(aeDeployTrack(t1, live, NOW + 5)).toEqual({ [anchor(9)]: { liveAt: NOW + 5 } });
  });

  it("never tracks one first seen live", () => {
    const live = new Map([[anchor(9), deploy({ state: "live" })]]);
    expect(aeDeployTrack({}, live, NOW)).toEqual({});
  });

  it("shows waiting, live for a minute, and nothing for unknown, other repos or dismissed", () => {
    const prs = [
      pr(9, { state: "merged" }),
      pr(10, { state: "merged" }),
      pr(11, { state: "merged" }),
      pr(12, { state: "merged" }, "o/other"),
      pr(13, { state: "merged" }),
    ];
    const deploys = new Map([
      [anchor(9), deploy()],
      [anchor(10), deploy({ state: "live" })],
      [anchor(11), deploy({ state: "unknown" })],
      [aeDockPrAnchor("o/other", 12), deploy()],
      [anchor(13), deploy()],
    ]);
    const track = {
      [anchor(9)]: { liveAt: null },
      [anchor(10)]: { liveAt: NOW - 10_000 },
      [anchor(11)]: { liveAt: null },
      [aeDockPrAnchor("o/other", 12)]: { liveAt: null },
      [anchor(13)]: { liveAt: null },
    };
    const dismissed = new Set([anchor(13)]);
    const items = aeDockDeploys(prs, deploys, track, dismissed, NOW);
    expect(items.map((item) => [item.number, item.deploy.state])).toEqual([
      [9, "waiting"],
      [10, "live"],
    ]);
    const later = aeDockDeploys(prs, deploys, track, dismissed, NOW - 10_000 + AE_DOCK_LIVE_MS);
    expect(later.map((item) => item.number)).toEqual([9]);
  });
});

function sample(): AeDockItem[] {
  const prs = [pr(180), pr(181), pr(179, { state: "merged" })];
  return [
    ...aeDockDeploys(
      prs,
      new Map([[anchor(179), deploy({ hold_until: "2026-10-21T05:50:00Z" })]]),
      { [anchor(179)]: { liveAt: null } },
      new Set(),
      NOW,
    ),
    ...aeDockMerges(prs),
    ...aeDockQuestions([{ id: "q1" }, { id: "q2" }]),
  ];
}

describe("arrange and summary", () => {
  it("orders question, merge, deploy, oldest first within a kind", () => {
    const arranged = aeDockArrange(sample(), new Set());
    expect(arranged.map((item) => item.key)).toEqual([
      "question:q1",
      "question:q2",
      `merge:${anchor(180)}`,
      `merge:${anchor(181)}`,
      `deploy:${anchor(179)}`,
    ]);
  });

  it("hides a question whose card is on screen, never a pull request", () => {
    const arranged = aeDockArrange(sample(), new Set(["q1", anchor(181)]));
    expect(arranged.map((item) => item.anchor)).toEqual([
      "q2",
      anchor(180),
      anchor(181),
      anchor(179),
    ]);
  });

  it("leads with the most urgent and badges each other kind", () => {
    const summary = aeDockSummary(aeDockArrange(sample(), new Set()), clock)!;
    expect(summary.lead.key).toBe("question:q1");
    expect(summary.more).toBe(1);
    expect(summary.total).toBe(5);
    expect(summary.badges).toEqual([
      { kind: "merge", count: 2, label: "2 to merge" },
      { kind: "deploy", count: 1, label: "#179 deploy at 05:50" },
    ]);
  });

  it("badges a single question and a merge lead with no extras", () => {
    const arranged = aeDockArrange(
      sample().filter((item) => item.anchor !== anchor(181)),
      new Set(["q2"]),
    );
    const withoutFirst = arranged.filter((item) => item.anchor !== "q1");
    const summary = aeDockSummary(withoutFirst, clock)!;
    expect(summary.lead.kind).toBe("merge");
    expect(summary.more).toBe(0);
    expect(aeDockBadgeLabel(arranged.filter((item) => item.kind === "question"))).toBe(
      "Question waiting",
    );
  });

  it("is null when nothing waits", () => {
    expect(aeDockSummary([])).toBeNull();
  });
});

describe("deploy text", () => {
  const item = (over: Partial<AePrDeploy>) =>
    aeDockDeploys(
      [pr(179, { state: "merged" })],
      new Map([[anchor(179), deploy(over)]]),
      { [anchor(179)]: { liveAt: over.state === "live" ? NOW : null } },
      new Set(),
      NOW,
    )[0]!;

  it("says what the deploy waits on", () => {
    expect(aeDeployText(item({ mid_turn: 2 }), NOW, clock)).toBe(
      "merged 4m ago · deploy waits on 2 busy sessions",
    );
    expect(aeDeployText(item({ mid_turn: 1 }), NOW, clock)).toBe(
      "merged 4m ago · deploy waits on 1 busy session",
    );
    expect(
      aeDeployText(
        item({ mid_turn: 3, hold_until: "2026-10-21T05:50:00Z", hold_by: "reid@x.com" }),
        NOW,
        clock,
      ),
    ).toBe("merged 4m ago · held until at 05:50 by reid");
    expect(aeDeployText(item({}), NOW, clock)).toBe("merged 4m ago · waiting for deploy");
    expect(aeDeployText(item({ state: "live", running: "ae-v0.18.0.32" }), NOW, clock)).toBe(
      "live in ae-v0.18.0.32",
    );
  });

  it("counts deploys in a badge", () => {
    const two = [item({}), { ...item({}), number: 180 }];
    expect(aeDockBadgeLabel(two)).toBe("2 deploying");
    expect(aeDockBadgeLabel([item({})])).toBe("#179 deploying");
    expect(aeDockBadgeLabel([item({ state: "live" })])).toBe("#179 live");
  });

  it("formats ages and holders", () => {
    expect(aeAgo(null, NOW)).toBeNull();
    expect(aeAgo("2026-10-20T21:59:40Z", NOW)).toBe("just now");
    expect(aeAgo("2026-10-20T19:00:00Z", NOW)).toBe("3h ago");
    expect(aeAgo("2026-10-18T19:00:00Z", NOW)).toBe("2d ago");
    expect(aeHolderName("you@example.com")).toBe("you");
    expect(aeHolderName("local")).toBe("local");
  });
});

describe("a child's prompt in the dock", () => {
  const child = (id: string, title: string, over = {}) => ({
    id,
    childId: `conv_${id}`,
    childTitle: title,
    message: "Approve?",
    askUserQuestion: { questions: [{ question: "Keep the Fuel Cost measure?" }] },
    ...over,
  });

  it("ranks right after a question and ahead of a limit or a merge, oldest first", () => {
    const arranged = aeDockArrange(
      [
        ...aeDockDeploys([], new Map(), {}, new Set(), NOW),
        ...aeDockMerges([]),
        ...aeDockChildPrompts([child("c1", "Halcyon Orbital"), child("c2", "Brightwater")]),
        ...aeDockQuestions([{ id: "q1" }]),
      ],
      new Set(),
    );
    expect(arranged.map((item) => item.key)).toEqual([
      "question:q1",
      "childPrompt:c1",
      "childPrompt:c2",
    ]);
  });

  it("is never hidden as an on-screen question", () => {
    const arranged = aeDockArrange(aeDockChildPrompts([child("c1", "Halcyon")]), new Set(["c1"]));
    expect(arranged).toHaveLength(1);
  });

  it("reads 'Title: question' on the bar and '2 child prompts' as a badge", () => {
    const items = aeDockChildPrompts([
      child("c1", "Halcyon Orbital"),
      child("c2", "Brightwater", {
        askUserQuestion: null,
        message: "Allow Bash: pbi-tools deploy ./model?",
      }),
    ]);
    expect(aeDockChildPromptText(items[0]!)).toBe("Halcyon Orbital: Keep the Fuel Cost measure?");
    expect(aeDockChildPromptText(items[1]!)).toBe(
      "Brightwater: Allow Bash: pbi-tools deploy ./model?",
    );
    expect(aeDockBadgeLabel(items)).toBe("2 child prompts");
    expect(aeDockBadgeLabel(items.slice(0, 1))).toBe("Child prompt");
    const summary = aeDockSummary(
      aeDockArrange([...aeDockMerges([]), ...items], new Set()),
      clock,
    )!;
    expect(summary.lead.kind).toBe("childPrompt");
    expect(summary.more).toBe(1);
  });
});
