import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "./ApprovalCard";
import { useChatStore } from "@/store/chatStore";

const bash = (obj: Record<string, unknown>) => `Bash(${JSON.stringify(obj)})`;

function renderCard(contentPreview: string, extra: Record<string, unknown> = {}) {
  const submitSpy = vi.fn().mockResolvedValue(undefined);
  useChatStore.setState({ submitApproval: submitSpy } as Partial<
    ReturnType<typeof useChatStore.getState>
  >);
  render(
    <ApprovalCard
      elicitationId="elic_sum"
      message="Claude wants to call **Bash**"
      phase="pre_tool_use"
      policyName="claude_native_permission"
      contentPreview={contentPreview}
      requestedSchema={{}}
      status="pending"
      response={null}
      {...extra}
    />,
  );
  return submitSpy;
}

describe("AeApprovalSummary through ApprovalCard", () => {
  it("shows a read-only command as one row with inline Approve and Reject", () => {
    const submit = renderCard(bash({ command: "git status", description: "Show git status" }));
    expect(screen.getByTestId("approval-card").getAttribute("data-risk")).toBe("read");
    expect(screen.getByText("Show git status")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(submit).toHaveBeenCalledWith("elic_sum", "accept", undefined, expect.anything());
  });

  it("folds a write command's code behind a Show command button", () => {
    renderCard(bash({ command: "pnpm install", description: "Install packages" }), {
      rememberScope: { tool: "Bash" },
    });
    expect(screen.getByText("Run a command")).toBeDefined();
    const toggle = screen.getByRole("button", { name: "Show command" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("approval-card-remember")).toBeDefined();
  });

  it("opens a destructive command, names the danger and offers no remember option", () => {
    renderCard(bash({ command: "git reset --hard origin/main" }), {
      rememberScope: { tool: "Bash" },
      allowAutoMode: true,
    });
    expect(screen.getByTestId("approval-card").getAttribute("data-risk")).toBe("destructive");
    expect(screen.getByTestId("approval-danger-tag").textContent).toBe("discards work");
    expect(screen.getByText("git reset --hard origin/main").closest("pre")?.hidden).toBe(false);
    expect(screen.getByRole("button", { name: "Approve once" })).toBeDefined();
    expect(screen.queryByTestId("approval-card-remember")).toBeNull();
    expect(screen.queryByRole("button", { name: /auto mode/i })).toBeNull();
  });

  it("starts an edit's diff open", () => {
    renderCard(
      `Edit(${JSON.stringify({ file_path: "a/B.tsx", old_string: "x", new_string: "y" })})`,
    );
    expect(screen.getByText("Edit a file")).toBeDefined();
    expect(screen.getByText("Edit B.tsx: replace 1 lines with 1")).toBeDefined();
    expect(screen.getByRole("button", { name: "Hide diff" })).toBeDefined();
  });

  it("falls back to today's card for a tool it does not summarize", () => {
    renderCard('WebFetch({"url":"https://x.test"})');
    expect(screen.getByText("Approval required")).toBeDefined();
  });
});
