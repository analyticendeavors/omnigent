import { describe, expect, it } from "vitest";
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import {
  agentModelLabel,
  canStopChild,
  childElapsedSeconds,
  childLastLine,
  clearCutoff,
  formatElapsed,
  isChildFinished,
  splitAgentSections,
} from "./aeAgentsPaneModel";

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

const claudeTask = { labels: { "omnigent.wrapper": "claude-code-native-ui-subagent" } };

describe("splitAgentSections", () => {
  it("puts live agents under Running and settled or failed ones under Finished", () => {
    const sections = splitAgentSections(
      [
        child({ id: "done" }),
        running("busy"),
        child({ id: "failed", current_task_status: "failed" }),
        child({ id: "asking", pending_elicitations_count: 1 }),
      ],
      null,
    );
    expect(sections.running.map((c) => c.id)).toEqual(["busy", "asking"]);
    expect(sections.finished.map((c) => c.id)).toEqual(["done", "failed"]);
    expect(sections.clearedCount).toBe(0);
  });

  it("folds a stopped agent and one whose runner dropped, and keeps a launching one", () => {
    const sections = splitAgentSections(
      [
        child({ id: "stopped", current_task_status: "cancelled" }),
        child({
          id: "dropped",
          current_task_status: "failed",
          last_task_error: { code: "runner_disconnected", message: "tunnel closed" },
        }),
        child({ id: "starting", current_task_status: "launching" }),
      ],
      null,
    );
    expect(sections.running.map((c) => c.id)).toEqual(["starting"]);
    expect(sections.finished.map((c) => c.id)).toEqual(["stopped", "dropped"]);
    expect(canStopChild(sections.finished[0])).toBe(false);
  });

  it("hides finished agents last updated at or before the clear, never running ones", () => {
    const sections = splitAgentSections(
      [
        child({ id: "old", updated_at: 1100 }),
        child({ id: "new", updated_at: 1300 }),
        running("busy", { updated_at: 900 }),
      ],
      1100,
    );
    expect(sections.finished.map((c) => c.id)).toEqual(["new"]);
    expect(sections.running.map((c) => c.id)).toEqual(["busy"]);
    expect(sections.clearedCount).toBe(1);
  });
});

describe("agentModelLabel", () => {
  it("reads Claude ids as names and leaves other ids as the harness spelled them", () => {
    expect(agentModelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(agentModelLabel("databricks-claude-opus-5-5")).toBe("Opus 5.5");
    expect(agentModelLabel("claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(agentModelLabel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });
});

describe("clearCutoff", () => {
  it("is the newest finish time, never older than the last clear", () => {
    expect(
      clearCutoff(
        [child({ id: "a", updated_at: 1100 }), child({ id: "b", updated_at: 1300 })],
        null,
      ),
    ).toBe(1300);
    expect(clearCutoff([child({ id: "a", updated_at: 1100 })], 1500)).toBe(1500);
  });

  it("is null when no finished row carries a time, so the pane offers no Clear", () => {
    expect(clearCutoff([child({ id: "a", updated_at: undefined })], null)).toBeNull();
    expect(clearCutoff([], null)).toBeNull();
  });
});

describe("elapsed time", () => {
  it("counts a running agent up to now and a finished one to its last update", () => {
    expect(childElapsedSeconds(running("r"), 1_065_000)).toBe(65);
    expect(childElapsedSeconds(child({ id: "f" }), 9_999_000)).toBe(100);
  });

  it("is blank when the server sent no timestamps", () => {
    const bare = child({ id: "x", created_at: undefined });
    expect(childElapsedSeconds(bare, 0)).toBeNull();
    expect(formatElapsed(null)).toBe("");
  });

  it("formats like Claude Desktop", () => {
    expect(formatElapsed(42)).toBe("42s");
    expect(formatElapsed(185)).toBe("3m 05s");
    expect(formatElapsed(4020)).toBe("1h 07m");
  });
});

describe("canStopChild", () => {
  it("offers Stop on a running agent OmniGent launched", () => {
    expect(canStopChild(running("r"))).toBe(true);
  });

  it("never offers Stop on a finished agent or a Claude Code subagent mirror", () => {
    expect(canStopChild(child({ id: "f" }))).toBe(false);
    expect(canStopChild(running("t", claudeTask))).toBe(false);
  });
});

describe("childLastLine", () => {
  it("returns the preview, but not the harness's injected context block", () => {
    expect(childLastLine(child({ id: "a", last_message_preview: "Reading files" }))).toBe(
      "Reading files",
    );
    expect(
      childLastLine(child({ id: "b", last_message_preview: "<system-reminder> As you answer" })),
    ).toBeNull();
    expect(childLastLine(child({ id: "c" }))).toBeNull();
  });
});

describe("isChildFinished", () => {
  it("treats an awaiting agent as running", () => {
    expect(isChildFinished(child({ id: "a", pending_elicitations_count: 2 }))).toBe(false);
  });
});
