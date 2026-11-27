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

  it("returns null when the cached snapshot is for another row state or absent", () => {
    const qc = new QueryClient();
    expect(cachedApprovalSummaryText(qc, row)).toBeNull();
    qc.setQueryData(["inbox-elicitations", "c1", 0, 4], { pendingElicitations: [elicitation] });
    expect(cachedApprovalSummaryText(qc, row)).toBeNull();
  });
});
