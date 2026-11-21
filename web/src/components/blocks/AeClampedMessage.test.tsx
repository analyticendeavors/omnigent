import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalCard } from "./ApprovalCard";
import { AeClampedMessage } from "./AeClampedMessage";

const LONG = Array.from(
  { length: 15 },
  (_, n) => `Policy line number ${n + 1} of the message.`,
).join("\n");

// jsdom has no layout, so the measured sizes are faked on the element prototype: the clamped
// body overflows only when `overflowing` is true and the clamp class is still on it.
let overflowing = false;
const proto = HTMLElement.prototype;
const realScroll = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
const realClient = Object.getOwnPropertyDescriptor(proto, "clientHeight");

function fakeLayout(over: boolean) {
  overflowing = over;
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get() {
      return overflowing ? 200 : 60;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get() {
      const clamped = (this as HTMLElement).className.includes("line-clamp-3");
      return clamped ? 60 : overflowing ? 200 : 60;
    },
  });
}

afterEach(() => {
  if (realScroll) Object.defineProperty(proto, "scrollHeight", realScroll);
  else delete (proto as unknown as Record<string, unknown>).scrollHeight;
  if (realClient) Object.defineProperty(proto, "clientHeight", realClient);
  else delete (proto as unknown as Record<string, unknown>).clientHeight;
});

describe("AeClampedMessage", () => {
  it("shows no toggle when the text fits in three lines", () => {
    fakeLayout(false);
    render(<AeClampedMessage message="Is this still on topic?" />);
    expect(screen.getByText("Is this still on topic?")).toBeDefined();
    expect(screen.getByTestId("ae-clamped-message").className).toContain("line-clamp-3");
    expect(screen.queryByTestId("ae-clamped-message-toggle")).toBeNull();
  });

  it("shows the toggle when the clamped text overflows, and opens and closes it", () => {
    fakeLayout(true);
    render(<AeClampedMessage message={LONG} />);
    const body = screen.getByTestId("ae-clamped-message");
    const toggle = screen.getByTestId("ae-clamped-message-toggle");
    expect(body.className).toContain("line-clamp-3");
    expect(toggle.textContent).toBe("Show more");
    expect(toggle.getAttribute("aria-hidden")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBeNull();
    fireEvent.click(toggle);
    expect(body.className).not.toContain("line-clamp-3");
    expect(screen.getByTestId("ae-clamped-message-toggle").textContent).toBe("Show less");
    fireEvent.click(screen.getByTestId("ae-clamped-message-toggle"));
    expect(body.className).toContain("line-clamp-3");
    expect(screen.getByTestId("ae-clamped-message-toggle").textContent).toBe("Show more");
  });

  it("keeps the same whitespace handling in both states and trims trailing newlines", () => {
    fakeLayout(true);
    render(<AeClampedMessage message={"first\nsecond\n\n"} />);
    const body = screen.getByTestId("ae-clamped-message");
    expect(body.className).toContain("whitespace-pre-wrap");
    expect(body.textContent).toBe("first\nsecond");
    fireEvent.click(screen.getByTestId("ae-clamped-message-toggle"));
    expect(body.className).toContain("whitespace-pre-wrap");
  });

  it("folds again when the message changes", () => {
    fakeLayout(true);
    const { rerender } = render(<AeClampedMessage message={LONG} />);
    fireEvent.click(screen.getByTestId("ae-clamped-message-toggle"));
    expect(screen.getByTestId("ae-clamped-message").getAttribute("data-clamped")).toBe("false");
    rerender(<AeClampedMessage message={`${LONG}\nAnother line.`} />);
    expect(screen.getByTestId("ae-clamped-message").getAttribute("data-clamped")).toBe("true");
    expect(screen.getByTestId("ae-clamped-message-toggle").textContent).toBe("Show more");
  });
});

describe("ApprovalCard long generic message", () => {
  it("folds the message and keeps Approve and Reject right under it", () => {
    fakeLayout(true);
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
    expect(toggle.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.getByTestId("ae-clamped-message").getAttribute("data-clamped")).toBe("false");
    expect(approve).toBeDefined();
    expect(reject).toBeDefined();
  });
});

describe("ApprovalCard responded long message", () => {
  const card = (message: string) => (
    <ApprovalCard
      elicitationId="elic_long_done"
      message={message}
      phase="tool_call"
      policyName="some_policy"
      contentPreview=""
      requestedSchema={{}}
      status="responded"
      response={{ action: "accept" }}
    />
  );

  it("folds the message and opens it with the toggle", () => {
    fakeLayout(true);
    render(card(LONG));
    expect(screen.getByTestId("ae-clamped-message").getAttribute("data-clamped")).toBe("true");
    fireEvent.click(screen.getByTestId("ae-clamped-message-toggle"));
    expect(screen.getByTestId("ae-clamped-message").getAttribute("data-clamped")).toBe("false");
  });

  it("shows no toggle when the message fits", () => {
    fakeLayout(false);
    render(card("Claude wants to call **Bash**"));
    expect(screen.getByText("Bash", { selector: "strong" })).toBeDefined();
    expect(screen.queryByTestId("ae-clamped-message-toggle")).toBeNull();
  });
});
