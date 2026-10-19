import { describe, expect, it } from "vitest";
import { aeAtTranscriptEnd } from "./aeActiveTurn";

describe("aeAtTranscriptEnd", () => {
  it("is true at the exact end", () => {
    expect(aeAtTranscriptEnd(600, 400, 1000)).toBe(true);
  });
  it("is true within the slack and false beyond it", () => {
    expect(aeAtTranscriptEnd(596, 400, 1000)).toBe(true);
    expect(aeAtTranscriptEnd(595, 400, 1000)).toBe(false);
  });
  it("honors a custom slack", () => {
    expect(aeAtTranscriptEnd(590, 400, 1000, 10)).toBe(true);
  });
  it("is true when the content does not overflow", () => {
    expect(aeAtTranscriptEnd(0, 400, 300)).toBe(true);
  });
  it("is false mid-scroll", () => {
    expect(aeAtTranscriptEnd(100, 400, 1000)).toBe(false);
  });
});
