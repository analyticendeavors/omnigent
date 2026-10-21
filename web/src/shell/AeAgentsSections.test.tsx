import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import { useChatStore } from "@/store/chatStore";
import {
  AeAgentLastLine,
  AeAgentRowMeta,
  AeAgentsSections,
  AeAgentStopButton,
  AePlanSection,
} from "./AeAgentsSections";

const interruptMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sessionsApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  interrupt: interruptMock,
}));
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ showToast: toastMock }));

function child(overrides: Partial<ChildSessionInfo> & { id: string }): ChildSessionInfo {
  return {
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
    ...overrides,
  };
}
const running = (id: string, extra: Partial<ChildSessionInfo> = {}) =>
  child({ id, busy: true, current_task_status: "in_progress", ...extra });

function sections(agents: ChildSessionInfo[], rootSessionId = "conv_root") {
  return (
    <ul>
      <AeAgentsSections
        rootSessionId={rootSessionId}
        agents={agents}
        renderRow={(c) => (
          <li key={c.id} data-testid="row">
            {c.id}
          </li>
        )}
      />
    </ul>
  );
}

function renderSections(agents: ChildSessionInfo[]) {
  return render(sections(agents));
}

const rowIds = () => screen.queryAllByTestId("row").map((r) => r.textContent);

beforeEach(() => {
  window.localStorage.clear();
  interruptMock.mockReset();
  toastMock.mockReset();
});
afterEach(() => {
  cleanup();
  useChatStore.setState({ todos: [] });
});

describe("AeAgentsSections", () => {
  it("lists running agents and folds finished ones into a counted line", () => {
    renderSections([child({ id: "a" }), running("b"), child({ id: "c" })]);
    expect(screen.getByTestId("agents-running-section")).toHaveTextContent("Running1");
    expect(screen.getByTestId("agents-finished-toggle")).toHaveTextContent("Finished2");
    expect(rowIds()).toEqual(["b"]);

    fireEvent.click(screen.getByTestId("agents-finished-toggle"));
    expect(rowIds()).toEqual(["b", "a", "c"]);
    expect(window.localStorage.getItem("ae.agentsPane.finishedOpen")).toBe("1");
  });

  it("shows failed agents in their own open Failed section, never counted as finished", () => {
    renderSections([
      child({ id: "a" }),
      running("b"),
      child({ id: "dead", current_task_status: "failed" }),
      child({ id: "c" }),
    ]);
    expect(screen.getByTestId("agents-failed-section")).toHaveTextContent("Failed1");
    expect(screen.getByTestId("agents-finished-toggle")).toHaveTextContent("Finished2");
    // Failed rows show while Finished stays folded.
    expect(rowIds()).toEqual(["b", "dead"]);
  });

  it("clears a failed-only list from the Failed header", () => {
    renderSections([running("b"), child({ id: "dead", current_task_status: "failed" })]);
    expect(screen.queryByTestId("agents-finished-section")).toBeNull();
    fireEvent.click(screen.getByTestId("agents-clear-finished"));
    expect(rowIds()).toEqual(["b"]);
    expect(screen.queryByTestId("agents-failed-section")).toBeNull();
  });

  it("clears finished agents from the view and brings them back", () => {
    window.localStorage.setItem("ae.agentsPane.finishedOpen", "1");
    const { rerender } = renderSections([child({ id: "a" }), running("b")]);
    fireEvent.click(screen.getByTestId("agents-clear-finished"));
    expect(rowIds()).toEqual(["b"]);
    expect(window.localStorage.getItem("ae.agentsPane.clearedAt.conv_root")).toBe("1100");

    // An agent that finishes after the clear shows up again.
    rerender(sections([child({ id: "a" }), child({ id: "b", updated_at: 1200 })]));
    expect(rowIds()).toEqual(["b"]);

    fireEvent.click(screen.getByTestId("agents-restore-cleared"));
    expect(rowIds()).toEqual(["a", "b"]);
    expect(window.localStorage.getItem("ae.agentsPane.clearedAt.conv_root")).toBeNull();
  });

  it("keeps each session's Clear to that session", () => {
    window.localStorage.setItem("ae.agentsPane.finishedOpen", "1");
    window.localStorage.setItem("ae.agentsPane.clearedAt.conv_one", "5000");
    const { rerender } = render(sections([child({ id: "a" })], "conv_one"));
    expect(rowIds()).toEqual([]);

    // The pane stays mounted when the user opens another session.
    rerender(sections([child({ id: "x" })], "conv_two"));
    expect(rowIds()).toEqual(["x"]);
    rerender(sections([child({ id: "a" })], "conv_one"));
    expect(rowIds()).toEqual([]);
  });

  it("offers no Clear when the server sent no finish times", () => {
    window.localStorage.setItem("ae.agentsPane.finishedOpen", "1");
    renderSections([child({ id: "a", created_at: undefined, updated_at: undefined })]);
    expect(rowIds()).toEqual(["a"]);
    expect(screen.queryByTestId("agents-clear-finished")).toBeNull();
  });

  it("renders nothing without agents", () => {
    const { container } = renderSections([]);
    expect(container.querySelector("li")).toBeNull();
  });
});

describe("row pieces", () => {
  it("shows the routed model, or nothing when none was routed, and the elapsed time", () => {
    vi.useFakeTimers({ now: 1_065_000 });
    try {
      render(
        <div>
          <AeAgentRowMeta
            child={running("r", { routed_model: "databricks-claude-sonnet-5" })}
            status={<span data-testid="dot" />}
          />
        </div>,
      );
      expect(screen.getByTestId("subagent-routed-model")).toHaveTextContent("Sonnet 5");
      expect(screen.getByTestId("subagent-elapsed")).toHaveTextContent("1m 05s");
    } finally {
      vi.useRealTimers();
    }
    cleanup();
    const { container } = render(<AeAgentRowMeta child={child({ id: "f" })} status={null} />);
    expect(screen.queryByTestId("subagent-routed-model")).toBeNull();
    expect(container).not.toHaveTextContent("default");
    expect(screen.getByTestId("subagent-elapsed")).toHaveTextContent("1m 40s");
  });

  it("shows the model the agent ran on, ahead of a routed one", () => {
    render(
      <AeAgentRowMeta
        child={child({ id: "c", model: "claude-opus-5-5[1m]", routed_model: "claude-haiku-5-5" })}
        status={null}
      />,
    );
    const cell = screen.getByTestId("subagent-model");
    expect(cell).toHaveTextContent("Opus 5.5");
    expect(cell).toHaveAttribute("title", "claude-opus-5-5[1m]");
    cleanup();
    render(<AeAgentRowMeta child={child({ id: "x", model: "gpt-6-astra" })} status={null} />);
    expect(screen.getByTestId("subagent-model")).toHaveTextContent("gpt-6-astra");
  });

  it("puts the status dot right after Time, and keeps a Stop slot after it while running", () => {
    const { container } = render(
      <div>
        <AeAgentRowMeta child={child({ id: "f" })} status={<span data-testid="dot" />} />
      </div>,
    );
    const finishedCells = container.firstElementChild!.children;
    expect(finishedCells[finishedCells.length - 1]).toContainElement(screen.getByTestId("dot"));
    cleanup();
    const { container: live } = render(
      <div>
        <AeAgentRowMeta child={running("r")} status={<span data-testid="dot" />} />
      </div>,
    );
    const runningCells = live.firstElementChild!.children;
    expect(runningCells[runningCells.length - 2]).toContainElement(screen.getByTestId("dot"));
    expect(runningCells[runningCells.length - 1]).toBeEmptyDOMElement();
  });

  it("puts a status word left of Model so the columns stay in line", () => {
    const { container } = render(
      <div>
        <AeAgentRowMeta
          child={child({ id: "f", current_task_status: "failed" })}
          status={<span data-testid="word">Failed</span>}
          statusHasWord
        />
      </div>,
    );
    const cells = container.firstElementChild!.children;
    expect(cells[0]).toBe(screen.getByTestId("word"));
    expect(cells[cells.length - 1]).toBeEmptyDOMElement();
  });

  it("says No output yet while running and hides the harness context block", () => {
    render(
      <AeAgentLastLine
        child={running("r", { last_message_preview: "<system-reminder> context" })}
        className=""
      />,
    );
    expect(screen.getByText("No output yet")).toBeInTheDocument();
    cleanup();
    const { container } = render(<AeAgentLastLine child={child({ id: "f" })} className="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("stops an agent OmniGent launched", async () => {
    interruptMock.mockResolvedValue({ queued: false });
    render(<AeAgentStopButton child={running("conv_kid", { tool: "researcher" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop researcher" }));
    expect(interruptMock).toHaveBeenCalledWith("conv_kid");
    expect(screen.getByTestId("subagent-stop")).toBeDisabled();
    // Pressable again once the call returns, in case the row has not folded yet.
    await waitFor(() => expect(screen.getByTestId("subagent-stop")).not.toBeDisabled());
  });

  it("says what failed when the stop fails", async () => {
    interruptMock.mockRejectedValue(new Error("503 Service Unavailable"));
    render(<AeAgentStopButton child={running("conv_kid", { tool: "researcher" })} />);
    fireEvent.click(screen.getByTestId("subagent-stop"));
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(String(toastMock.mock.calls[0][0])).toContain("Could not stop researcher");
    expect(screen.getByTestId("subagent-stop")).not.toBeDisabled();
  });

  it("offers no Stop on a Claude Code subagent, which runs inside the main agent", () => {
    const { container } = render(
      <AeAgentStopButton
        child={running("t", { labels: { "omnigent.wrapper": "claude-code-native-ui-subagent" } })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("AePlanSection", () => {
  it("folds the session's task list with a done count", () => {
    useChatStore.setState({
      todos: [
        { content: "Write tests", status: "completed", activeForm: "Writing tests" },
        { content: "Ship it", status: "in_progress", activeForm: "Shipping it" },
      ],
    });
    render(<AePlanSection />);
    expect(screen.getByTestId("agents-plan-toggle")).toHaveTextContent("Plan1/2");
    expect(screen.getByText("Ship it")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("agents-plan-toggle"));
    expect(screen.queryByText("Ship it")).toBeNull();
  });

  it("renders nothing without a task list", () => {
    const { container } = render(<AePlanSection />);
    expect(container).toBeEmptyDOMElement();
  });
});
