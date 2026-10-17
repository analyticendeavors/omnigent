import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AePrCard } from "@/lib/aePrs";

const state = vi.hoisted(() => ({
  github: {} as Record<string, unknown>,
  prs: [] as unknown[],
  changes: {} as Record<string, unknown>,
}));

vi.mock("./aeRailQueries", () => ({
  useAeRailGithubInfo: () => state.github,
  useAeRailPrs: () => state.prs,
}));
vi.mock("@/hooks/useWorkspaceChangedFiles", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useWorkspaceChangedFiles: () => state.changes,
}));

import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import { AeRailChanges } from "./AeRailChanges";
import { AeRailActionsContext } from "./aeRailActions";

const REPO = "analyticendeavors/omnigent-ae";
const openWorkspaceTab = vi.fn();
const ACTIONS = { openWorkspaceTab };

function card(number: number, extra: Partial<AePrCard>): AePrCard {
  return {
    repo: REPO,
    number,
    url: `https://github.com/${REPO}/pull/${number}`,
    title: `PR ${number}`,
    state: "open",
    draft: false,
    ci: { state: "pending", passing: 0, failing: 0, pending: 1, total: 1 },
    ...extra,
  } as AePrCard;
}

function pr(number: number, cardExtra?: Partial<AePrCard>) {
  return {
    url: `https://github.com/${REPO}/pull/${number}`,
    repository: REPO,
    number,
    title: cardExtra ? `PR ${number}` : null,
    card: cardExtra ? card(number, cardExtra) : undefined,
  };
}

beforeEach(() => {
  state.github = {};
  state.prs = [];
  state.changes = {};
  useAeSessionRailStore.setState({ open: true, folded: { changes: false } });
});
afterEach(cleanup);

describe("AeRailChanges", () => {
  it("lists pull requests with their state and the changed-file totals", () => {
    state.prs = [
      pr(108, {}),
      pr(106, { state: "merged" }),
      pr(99, { draft: true }),
      pr(90, { state: "closed" }),
      pr(80),
    ];
    state.changes = {
      data: {
        available: true,
        data: [
          { path: "a.ts", status: "created", lines_added: 800, lines_removed: 0 },
          { path: "b.ts", status: "modified", lines_added: 12, lines_removed: 96 },
        ],
      },
    };
    render(<AeRailChanges sessionId="s1" />);
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      `https://github.com/${REPO}/pull/108`,
      `https://github.com/${REPO}/pull/106`,
      `https://github.com/${REPO}/pull/99`,
      `https://github.com/${REPO}/pull/90`,
      `https://github.com/${REPO}/pull/80`,
    ]);
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links.map((a) => a.getAttribute("title"))).toEqual([
      "Open pull request: open on GitHub",
      "Merged pull request: open on GitHub",
      "Draft pull request: open on GitHub",
      "Closed pull request: open on GitHub",
      "Pull request: open on GitHub",
    ]);
    expect(screen.getByText("omnigent-ae #108 · checks running")).toBeTruthy();
    expect(screen.getByText("omnigent-ae #106 · merged")).toBeTruthy();
    expect(screen.getByText("Pull request #80")).toBeTruthy();
    expect(screen.getByText("5 PRs")).toBeTruthy();
    expect(screen.getByText("+812")).toBeTruthy();
    expect(screen.getByText("−96")).toBeTruthy();
    expect(screen.getByText(/2 files changed/)).toBeTruthy();
  });

  it("summarises files when there is no pull request", () => {
    state.changes = {
      data: { available: true, data: [{ path: "a.ts", lines_added: 1, lines_removed: 0 }] },
    };
    render(<AeRailChanges sessionId="s1" />);
    expect(screen.getByText("1 file")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the empty state and load errors", () => {
    const { rerender } = render(<AeRailChanges sessionId="s1" />);
    expect(screen.getByText("No pull requests or changed files yet.")).toBeTruthy();
    state.github = { error: new Error("gh is not authenticated") };
    rerender(<AeRailChanges sessionId="s1" />);
    expect(
      screen.getByText(
        "Could not load pull requests: gh is not authenticated. Reopen this section to retry.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("No pull requests or changed files yet.")).toBeNull();
  });

  it("opens the Changes tab from the totals row when the shell allows it", () => {
    state.changes = {
      data: { available: true, data: [{ path: "a.ts", lines_added: 3, lines_removed: 1 }] },
    };
    openWorkspaceTab.mockClear();
    render(
      <AeRailActionsContext.Provider value={ACTIONS}>
        <AeRailChanges sessionId="s1" />
      </AeRailActionsContext.Provider>,
    );
    screen.getByRole("button", { name: /1 file changed/ }).click();
    expect(openWorkspaceTab).toHaveBeenCalledWith("changes");
  });
});
