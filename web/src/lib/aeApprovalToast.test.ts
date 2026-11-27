import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { cachedApprovalSummaryText } from "./aeApprovalToast";

const row = { id: "c1", pending_elicitations_count: 1, updated_at: 5 };
const elicitation = {
  elicitation_id: "e1",
  params: {
    message: "Claude wants to call **Bash**",
    phase: "pre_tool_use",
    policy_name: "claude_native",
    content_preview: 'Bash({"command":"git status","description":"Show git status"})',
    requestedSchema: {},
    mode: "form",
  },
};

describe("cachedApprovalSummaryText", () => {
  it("reads the line from the Inbox snapshot for the same row state", () => {
    const qc = new QueryClient();
    qc.setQueryData(["inbox-elicitations", "c1", 1, 5], { pendingElicitations: [elicitation] });
    expect(cachedApprovalSummaryText(qc, row)).toBe("Show git status");
  });

  it("shows the derived line for an MCP tool, never the agent's reason or a secret", () => {
    const qc = new QueryClient();
    qc.setQueryData(["inbox-elicitations", "c1", 1, 5], {
      pendingElicitations: [
        {
          elicitation_id: "e3",
          params: {
            ...elicitation.params,
            message: "Claude wants to call **mcp__github__merge_pull_request**",
            content_preview: `mcp__github__merge_pull_request(${JSON.stringify({
              id: 7,
              reason: "List the open pull requests",
              token: ["ghp", "_abc12345"].join(""),
            })})`,
          },
        },
      ],
    });
    expect(cachedApprovalSummaryText(qc, row)).toBe("Merge pull request via github (id: 7)");
  });

  it("returns null when the cached snapshot is for another row state or absent", () => {
    const qc = new QueryClient();
    expect(cachedApprovalSummaryText(qc, row)).toBeNull();
    qc.setQueryData(["inbox-elicitations", "c1", 0, 4], { pendingElicitations: [elicitation] });
    expect(cachedApprovalSummaryText(qc, row)).toBeNull();
  });

  it("cuts a long summary to 120 characters", () => {
    const qc = new QueryClient();
    const long = "x".repeat(300);
    qc.setQueryData(["inbox-elicitations", "c1", 1, 5], {
      pendingElicitations: [
        {
          elicitation_id: "e2",
          params: {
            ...elicitation.params,
            content_preview: `Bash(${JSON.stringify({ command: "ls", description: long })})`,
          },
        },
      ],
    });
    const text = cachedApprovalSummaryText(qc, row);
    expect(text).toHaveLength(120);
    expect(text?.endsWith("…")).toBe(true);
  });
});
