import { describe, expect, it } from "vitest";
import { repairEncodedNote } from "./aePasteRepair";

describe("repairEncodedNote", () => {
  it("restores a note the clipboard encoded as a URL", () => {
    const encoded =
      "thread:%20session-link-titles%0ASTATE:%20Reid%20asked,%20from%20his%20phone,%20that%20a%20link%20read%20as%20%5Btitle%5D(url)%20%22x%22%20%3Cid%3E%0ANEXT:%20go";
    expect(repairEncodedNote(encoded)).toBe(
      'thread: session-link-titles\nSTATE: Reid asked, from his phone, that a link read as [title](url) "x" <id>\nNEXT: go',
    );
  });

  it("restores non-ASCII text and a literal percent sign", () => {
    expect(repairEncodedNote("note:%20QUADRANT:%20feature%20%C2%B7%20EST:%20100%25")).toBe(
      "note: QUADRANT: feature · EST: 100%",
    );
  });

  it("leaves real URLs and ordinary text alone", () => {
    expect(repairEncodedNote("https://a.b/c%20d")).toBeNull();
    expect(repairEncodedNote("mailto:me@a.b?subject=hi%20there")).toBeNull();
    expect(repairEncodedNote("thread: already plain")).toBeNull();
    expect(repairEncodedNote("hello%20world")).toBeNull();
    expect(repairEncodedNote("")).toBeNull();
  });

  it("returns null for a malformed escape", () => {
    expect(repairEncodedNote("thread:%20bad%E0%A4")).toBeNull();
  });
});
