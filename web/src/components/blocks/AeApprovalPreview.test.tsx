import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalCard } from "./ApprovalCard";
import { AeApprovalPreview, aeFoldsApprovalPreview } from "./AeApprovalPreview";

const REQUEST = '{"text": "keep going on the export", "session": "conv_1"}';

function previewOf(text: RegExp | string): HTMLElement {
  const pre = screen.getByText(text).closest("pre");
  if (!pre) throw new Error("no code box");
  return pre;
}

describe("AeApprovalPreview", () => {
  it("shows the code at once when it does not fold", () => {
    render(<AeApprovalPreview text={REQUEST} fold={false} />);
    expect(previewOf(REQUEST).hidden).toBe(false);
    expect(screen.queryByTestId("ae-approval-details-toggle")).toBeNull();
  });

  it("folds the code behind Show details and opens it on a click", () => {
    render(<AeApprovalPreview text={REQUEST} fold />);
    const toggle = screen.getByTestId("ae-approval-details-toggle");
    const pre = previewOf(REQUEST);
    expect(toggle.getAttribute("aria-controls")).toBe(pre.id);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("Show details");
    expect(pre.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Hide details");
    expect(pre.hidden).toBe(false);
  });

  it("folds only an ask that gates the person's own message", () => {
    expect(aeFoldsApprovalPreview("request")).toBe(true);
    expect(aeFoldsApprovalPreview("tool_call")).toBe(false);
    expect(aeFoldsApprovalPreview("pre_tool_use")).toBe(false);
    expect(aeFoldsApprovalPreview("response")).toBe(false);
    expect(aeFoldsApprovalPreview("")).toBe(false);
  });
});

describe("ApprovalCard code under the message", () => {
  const card = (props: { message: string; phase: string; policyName: string; preview: string }) =>
    render(
      <ApprovalCard
        elicitationId="elic_test"
        message={props.message}
        phase={props.phase}
        policyName={props.policyName}
        contentPreview={props.preview}
        requestedSchema={{}}
        status="pending"
        response={null}
      />,
    );

  it("folds the request under a request-phase policy's sentence", () => {
    card({
      message: "This session has run for 4 hours. Accept to keep going in it.",
      phase: "request",
      policyName: "ae_rabbit_hole",
      preview: REQUEST,
    });
    expect(screen.getByText(/has run for 4 hours/)).toBeDefined();
    expect(screen.getByTestId("ae-approval-details-toggle")).toBeDefined();
    expect(previewOf(/keep going on the export/).hidden).toBe(true);
    expect(screen.getByRole("button", { name: /approve/i })).toBeDefined();
  });

  it("keeps a written tool-call policy's command in view", () => {
    card({
      message: "Confirm before pushing.",
      phase: "tool_call",
      policyName: "confirm_git_push",
      preview: '{"command": "git push --force origin main"}',
    });
    expect(screen.queryByTestId("ae-approval-details-toggle")).toBeNull();
    expect(previewOf(/git push --force origin main/).hidden).toBe(false);
  });

  it("keeps a native tool prompt's command in view", () => {
    card({
      message: "Claude wants to call **Bash**",
      phase: "pre_tool_use",
      policyName: "claude_native_permission",
      preview: 'Bash({"command": "git push origin main"})',
    });
    expect(screen.queryByTestId("ae-approval-details-toggle")).toBeNull();
    expect(previewOf(/git push origin main/).hidden).toBe(false);
  });
});
