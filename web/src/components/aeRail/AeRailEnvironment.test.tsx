import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  hosts: [] as { host_id: string; name: string; status: string }[],
  hostOnline: undefined as boolean | null | undefined,
  runnerOnline: undefined as boolean | undefined,
  env: undefined as { root: string | null; home: string | null; available: boolean } | undefined,
  github: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@/hooks/useSession", () => ({ useSession: () => ({ session: state.session }) }));
vi.mock("@/hooks/useHosts", () => ({ useHosts: () => ({ data: state.hosts }) }));
vi.mock("@/hooks/RunnerHealthProvider", () => ({
  useSessionHostOnline: () => state.hostOnline,
  useSessionRunnerOnline: () => state.runnerOnline,
}));
vi.mock("@/hooks/useWorkspaceChangedFiles", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useWorkspaceEnvironment: () => ({ data: state.env }),
}));
vi.mock("./aeRailQueries", () => ({
  useAeRailGithubInfo: () => ({ data: state.github }),
}));

import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import { AeRailEnvironment } from "./AeRailEnvironment";

function showRail(folded = false) {
  useAeSessionRailStore.setState({ open: true, folded: { environment: folded } });
}

beforeEach(() => {
  state.session = null;
  state.hosts = [];
  state.hostOnline = undefined;
  state.runnerOnline = undefined;
  state.env = undefined;
  state.github = undefined;
  showRail();
});
afterEach(cleanup);

describe("AeRailEnvironment", () => {
  it("shows host, folder, branch, worktree and permission mode", () => {
    state.session = {
      hostId: "host_1",
      workspace: "/home/demo/repos/omnigent-ae",
      gitBranch: "ae/session-rail",
      harness: "claude-native",
      labels: { "omnigent.claude_native.permission_mode": "auto" },
    };
    state.hosts = [{ host_id: "host_1", name: "box-host", status: "online" }];
    state.hostOnline = true;
    state.env = { root: "/home/demo/repos/omnigent-ae", home: "/home/demo", available: true };
    state.github = { available: true, branch: "ae/session-rail-live" };
    render(<AeRailEnvironment sessionId="s1" />);
    expect(screen.getByText("box-host")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Host online" })).toBeTruthy();
    expect(screen.getByText("omnigent-ae")).toBeTruthy();
    expect(screen.getByText("~/repos")).toBeTruthy();
    expect(screen.getByTitle("/home/demo/repos/omnigent-ae")).toBeTruthy();
    expect(screen.getByText("ae/session-rail-live")).toBeTruthy();
    expect(screen.getByText("worktree")).toBeTruthy();
    expect(screen.getByText("Auto")).toBeTruthy();
  });

  it("says plainly what it does not know", () => {
    state.session = { hostId: null, harness: "claude-sdk", labels: {} };
    state.runnerOnline = false;
    state.github = { available: false, reason: "not_a_git_repo" };
    render(<AeRailEnvironment sessionId="s1" />);
    expect(screen.getByText("Local session")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Host offline" })).toBeTruthy();
    expect(screen.getByText("No workspace folder reported")).toBeTruthy();
    expect(screen.getByText("Not a git repository")).toBeTruthy();
    expect(screen.queryByText("worktree")).toBeNull();
    expect(screen.getByText("Permission mode not reported for this harness")).toBeTruthy();
  });

  it("before the session loads, names nothing it cannot see", () => {
    render(<AeRailEnvironment sessionId="s1" />);
    expect(screen.getByText("Host unknown")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Host status unknown" })).toBeTruthy();
    expect(screen.getByText("Branch unknown")).toBeTruthy();
  });

  it("summarises host and branch only while folded", () => {
    state.session = { hostId: "host_1", gitBranch: "dev", harness: "codex-native", labels: {} };
    state.hosts = [{ host_id: "host_1", name: "box-host", status: "online" }];
    showRail(true);
    const { rerender } = render(<AeRailEnvironment sessionId="s1" />);
    expect(screen.getByText("box-host · dev")).toBeTruthy();
    showRail(false);
    rerender(<AeRailEnvironment sessionId="s1" />);
    expect(screen.queryByText("box-host · dev")).toBeNull();
    expect(screen.getByText("Permission mode not reported yet")).toBeTruthy();
  });
});
