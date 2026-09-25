import { describe, expect, it } from "vitest";
import { aeMoreOpenText, aeOtherTrackedPrs, aeReviewOffer } from "./aeReviewOffer";

const REPO = "analyticendeavors/omnigent-ae";
const url = (n: number, repo = REPO) => `https://github.com/${repo}/pull/${n}`;

describe("aeOtherTrackedPrs", () => {
  it("drops the merged pull request, repeats and other hosts", () => {
    expect(
      aeOtherTrackedPrs(
        [
          { url: url(1) },
          { url: url(2) },
          { url: url(2) },
          { url: "https://github.com/AnalyticEndeavors/Omnigent-AE/pull/1" },
          { url: "https://ghe.example/o/r/pull/3" },
          { url: url(4, "analyticendeavors/omnigent") },
        ],
        { repo: REPO, number: 1 },
      ),
    ).toEqual([
      { repo: REPO, number: 2 },
      { repo: "analyticendeavors/omnigent", number: 4 },
    ]);
  });

  it("matches the merged pull request whatever the case of its repo", () => {
    expect(
      aeOtherTrackedPrs([{ url: url(7) }], { repo: "AnalyticEndeavors/Omnigent-AE", number: 7 }),
    ).toEqual([]);
  });
});

describe("aeReviewOffer", () => {
  it("offers review when the merged pull request was the only one", () => {
    expect(aeReviewOffer([])).toEqual({ kind: "offer" });
  });

  it("offers review when every other one is merged or closed", () => {
    expect(aeReviewOffer(["merged", "closed", "merged"])).toEqual({ kind: "offer" });
  });

  it("holds the offer back and counts the ones still open", () => {
    expect(aeReviewOffer(["open", "open", "open"])).toEqual({ kind: "open", count: 3 });
    expect(aeReviewOffer(["merged", "open", undefined])).toEqual({ kind: "open", count: 1 });
  });

  it("says nothing while a state or the tracked list is unknown", () => {
    expect(aeReviewOffer(["merged", undefined])).toEqual({ kind: "unknown" });
    expect(aeReviewOffer(undefined)).toEqual({ kind: "unknown" });
  });
});

describe("aeMoreOpenText", () => {
  it("counts in words that read on a phone", () => {
    expect(aeMoreOpenText(1)).toBe("1 more open pull request in this session");
    expect(aeMoreOpenText(3)).toBe("3 more open pull requests in this session");
  });
});
