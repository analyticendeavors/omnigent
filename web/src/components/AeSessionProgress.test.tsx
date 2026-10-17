import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AE_ACTIVITY_SCHEDULED_KEY } from "@/hooks/aeSessionActivityHooks";
import { childSessionsQueryKey } from "@/hooks/useChildSessions";
import type { AnyBlock } from "@/lib/blocks";
import { useChatStore } from "@/store/chatStore";
import { createInitialConversationState } from "@/store/conversationState";
import { AeSessionActivityLine } from "./AeSessionActivity";

const NOW = new Date(2026, 9, 17, 8, 30, 0).getTime();
const CONV = "conv_ae_progress";
const CRUNCHING = { label: "Crunching", elapsed: "4m 42s", tokens: "24.5k tokens" };

const userMessage = (atMs: number) =>
  ({
    type: "user_message",
    ctx: {
      agent: null,
      depth: 0,
      turn: 0,
      timestamp: 0,
      responseId: "r",
      itemId: null,
      clientCreatedAtS: atMs / 1000,
    },
    content: [],
  }) as AnyBlock;

let qc: QueryClient;

function setup(state: Partial<ReturnType<typeof useChatStore.getState>>) {
  useChatStore.setState({
    ...createInitialConversationState(),
    conversationId: CONV,
    sessionStatus: "running",
    ...state,
  });
  qc.setQueryData(childSessionsQueryKey(CONV), []);
  qc.setQueryData(AE_ACTIVITY_SCHEDULED_KEY, []);
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <AeSessionActivityLine showsWorking />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { headers: { "content-type": "application/json" } })),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useChatStore.setState({ ...createInitialConversationState(), conversationId: null });
});

describe("Working row progress", () => {
  it("shows the terminal's spinner line while no tool step is known", () => {
    setup({
      blocks: [userMessage(NOW - 300_000)],
      lastEventAt: NOW - 282_000,
      aeProgress: CRUNCHING,
    });
    const row = screen.getByTestId("working-indicator");
    expect(row).toHaveAttribute("data-ae-activity", "working");
    expect(screen.getByTestId("ae-activity-progress")).toHaveTextContent(
      "Crunching · 4m 42s · 24.5k tokens",
    );
    expect(row).toHaveTextContent("last activity 4m ago");
    expect(screen.queryByTestId("ae-activity-no-output")).toBeNull();
  });

  it("hints at a silent step once a minute passes with no content", () => {
    setup({ blocks: [userMessage(NOW - 30_000)] });
    expect(screen.queryByTestId("ae-activity-no-output")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(screen.getByTestId("ae-activity-no-output")).toHaveTextContent(
      "no output yet; a long step may be writing",
    );
  });

  it("drops the hint when a spinner line arrives", () => {
    setup({ blocks: [userMessage(NOW - 90_000)] });
    expect(screen.getByTestId("ae-activity-no-output")).toBeInTheDocument();

    act(() => {
      useChatStore.setState({ aeProgress: CRUNCHING });
    });
    expect(screen.queryByTestId("ae-activity-no-output")).toBeNull();
    expect(screen.getByTestId("ae-activity-progress")).toBeInTheDocument();
  });
});
