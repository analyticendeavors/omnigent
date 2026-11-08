import { describe, expect, it } from "vitest";
import {
  completeSentences,
  speechTextFromMarkdown,
  splitForSpeech,
  stripTldr,
} from "./aeSpeechText";

const EXAMPLE = [
  "Slide 14 lands. **Two fixes** left:",
  "",
  "- Title still says `Fuel Cost per Ton`; the model says Tonne.",
  "- Run this before the demo:",
  "",
  "```powershell",
  "Invoke-Build -Task Refresh",
  "```",
  "",
  "See [the walk 5 sheet](https://example.org/sheet).",
  "",
  "**TLDR**",
  "**Done:** slide 14 copy.",
  '**Next:** 1. Say "go" for the PDF.',
].join("\n");

describe("speechTextFromMarkdown", () => {
  it("speaks the example reply exactly", () => {
    expect(speechTextFromMarkdown(stripTldr(EXAMPLE))).toBe(
      "Slide 14 lands. Two fixes left: Title still says Fuel Cost per Ton; the model says Tonne. Run this before the demo: Code block skipped. See the walk 5 sheet.",
    );
  });

  it("replaces fenced blocks, closed or not, with a phrase", () => {
    expect(speechTextFromMarkdown("A.\n~~~\nx\n~~~\nB.")).toBe("A. Code block skipped. B.");
    expect(speechTextFromMarkdown("A.\n```\nx = 1")).toBe("A. Code block skipped.");
  });

  it("removes html comments and tags", () => {
    expect(speechTextFromMarkdown("Hi <!-- hidden --> <b>there</b>.")).toBe("Hi there.");
  });

  it("keeps image alt text and link text, and says link for bare urls", () => {
    expect(speechTextFromMarkdown("![a chart](x.png) and [docs](http://a.b/c).")).toBe(
      "a chart and docs.",
    );
    expect(speechTextFromMarkdown("Open https://example.org/x now.")).toBe("Open link now.");
  });

  it("drops heading, quote and rule marks and bullet marks, keeps numbers", () => {
    expect(speechTextFromMarkdown("## Title\n> quoted\n---\n- one\n* two\n1. three\n2) four")).toBe(
      "Title. quoted. one. two. 1. three. 2) four.",
    );
  });

  it("drops emphasis but keeps identifiers and inline code text", () => {
    expect(speechTextFromMarkdown("*a* __b__ ~~c~~ snake_case `d_e`.")).toBe(
      "a b c snake_case d_e.",
    );
  });

  it("reads table rows with commas and skips separators", () => {
    expect(speechTextFromMarkdown("| A | B |\n|---|---|\n| 1 | 2 |")).toBe("A, B. 1, 2.");
  });

  it("adds a period only when a line has no end mark", () => {
    expect(speechTextFromMarkdown("One\nTwo!\nThree:")).toBe("One. Two! Three:");
  });
});

describe("stripTldr", () => {
  it("cuts the recap", () => {
    expect(stripTldr("Body.\n\n**TLDR**\nDone.")).toBe("Body.");
    expect(stripTldr("Body.\nTL;DR:\nDone.")).toBe("Body.");
  });

  it("keeps a reply that is only a TLDR", () => {
    const only = "**TLDR**\nDone: x.";
    expect(stripTldr(only)).toBe(only);
  });
});

describe("completeSentences", () => {
  it("cuts at the last sentence end", () => {
    expect(completeSentences("One. Two! Thre")).toEqual({ ready: "One. Two!", rest: " Thre" });
  });

  it("treats a blank line as a boundary", () => {
    expect(completeSentences("A heading\n\nNext")).toEqual({
      ready: "A heading\n\n",
      rest: "Next",
    });
  });

  it("never cuts inside an unclosed code fence", () => {
    const r = completeSentences("Run:\n\n```sh\necho hi. ok. \nmore");
    expect(r.ready).toBe("Run:\n\n");
    expect(r.rest.startsWith("```sh")).toBe(true);
  });

  it("never cuts inside an open link or url", () => {
    expect(completeSentences("Done. See [the sheet. here").ready).toBe("Done.");
    expect(completeSentences("Done. See [a](http://x.org/a. b").ready).toBe("Done.");
  });

  it("does not cut inside a number or a list marker", () => {
    expect(completeSentences("Cost is 3.5 tons").ready).toBe("");
    expect(completeSentences("1. First").ready).toBe("");
  });
});

describe("splitForSpeech", () => {
  it("merges neighbours up to the limit", () => {
    expect(splitForSpeech("One. Two. Three.", 10)).toEqual(["One. Two.", "Three."]);
  });

  it("hard-splits a long sentence at a comma or space", () => {
    const parts = splitForSpeech("aaa, bbb ccc ddd eee fff", 10);
    expect(parts.every((p) => p.length <= 10 && p !== "")).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe("aaa, bbb ccc ddd eee fff");
  });

  it("returns no empty chunks", () => {
    expect(splitForSpeech("  ")).toEqual([]);
  });
});
