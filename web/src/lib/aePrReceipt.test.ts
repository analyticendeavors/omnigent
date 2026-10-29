import { describe, expect, it } from "vitest";
import type { AePrDeploy } from "@/lib/aePrDeploy";
import type { AePrCard } from "@/lib/aePrs";
import { aePrReceipt, aeReceiptClock, aeReceiptHint } from "./aePrReceipt";

const RELEASE = "analyticendeavors/omnigent-ae";
const MERGED_AT = "2026-10-21T03:35:00Z";

function card(overrides: Partial<AePrCard> = {}): AePrCard {
  return {
    repo: RELEASE,
    number: 221,
    url: `https://github.com/${RELEASE}/pull/221`,
    title: "Take the image name from one variable",
    state: "open",
    draft: false,
    author: "demo-author",
    head_ref: "ae/image-var",
    base_ref: "main",
    head_sha: "a1b2c3d",
    ci: { state: "passing", passing: 12, failing: 0, pending: 0, total: 12 },
    mergeable: { state: "clean", detail: "" },
    review: { state: "approved", approvals: 1, changes_requested: 0, requested: [] },
    merge: { methods: ["squash"], default_method: "squash", allowed: true, reason: null },
    ...overrides,
  };
}

function deploy(state: AePrDeploy["state"]): AePrDeploy {
  return {
    state,
    running: "ae-v0.18.0.59",
    latest: "ae-v0.18.0.59",
    mid_turn: 0,
    hold_until: null,
    hold_by: null,
    merged_at: MERGED_AT,
    error: null,
  };
}

const running = { state: "pending" as const, passing: 7, failing: 0, pending: 5, total: 12 };
const failing = { state: "failing" as const, passing: 10, failing: 2, pending: 0, total: 12 };

describe("aeReceiptClock", () => {
  it("gives the local hour and minute, zero padded", () => {
    const at = new Date(MERGED_AT);
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(aeReceiptClock(MERGED_AT)).toBe(`${pad(at.getHours())}:${pad(at.getMinutes())}`);
    expect(aeReceiptClock(MERGED_AT)).toMatch(/^\d\d:\d\d$/);
  });

  it("claims no time for a missing or unreadable one", () => {
    expect(aeReceiptClock(null)).toBeNull();
    expect(aeReceiptClock(undefined)).toBeNull();
    expect(aeReceiptClock("not a time")).toBeNull();
  });
});

describe("aePrReceipt", () => {
  const clock = aeReceiptClock(MERGED_AT);

  it.each([
    ["ready", card(), "ready", "green", "ring"],
    [
      "checks running",
      card({ ci: running, merge: { ...card().merge, allowed: false } }),
      "checks 7/12",
      "amber",
      "ring",
    ],
    [
      "changes requested",
      card({ review: { ...card().review, state: "changes_requested" } }),
      "changes requested",
      "amber",
      "ring",
    ],
    [
      "conflicts",
      card({ mergeable: { state: "conflicted", detail: "" } }),
      "conflicts",
      "red",
      "ring",
    ],
    ["failed checks", card({ ci: failing }), "2 checks failed", "red", "ring"],
    ["one failed check", card({ ci: { ...failing, failing: 1 } }), "1 check failed", "red", "ring"],
    [
      "behind main, Update branch live",
      card({
        mergeable: { state: "behind", detail: "" },
        update_branch: { allowed: true, reason: null },
      }),
      "behind main · update branch",
      "blue",
      "ring",
    ],
    [
      "behind main, Update branch refused",
      card({
        mergeable: { state: "behind", detail: "" },
        update_branch: { allowed: false, reason: "The head is on a fork." },
        merge: { ...card().merge, allowed: false },
      }),
      "behind main",
      "amber",
      "ring",
    ],
    [
      "allowed but not clean",
      card({ mergeable: { state: "unstable", detail: "" } }),
      "mergeable",
      "amber",
      "ring",
    ],
    [
      "update branch offered",
      card({
        mergeable: { state: "blocked", detail: "" },
        update_branch: { allowed: true, reason: null },
      }),
      "behind main · update branch",
      "blue",
      "ring",
    ],
    [
      "draft with checks",
      card({ draft: true, mergeable: { state: "draft", detail: "" } }),
      "draft · checks 12/12",
      "gray",
      "dashed",
    ],
    [
      "draft with failed checks",
      card({ draft: true, ci: failing }),
      "draft · 2 checks failed",
      "gray",
      "dashed",
    ],
    [
      "draft without checks",
      card({ draft: true, ci: { state: "none", passing: 0, failing: 0, pending: 0, total: 0 } }),
      "draft",
      "gray",
      "dashed",
    ],
    [
      "review requested",
      card({
        review: { ...card().review, state: "review_required" },
        mergeable: { state: "blocked", detail: "" },
        merge: { ...card().merge, allowed: false },
      }),
      "review requested",
      "amber",
      "ring",
    ],
    [
      "checking conflicts",
      card({ mergeable: { state: "checking", detail: "" } }),
      "checking conflicts",
      "amber",
      "ring",
    ],
  ] as const)("%s", (_, input, word, tone, icon) => {
    expect(aePrReceipt(input)).toEqual({ word, tone, icon, dim: false });
  });

  it("ranks draft over conflicts, conflicts over failed checks, failed over changes requested", () => {
    const changes = { ...card().review, state: "changes_requested" as const };
    const conflicted = { state: "conflicted" as const, detail: "" };
    expect(aePrReceipt(card({ draft: true, mergeable: conflicted, ci: failing })).word).toMatch(
      /^draft/,
    );
    expect(aePrReceipt(card({ mergeable: conflicted, ci: failing })).word).toBe("conflicts");
    expect(aePrReceipt(card({ ci: failing, review: changes })).word).toBe("2 checks failed");
    expect(aePrReceipt(card({ ci: running, review: changes })).word).toBe("changes requested");
    expect(
      aePrReceipt(card({ ci: running, mergeable: { state: "behind", detail: "" } })).word,
    ).toBe("checks 7/12");
  });

  it("names the base it is behind, or says base when it is unknown", () => {
    const behind = {
      mergeable: { state: "behind" as const, detail: "" },
      update_branch: { allowed: true, reason: null },
    };
    expect(aePrReceipt(card({ ...behind, base_ref: "dev" })).word).toBe(
      "behind dev · update branch",
    );
    expect(aePrReceipt(card({ ...behind, base_ref: null })).word).toBe(
      "behind base · update branch",
    );
  });

  describe("merged in the release repo", () => {
    const merged = card({ state: "merged", merged_at: MERGED_AT });

    it("is a purple ring with the merge time until the release runs it", () => {
      expect(aePrReceipt(merged, { deploy: deploy("waiting") })).toEqual({
        word: `merged ${clock}`,
        tone: "purple",
        icon: "ring",
        dim: false,
      });
      // Not read yet, or GitHub off: still waiting as far as the receipt knows.
      expect(aePrReceipt(merged).tone).toBe("purple");
      expect(aePrReceipt(merged, { deploy: deploy("unknown") }).tone).toBe("purple");
    });

    it("says live, solid and quiet, naming no release", () => {
      expect(aePrReceipt(merged, { deploy: deploy("live") })).toEqual({
        word: "live",
        tone: "done",
        icon: "filled",
        dim: false,
      });
    });

    it("takes the time from the deploy state when the card has none", () => {
      expect(aePrReceipt(card({ state: "merged" }), { deploy: deploy("waiting") }).word).toBe(
        `merged ${clock}`,
      );
      expect(aePrReceipt(card({ state: "merged" })).word).toBe("merged");
    });

    it("counts a merge made on this page before GitHub echoes it", () => {
      expect(aePrReceipt(card(), { mergedHere: true })).toMatchObject({
        word: "merged",
        tone: "purple",
      });
    });
  });

  it("ends at merged, solid and quiet, outside the release repo", () => {
    const other = card({ repo: "analyticendeavors/agents-and-automation", state: "merged" });
    expect(aePrReceipt({ ...other, merged_at: MERGED_AT })).toEqual({
      word: `merged ${clock}`,
      tone: "done",
      icon: "filled",
      dim: false,
    });
  });

  it("dims a pull request closed without merging", () => {
    expect(aePrReceipt(card({ state: "closed" }))).toEqual({
      word: "closed",
      tone: "gray",
      icon: "ring",
      dim: true,
    });
  });
});

describe("aeReceiptHint", () => {
  it("points only at a control that exists", () => {
    expect(aeReceiptHint(card())).toBe("Merge from the action bar");
    expect(aeReceiptHint(card({ draft: true }))).toBe("Mark ready from the action bar");
    expect(aeReceiptHint(card({ mergeable: { state: "unstable", detail: "" } }))).toBe(
      "Merge from the GitHub panel",
    );
    expect(aeReceiptHint(card({ ci: failing, merge: { ...card().merge, allowed: false } }))).toBe(
      "Merge shows in the action bar once ready",
    );
    expect(aeReceiptHint(card({ state: "merged" }))).toBeNull();
    expect(aeReceiptHint(card({ state: "closed" }))).toBeNull();
  });
});
