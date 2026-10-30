import { describe, expect, it } from "vitest";
import { parseAeSlotsFull } from "./aeSlotsFull";

// Strings below are real output of reason_text (slot_cap.py), warn and block mode.
const ONE =
  "Slots full: 1 of 3 taken. Run this as the 2nd? 1. Lead build (next: finish the card) To park one instead, the longest running: Lead build. Accept to run it as overflow, or decline, then park one in the Parking Lot or flip one to review.";
const THREE =
  "Slots full: 3 of 3 taken. Run this as the 4th? 1. Alpha (draft). Two (elapsed under a minute) 2. Beta (next: do x (maybe)) 3. Gamma (elapsed 1d 4h) To park one instead, the longest running: Alpha (draft). Two or Beta. Accept to run it as overflow, or decline, then park one in the Parking Lot (https://lot.example/p) or flip one to review.";
const LONG = "Session number N with a really long title tha...";
const SIX = `Slots full: 7 of 6 taken. Run this as the 8th? ${[1, 2, 3, 4, 5, 6]
  .map((n) => `${n}. ${LONG.replace("N", String(n))} (elapsed under a minute)`)
  .join(
    " ",
  )} Plus 2 of another user's. 1 more claimed a slot a moment ago. To park one instead, the longest running: ${LONG.replace("N", "1")} or ${LONG.replace("N", "2")}. Accept to run it as overflow, or decline, then park one in the Parking Lot or flip one to review.`;
const BLOCK =
  'Slots full: 3 of 3 taken; this one would make 4 of 3. 1. Alpha (elapsed 1h) Park one in the Parking Lot, flip one to review, or resend starting with "ride unparked" to run one more.';

describe("parseAeSlotsFull", () => {
  it("splits one holder into headline, row, park line and the accept sentence", () => {
    const parsed = parseAeSlotsFull(ONE)!;
    expect(parsed.headline).toBe("Slots full: 1 of 3 taken. Run this as the 2nd?");
    expect(parsed.rows).toEqual([{ title: "Lead build", detail: "next: finish the card" }]);
    expect(parsed.park).toBe("To park one instead, the longest running: Lead build.");
    expect(parsed.tail).toEqual([
      "Accept to run it as overflow, or decline, then park one in the Parking Lot or flip one to review.",
    ]);
  });

  it("keeps parentheses and sentences inside titles and next lines", () => {
    const parsed = parseAeSlotsFull(THREE)!;
    expect(parsed.rows).toEqual([
      { title: "Alpha (draft). Two", detail: "elapsed under a minute" },
      { title: "Beta", detail: "next: do x (maybe)" },
      { title: "Gamma", detail: "elapsed 1d 4h" },
    ]);
    expect(parsed.park).toBe(
      "To park one instead, the longest running: Alpha (draft). Two or Beta.",
    );
  });

  it("keeps the Parking Lot link in the accept sentence", () => {
    const parsed = parseAeSlotsFull(THREE)!;
    expect(parsed.tail).toHaveLength(1);
    expect(parsed.tail[0]).toContain("park one in the Parking Lot (https://lot.example/p) or flip");
  });

  it("reads six rows and the Plus and pending lines", () => {
    const parsed = parseAeSlotsFull(SIX)!;
    expect(parsed.rows).toHaveLength(6);
    expect(parsed.rows[5]).toEqual({
      title: LONG.replace("N", "6"),
      detail: "elapsed under a minute",
    });
    expect(parsed.tail.slice(0, 2)).toEqual([
      "Plus 2 of another user's.",
      "1 more claimed a slot a moment ago.",
    ]);
    expect(parsed.tail).toHaveLength(3);
    expect(parsed.park.endsWith("tha....")).toBe(true);
  });

  it("returns null for block-mode and unrelated text", () => {
    expect(parseAeSlotsFull(BLOCK)).toBeNull();
    expect(parseAeSlotsFull("Approve running rm -rf /tmp/cache?")).toBeNull();
    expect(parseAeSlotsFull("")).toBeNull();
    // A warn headline without the closing sentence is not this ask.
    expect(parseAeSlotsFull(ONE.slice(0, ONE.indexOf(" Accept")))).toBeNull();
  });

  it("keeps a title that holds a row-number lookalike, using the headline's count", () => {
    const text =
      "Slots full: 1 of 3 taken. Run this as the 2nd? 1. Deploy (phase) 2. rollout (elapsed 1h 0m) To park one instead, the longest running: Deploy (phase) 2. rollout. Accept to run it as overflow, or decline, then park one in the Parking Lot or flip one to review.";
    expect(parseAeSlotsFull(text)!.rows).toEqual([
      { title: "Deploy (phase) 2. rollout", detail: "elapsed 1h 0m" },
    ]);
    const two =
      "Slots full: 2 of 3 taken. Run this as the 3rd? 1. Deploy (phase) 2. rollout (elapsed 1h 0m) 2. Beta (elapsed 1h 0m) To park one instead, the longest running: Deploy (phase) 2. rollout or Beta. Accept to run it as overflow, or decline, then park one in the Parking Lot or flip one to review.";
    expect(parseAeSlotsFull(two)!.rows).toEqual([
      { title: "Deploy (phase) 2. rollout", detail: "elapsed 1h 0m" },
      { title: "Beta", detail: "elapsed 1h 0m" },
    ]);
  });

  it("takes the detail from the end of the row, not from a title that looks like one", () => {
    const text =
      "Slots full: 1 of 3 taken. Run this as the 2nd? 1. Deploy (next: phase 2) (next: finish) To park one instead, the longest running: Deploy (next: phase 2). Accept to run it as overflow, or decline, then park one in the Parking Lot or flip one to review.";
    expect(parseAeSlotsFull(text)!.rows).toEqual([
      { title: "Deploy (next: phase 2)", detail: "next: finish" },
    ]);
  });

  it("returns null when the rows do not match the headline's count", () => {
    // The headline says 2 holders but the text carries one row.
    expect(parseAeSlotsFull(ONE.replace("1 of 3 taken", "2 of 3 taken"))).toBeNull();
    // Three rows against a headline that says 4.
    expect(parseAeSlotsFull(THREE.replace("3 of 3 taken", "4 of 4 taken"))).toBeNull();
    // A pending claim larger than the taken count.
    expect(parseAeSlotsFull(SIX.replace("7 of 6 taken", "0 of 6 taken"))).toBeNull();
  });

  it("reads a headline that counts only a pending claim as zero rows", () => {
    const text =
      "Slots full: 1 of 3 taken. Run this as the 2nd? 1 more claimed a slot a moment ago. Accept to run it as overflow, or decline, then park one in the Parking Lot or flip one to review.";
    const parsed = parseAeSlotsFull(text)!;
    expect(parsed.rows).toEqual([]);
    expect(parsed.tail[0]).toBe("1 more claimed a slot a moment ago.");
  });
});
