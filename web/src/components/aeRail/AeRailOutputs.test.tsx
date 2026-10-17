import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceChangedFile } from "@/hooks/useWorkspaceChangedFiles";

const state = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  enabled: [] as (boolean | undefined)[],
  serveable: true as boolean | undefined,
  environment: {} as Record<string, unknown>,
  openFile: vi.fn() as ((path: string) => void) | null,
}));

vi.mock("@/hooks/useWorkspaceChangedFiles", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useWorkspaceChangedFiles: (_id: string, opts?: { enabled?: boolean }) => {
    state.enabled.push(opts?.enabled);
    return state.query;
  },
  useWorkspaceServeable: () => state.serveable,
  useWorkspaceEnvironment: () => state.environment,
}));
vi.mock("@/shell/FileViewerContext", () => ({ useFileViewer: () => state.openFile }));

import { RunnerOfflineError } from "@/hooks/useWorkspaceChangedFiles";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import { AeRailOutputs } from "./AeRailOutputs";

function created(path: string, modified_at: number): WorkspaceChangedFile {
  return {
    path,
    name: path.split("/").pop() ?? path,
    status: "created",
    bytes: 1,
    modified_at,
    lines_added: 1,
    lines_removed: 0,
  };
}

beforeEach(() => {
  state.query = { isPending: false };
  state.enabled = [];
  state.serveable = true;
  state.environment = {};
  state.openFile = vi.fn();
  useAeSessionRailStore.setState({ open: true, sheetOpen: false, folded: { outputs: false } });
});
afterEach(cleanup);

describe("AeRailOutputs", () => {
  it("lists created files newest first and opens one in the viewer", () => {
    state.query = {
      isPending: false,
      data: {
        available: true,
        data: [
          created("docs/notes.md", 1),
          { ...created("src/edited.ts", 9), status: "modified" },
          created("shots/rail.png", 5),
        ],
      },
    };
    render(<AeRailOutputs sessionId="s1" />);
    expect(state.enabled.at(-1)).toBe(true);
    const rows = screen.getAllByRole("button", { name: /open in the file viewer|rail|notes/ });
    expect(rows.map((row) => row.getAttribute("title"))).toEqual([
      "shots/rail.png: open in the file viewer",
      "docs/notes.md: open in the file viewer",
    ]);
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.queryByText("edited.ts")).toBeNull();
    fireEvent.click(rows[0]);
    expect(state.openFile).toHaveBeenCalledWith("shots/rail.png");
  });

  it("closes the phone sheet so the opened file is visible", () => {
    useAeSessionRailStore.setState({ open: false, sheetOpen: true });
    state.query = { data: { available: true, data: [created("a.ts", 1)] } };
    render(<AeRailOutputs sessionId="s1" />);
    fireEvent.click(screen.getByTitle("a.ts: open in the file viewer"));
    expect(useAeSessionRailStore.getState().sheetOpen).toBe(false);
  });

  it("shows plain rows when no viewer is mounted", () => {
    state.openFile = null;
    state.query = { data: { available: true, data: [created("a.ts", 1)] } };
    render(<AeRailOutputs sessionId="s1" />);
    expect(screen.queryByRole("button", { name: /a\.ts/ })).toBeNull();
    expect(screen.getByTitle("a.ts")).toBeTruthy();
  });

  it("covers empty, no workspace, offline and folded", () => {
    state.query = { data: { available: true, data: [] } };
    const { rerender } = render(<AeRailOutputs sessionId="s1" />);
    expect(screen.getByText("No new files yet.")).toBeTruthy();
    state.query = { data: { available: false, data: [] } };
    rerender(<AeRailOutputs sessionId="s1" />);
    expect(screen.getByText("This session has no workspace to create files in.")).toBeTruthy();
    state.query = { error: new RunnerOfflineError() };
    rerender(<AeRailOutputs sessionId="s1" />);
    expect(screen.getByText(/runner is offline/)).toBeTruthy();
    useAeSessionRailStore.setState({ folded: { outputs: true } });
    rerender(<AeRailOutputs sessionId="s1" />);
    expect(state.enabled.at(-1)).toBe(false);
  });

  it("says why nothing loads when the workspace query cannot run", () => {
    state.query = { isPending: true };
    state.environment = { data: { available: false } };
    const { rerender } = render(<AeRailOutputs sessionId="s1" />);
    expect(screen.getByText("This session has no workspace to create files in.")).toBeTruthy();
    expect(screen.queryByText("Loading files…")).toBeNull();
    state.environment = {};
    state.serveable = false;
    rerender(<AeRailOutputs sessionId="s1" />);
    expect(screen.getByText("The host is offline; files show once it reconnects.")).toBeTruthy();
    expect(screen.queryByText("Loading files…")).toBeNull();
    state.serveable = true;
    rerender(<AeRailOutputs sessionId="s1" />);
    expect(screen.getByText("Loading files…")).toBeTruthy();
  });

  it("shows eight files until Show all, then every file", () => {
    const files = Array.from({ length: 11 }, (_, i) => created(`out/file-${i}.txt`, 100 + i));
    state.query = { isPending: false, data: { available: true, data: files } };
    render(<AeRailOutputs sessionId="s1" />);
    expect(screen.getAllByRole("button", { name: /file-\d+\.txt/ })).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Show all 11" }));
    expect(screen.getAllByRole("button", { name: /file-\d+\.txt/ })).toHaveLength(11);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.getAllByRole("button", { name: /file-\d+\.txt/ })).toHaveLength(8);
  });
});
