import { describe, expect, it } from "vitest";
import {
  completeSentences,
  speechTextFromMarkdown,
  splitFirstPhrase,
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

describe("speech text, review fixes", () => {
  it("drops link reference definitions", () => {
    expect(speechTextFromMarkdown("See [a][1].\n\n[1]: https://example.org/a")).toBe("See [a][1].");
  });

  it("reads spaced pipes as commas on any line", () => {
    expect(speechTextFromMarkdown("Name | Value")).toBe("Name, Value.");
  });

  it("guards asterisks inside words and globs", () => {
    expect(speechTextFromMarkdown("a*b*c and **/*.ts here")).toBe("a*b*c and **/*.ts here.");
    expect(speechTextFromMarkdown("**bold** and *em*")).toBe("bold and em.");
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

  it("waits when an end mark is the last character", () => {
    expect(completeSentences("costs 3.").ready).toBe("");
    expect(completeSentences("v0.18.").ready).toBe("");
    expect(completeSentences("costs 3.5 dollars. Next")).toEqual({
      ready: "costs 3.5 dollars.",
      rest: " Next",
    });
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

  describe("shortFirst", () => {
    const first = { shortFirst: true };

    it("never merges a short first sentence with the next ones", () => {
      expect(splitForSpeech("One. Two. Three.", 220, first)).toEqual(["One.", "Two. Three."]);
    });

    it("keeps a first sentence of ten words or fewer whole", () => {
      const ten = "One two three four five six seven eight nine ten, eleven.";
      expect(splitFirstPhrase("One two three four five six seven eight nine ten.")).toEqual({
        head: "One two three four five six seven eight nine ten.",
        rest: "",
      });
      expect(splitForSpeech(`${ten} Next.`, 220, first)[0]).toBe(
        "One two three four five six seven eight nine ten,",
      );
    });

    it("cuts a long first sentence at the first clause boundary after six words", () => {
      const text = "Yes, I checked the build and it passed, so the release can go out today. Done.";
      expect(splitForSpeech(text, 220, first)).toEqual([
        "Yes, I checked the build and it passed,",
        "so the release can go out today. Done.",
      ]);
    });

    it("skips a boundary before six words", () => {
      expect(
        splitForSpeech(
          "Well, one two three four five; six seven eight nine ten eleven.",
          220,
          first,
        ),
      ).toEqual(["Well, one two three four five;", "six seven eight nine ten eleven."]);
    });

    it("cuts at a colon or a spaced dash too", () => {
      expect(
        splitFirstPhrase("Here is what happened: one two three four five six seven.").head,
      ).toBe("Here is what happened: one two three four five six seven.");
      expect(
        splitFirstPhrase("The deploy ran fine and then - after a short wait - it stopped working.")
          .head,
      ).toBe("The deploy ran fine and then");
    });

    it("does not split an unspaced dash: a numeric range or a hyphenated word", () => {
      const range = "The report shows results for 2024\u20132026 across all of the regions listed.";
      expect(splitFirstPhrase(range)).toEqual({ head: range, rest: "" });
      const word = "This is a well-known problem that shows up in many of the older builds.";
      expect(splitFirstPhrase(word)).toEqual({ head: word, rest: "" });
      expect(
        splitFirstPhrase(
          "The deploy ran fine and then \u2014 after a short wait \u2014 it stopped.",
        ).head,
      ).toBe("The deploy ran fine and then");
    });

    it("falls back to the whole sentence when no boundary follows six words", () => {
      const long = "One two three four five six seven eight nine ten eleven twelve.";
      expect(splitForSpeech(long, 220, first)).toEqual([long]);
      expect(
        splitFirstPhrase("One, two three four five six seven eight nine ten eleven.").head,
      ).toBe("One, two three four five six seven eight nine ten eleven.");
    });

    it("leaves later chunks on the normal merge and the default unchanged", () => {
      expect(splitForSpeech("One. Two. Three.", 10, first)).toEqual(["One.", "Two.", "Three."]);
      expect(splitForSpeech("One. Two. Three.", 220)).toEqual(["One. Two. Three."]);
    });
  });
});
