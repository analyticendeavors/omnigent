import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import { useChatStore } from "@/store/chatStore";
import { AeAgentMetaLine } from "./AeAgentMeta";
import { AeAgentsSections } from "./AeAgentsSections";

const usageMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sessionsApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionUsage: usageMock,
}));

const usage = (model: string, input: number, output: number, effort: string | null = null) => ({
  id: "x",
  totalCostUsd: null,
  reasoningEffort: effort,
  usageByModel: {
    [model]: {
      inputTokens: input,
      outputTokens: output,
      totalTokens: null,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      totalCostUsd: null,
    },
  },
});

function child(id: string, extra: Partial<ChildSessionInfo> = {}): ChildSessionInfo {
  return {
    id,
    title: null,
    task_summary: null,
    tool: null,
    session_name: null,
    current_task_status: "completed",
    busy: false,
    last_message_preview: null,
    pending_elicitations_count: 0,
    created_at: 1000,
    updated_at: 1100,
    ...extra,
  };
}

afterEach(() => {
  cleanup();
  usageMock.mockReset();
});

describe("Agents card usage", () => {
  it("shows role, effort and tokens per row and a total split by model", async () => {
    usageMock.mockImplementation(async (id: string) =>
      id === "conv_root"
        ? {
            ...usage("claude-opus-4-8", 10_000, 6_000),
            usageByModel: {
              ...usage("claude-opus-4-8", 10_000, 6_000).usageByModel,
              ...usage("claude-sonnet-5-5", 200_000, 32_000).usageByModel,
            },
          }
        : usage("claude-sonnet-5-5", 100_000, 16_000, "medium"),
    );
    const live = { busy: true, current_task_status: "in_progress" };
    const agents = [child("a", { ...live, labels: { "ae.role": "builder" } }), child("b", live)];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ul>
          <AeAgentsSections
            rootSessionId="conv_root"
            agents={agents}
            renderRow={(c) => (
              <li key={c.id}>
                <AeAgentMetaLine child={c} />
              </li>
            )}
          />
        </ul>
      </QueryClientProvider>,
    );
    await screen.findAllByTestId("subagent-tokens");
    await screen.findByTestId("agents-total");
    expect(screen.getByText("Builder")).toBeTruthy();
    expect(screen.getAllByTestId("subagent-tokens").map((n) => n.textContent)).toEqual([
      "116k",
      "116k",
    ]);
    expect(screen.getAllByTestId("subagent-effort")).toHaveLength(2);
    const total = screen.getByTestId("agents-total");
    expect(total.textContent).toContain("248k tokens");
    expect(total.textContent).toContain("(lead 16k)");
    expect(total.textContent).toContain("Sonnet 94%");
  });

  it("hides the total when no usage is known", async () => {
    usageMock.mockRejectedValue(new Error("down"));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ul>
          <AeAgentsSections
            rootSessionId="conv_root"
            agents={[child("a", { busy: true, current_task_status: "in_progress" })]}
            renderRow={(c) => <li key={c.id}>{c.id}</li>}
          />
        </ul>
      </QueryClientProvider>,
    );
    await screen.findByText("a");
    expect(screen.queryByTestId("agents-total")).toBeNull();
  });

  it("shows a native subagent's model and effort from the lead's Agent call", async () => {
    usageMock.mockRejectedValue(new Error("none"));
    useChatStore.setState({
      conversationId: "conv_root",
      blocks: [
        {
          type: "tool_group",
          executions: [
            { name: "Agent", callId: "tu_1", arguments: { model: "sonnet", effort: "high" } },
          ],
        },
      ] as never,
    });
    const agents = [
      child("a", {
        busy: true,
        current_task_status: "in_progress",
        labels: { "omnigent.claude_native.tool_use_id": "tu_1" },
      }),
    ];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ul>
          <AeAgentsSections
            rootSessionId="conv_root"
            agents={agents}
            renderRow={(c) => (
              <li key={c.id}>
                <AeAgentMetaLine child={c} withModel />
              </li>
            )}
          />
        </ul>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("subagent-model-chip")).toHaveTextContent("Sonnet");
    expect(screen.getByTestId("subagent-effort").textContent).toBe("high");
  });

  it.each([
    [100_000, "120k tokens", "(lead 0)"],
    [300_000, "300k tokens", "(lead 180k)"],
  ])("totals a lead of %s with two 60k children", async (leadTokens, totalText, leadText) => {
    usageMock.mockImplementation(async (id: string) =>
      id === "conv_root"
        ? usage("claude-opus-4-8", leadTokens, 0)
        : usage("claude-sonnet-5-5", 60_000, 0),
    );
    const live = { busy: true, current_task_status: "in_progress" };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ul>
          <AeAgentsSections
            rootSessionId="conv_root"
            agents={[child("a", live), child("b", live)]}
            renderRow={(c) => <li key={c.id}>{c.id}</li>}
          />
        </ul>
      </QueryClientProvider>,
    );
    const total = await screen.findByTestId("agents-total");
    expect(total.textContent).toContain(totalText);
    expect(total.textContent).toContain(leadText);
  });

  it("reads usage only for the rows shown, not folded finished ones", async () => {
    usageMock.mockResolvedValue(usage("claude-sonnet-5-5", 1000, 0));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ul>
          <AeAgentsSections
            rootSessionId="conv_root"
            agents={[
              child("run", { busy: true, current_task_status: "in_progress" }),
              child("done"),
            ]}
            renderRow={(c) => <li key={c.id}>{c.id}</li>}
          />
        </ul>
      </QueryClientProvider>,
    );
    await screen.findByText("run");
    const ids = usageMock.mock.calls.map((c) => c[0]);
    expect(ids).toContain("run");
    expect(ids).not.toContain("done");
  });

  it("leaves out the lead figure while finished children are folded and unread", async () => {
    usageMock.mockImplementation(async (id: string) =>
      usage("claude-sonnet-5-5", id === "conv_root" ? 300_000 : 60_000, 0),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ul>
          <AeAgentsSections
            rootSessionId="conv_root"
            agents={[
              child("run", { busy: true, current_task_status: "in_progress" }),
              child("done"),
            ]}
            renderRow={(c) => <li key={c.id}>{c.id}</li>}
          />
        </ul>
      </QueryClientProvider>,
    );
    const total = await screen.findByTestId("agents-total");
    expect(total.textContent).toContain("300k tokens");
    expect(total.textContent).not.toContain("lead");
  });
});
