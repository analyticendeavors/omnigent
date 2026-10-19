import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  snapshot: { loading: false } as Record<string, unknown>,
  snapshotArgs: [] as unknown[],
  refresh: vi.fn(),
  codex: {} as Record<string, unknown>,
  codexEnabled: [] as boolean[],
  refetch: vi.fn(),
}));

vi.mock("@/hooks/useSession", () => ({ useSession: () => ({ session: state.session }) }));
vi.mock("@/components/aeContextUsage", () => ({
  aeContextIdentity: (h: string | null, m: string | null) => `${h ?? ""}:${m ?? ""}`,
  useAeContextSnapshot: (...args: unknown[]) => {
    state.snapshotArgs.push(args);
    return { ...state.snapshot, refresh: state.refresh };
  },
}));
vi.mock("./aeRailQueries", () => ({
  useAeRailCodexMcp: (_id: string, enabled: boolean) => {
    state.codexEnabled.push(enabled);
    return { isFetching: false, refetch: state.refetch, error: null, ...state.codex };
  },
}));

import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import { AeRailConnectors } from "./AeRailConnectors";

beforeEach(() => {
  state.session = null;
  state.snapshot = { loading: false };
  state.snapshotArgs = [];
  state.refresh.mockReset();
  state.codex = {};
  state.codexEnabled = [];
  state.refetch.mockReset();
  useAeSessionRailStore.setState({ open: true, folded: { connectors: false } });
});
afterEach(cleanup);

describe("AeRailConnectors", () => {
  it("lists Claude Code servers from the shared snapshot, failed first", () => {
    state.session = { harness: "claude-native", llmModel: "claude-opus-5-5" };
    state.snapshot = {
      loading: false,
      data: {
        available: true,
        observedAt: new Date().toISOString(),
        mcpServers: [
          { name: "ae", status: "connected" },
          { name: "omnigent", status: "connected" },
          { name: "raymcp", status: "failed" },
          { name: "github", status: "needs-auth" },
        ],
      },
    };
    render(<AeRailConnectors sessionId="s1" />);
    expect(state.snapshotArgs.at(-1)).toEqual([
      "s1",
      { enabled: true, identity: "claude-native:claude-opus-5-5" },
    ]);
    expect(state.codexEnabled.at(-1)).toBe(false);
    const names = screen.getAllByTitle(/: /).map((row) => row.getAttribute("title"));
    expect(names).toEqual([
      "raymcp: failed",
      "github: needs sign-in",
      "ae: connected",
      "omnigent: connected",
    ]);
    expect(screen.getByText("1 of 4 failed").className).toContain("text-destructive");
    expect(screen.getByText("Checked just now")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh connector status" }));
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not probe while folded but keeps the cached summary", () => {
    state.session = { harness: "claude-native" };
    state.snapshot = {
      loading: false,
      data: {
        available: true,
        observedAt: new Date().toISOString(),
        mcpServers: [{ name: "ae", status: "connected" }],
      },
    };
    useAeSessionRailStore.setState({ folded: { connectors: true } });
    render(<AeRailConnectors sessionId="s1" />);
    expect(state.snapshotArgs.at(-1)).toEqual([
      "s1",
      { enabled: false, identity: "claude-native:" },
    ]);
    expect(screen.getByText("1 connected")).toBeTruthy();
    expect(screen.queryByText("ae")).toBeNull();
  });

  it("passes on the snapshot's reason when Claude cannot be read", () => {
    state.session = { harness: "claude-native" };
    state.snapshot = {
      loading: false,
      data: { available: false, reason: "No live Claude process for this session." },
    };
    render(<AeRailConnectors sessionId="s1" />);
    expect(screen.getByText("No live Claude process for this session.")).toBeTruthy();
  });

  it("keeps checking, with no error, while Claude starts", () => {
    state.session = { harness: "claude-native" };
    state.snapshot = {
      loading: true,
      pending: true,
      data: { available: false, pending: true, reason: "Claude is starting." },
    };
    render(<AeRailConnectors sessionId="s1" />);
    expect(screen.getByText("Checking connectors…")).toBeTruthy();
    expect(screen.queryByText("Claude is starting.")).toBeNull();
  });

  it("says when the runner reports no servers field yet", () => {
    state.session = { harness: "claude-native" };
    state.snapshot = { loading: false, data: { available: true, observedAt: "x" } };
    render(<AeRailConnectors sessionId="s1" />);
    expect(screen.getByText(/No connector report yet\. Refresh to check/)).toBeTruthy();
  });

  it("shows Codex servers from its startup report", () => {
    state.session = { harness: "codex-native" };
    state.codex = {
      data: {
        available: true,
        observedAt: null,
        servers: [
          { name: "playwright", status: "connected" },
          { name: "slow", status: "pending" },
        ],
      },
    };
    render(<AeRailConnectors sessionId="s1" />);
    expect(state.codexEnabled.at(-1)).toBe(true);
    expect(state.snapshotArgs.at(-1)).toEqual([
      null,
      { enabled: false, identity: "codex-native:" },
    ]);
    expect(screen.getByTitle("slow: starting")).toBeTruthy();
    expect(screen.getByTitle("playwright: connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh connector status" }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });

  it("shows a Codex error and the empty report", () => {
    state.session = { harness: "codex-native" };
    state.codex = { error: new Error("Connector status needs edit access to this session.") };
    const { rerender } = render(<AeRailConnectors sessionId="s1" />);
    expect(screen.getByText("Connector status needs edit access to this session.")).toBeTruthy();
    state.codex = { data: { available: false, servers: [], observedAt: null } };
    rerender(<AeRailConnectors sessionId="s1" />);
    expect(screen.getByText(/Codex reports its MCP servers as it starts/)).toBeTruthy();
  });

  it("says which harnesses report connectors", () => {
    state.session = { harness: "claude-sdk" };
    render(<AeRailConnectors sessionId="s1" />);
    expect(
      screen.getByText("Connector status is reported for Claude Code and Codex sessions."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh connector status" })).toBeNull();
  });
});
