import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalCard } from "./ApprovalCard";
import { AeClampedMessage, aeMessageNeedsClamp } from "./AeClampedMessage";

const LONG = Array.from(
  { length: 15 },
  (_, n) => `Policy line number ${n + 1} of the message.`,
).join("\n");

describe("AeClampedMessage", () => {
  it("leaves a short message alone, with no toggle", () => {
    render(<AeClampedMessage message="Is this still on topic?" />);
    expect(screen.getByText("Is this still on topic?")).toBeDefined();
    expect(screen.queryByTestId("ae-clamped-message")).toBeNull();
    expect(screen.queryByTestId("ae-clamped-message-toggle")).toBeNull();
  });

  it("clamps a long message and opens and closes it with the toggle", () => {
    render(<AeClampedMessage message={LONG} />);
    const body = screen.getByTestId("ae-clamped-message");
    const toggle = screen.getByTestId("ae-clamped-message-toggle");
    expect(body.className).toContain("line-clamp-3");
    expect(toggle.textContent).toBe("Show more");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(body.id);
    fireEvent.click(toggle);
    expect(body.className).not.toContain("line-clamp-3");
    expect(toggle.textContent).toBe("Show less");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(body.className).toContain("line-clamp-3");
    expect(toggle.textContent).toBe("Show more");
  });

  it("folds on length or on line count", () => {
    expect(aeMessageNeedsClamp("x".repeat(200))).toBe(false);
    expect(aeMessageNeedsClamp("x".repeat(201))).toBe(true);
    expect(aeMessageNeedsClamp("a\nb\nc")).toBe(false);
    expect(aeMessageNeedsClamp("a\nb\nc\nd")).toBe(true);
  });
});

describe("ApprovalCard long generic message", () => {
  it("folds the message and keeps Approve and Reject right under it", () => {
    render(
      <ApprovalCard
        elicitationId="elic_long"
        message={LONG}
        phase="tool_call"
        policyName="some_policy"
        contentPreview=""
        requestedSchema={{}}
        status="pending"
        response={null}
      />,
    );
    expect(screen.getByTestId("ae-clamped-message").getAttribute("data-clamped")).toBe("true");
    const approve = screen.getByRole("button", { name: /^approve/i });
    const reject = screen.getByRole("button", { name: /reject/i });
    const toggle = screen.getByTestId("ae-clamped-message-toggle");
    // Toggle comes before the buttons in the card, and the buttons stay rendered when open.
    expect(toggle.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.getByTestId("ae-clamped-message").getAttribute("data-clamped")).toBe("false");
    expect(approve).toBeDefined();
    expect(reject).toBeDefined();
  });
});
