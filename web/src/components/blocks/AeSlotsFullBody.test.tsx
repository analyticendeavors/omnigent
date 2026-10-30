import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAeSlotsFull } from "@/lib/aeSlotsFull";
import { AeSlotsFullBody } from "./AeSlotsFullBody";

afterEach(cleanup);

const TEXT =
  "Slots full: 2 of 2 taken. Run this as the 3rd? 1. Alpha (elapsed 1h) 2. Beta (next: do x) To park one instead, the longest running: Alpha or Beta. Accept to run it as overflow, or decline, then park one in the Parking Lot or flip one to review.";

function setup() {
  const onApprove = vi.fn();
  const onDecline = vi.fn();
  render(
    <AeSlotsFullBody slots={parseAeSlotsFull(TEXT)!} onApprove={onApprove} onDecline={onDecline} />,
  );
  return { onApprove, onDecline };
}

describe("AeSlotsFullBody", () => {
  it("puts the buttons before the holder toggle", () => {
    setup();
    const run = screen.getByRole("button", { name: /run as overflow/i });
    const decline = screen.getByRole("button", { name: /decline/i });
    const toggle = screen.getByTestId("ae-slots-full-toggle");
    expect(run.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(decline.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.textContent).toBe("Show the 2 holding slots");
    expect(screen.getByText(/To park one instead/)).toBeDefined();
  });

  it("fires approve and decline", () => {
    const { onApprove, onDecline } = setup();
    fireEvent.click(screen.getByRole("button", { name: /run as overflow/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /decline/i }));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it("folds the rows and the accept sentence until the toggle opens them", () => {
    setup();
    const toggle = screen.getByTestId("ae-slots-full-toggle");
    const rows = screen.getByText(/Alpha/, { selector: "li" }).closest("div")!;
    expect(rows.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(rows.hidden).toBe(false);
    expect(toggle.textContent).toBe("Hide the 2 holding slots");
    expect(screen.getByText(/Accept to run it as overflow/)).toBeDefined();
    fireEvent.click(toggle);
    expect(rows.hidden).toBe(true);
  });
});
