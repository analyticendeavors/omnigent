import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode, useState } from "react";
import { cleanup, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { authenticatedFetch } from "@/lib/identity";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import { AeRailAgents } from "./AeRailAgents";

/** A fresh QueryClient per render, retries off, as the app's provider supplies one. */
function QueryWrapper({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: QueryWrapper });

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

function child(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `codex:${id}`,
    task_summary: null,
    tool: null,
    session_name: null,
    current_task_status: null,
    busy: true,
    ...extra,
  };
}

/** Answers the child list, each session's snapshot, and the limits relay. */
function route(children: Record<string, unknown>[] | null, sessions: Record<string, object> = {}) {
  vi.mocked(authenticatedFetch).mockImplementation((input) => {
    const url = String(input);
    if (url.split("?")[0] === "/v1/ae/limits") return json({ now: "", harnesses: {} });
    if (url.endsWith("/child_sessions")) {
      return children ? json({ object: "list", data: children }) : json({ detail: "x" }, 500);
    }
    const id = url.match(/^\/v1\/sessions\/([^/?]+)\?/)?.[1] ?? "";
    return json({ id, agent_id: "a", status: "idle", created_at: 0, ...sessions[id] });
  });
}

beforeEach(() => {
  vi.mocked(authenticatedFetch).mockReset();
  useAeSessionRailStore.setState({ open: true, sheetOpen: false, folded: {} });
});
afterEach(cleanup);

describe("AeRailAgents", () => {
  it("gives each agent its own window, counts subagents, and sums nothing", async () => {
    route(
      [
        child("conv_codex", { task_summary: "Review the diff" }),
        child("conv_sonnet", { task_summary: "Write the docs" }),
        child("conv_old", { task_summary: "Old pass", busy: false }),
        child("conv_sub1", { labels: { "omnigent.wrapper": "claude-code-native-ui-subagent" } }),
        child("conv_sub2", { labels: { "omnigent.wrapper": "claude-code-native-ui-subagent" } }),
      ],
      {
        conv_codex: {
          harness: "codex-native",
          llm_model: "gpt-6-astra",
          context_window: 400_000,
          last_total_tokens: 88_000,
        },
        conv_sonnet: {
          harness: "pi",
          llm_model: "claude-sonnet-5-5",
          context_window: 1_000_000,
          last_total_tokens: 410_000,
        },
        conv_old: { harness: "codex-native" },
      },
    );
    render(<AeRailAgents sessionId="conv_root" />);
    await waitFor(() => expect(screen.getAllByTestId("ae-rail-agent")).toHaveLength(3));
    expect(screen.getByText("4 running")).toBeTruthy();
    const rows = screen.getAllByTestId("ae-rail-agent").map((row) => row.textContent);
    expect(rows).toEqual([
      "Review the diffCodex · gpt-6-astra22%",
      "Write the docsPi · Sonnet 5.541%",
      "Old passCodex · finishedNo reading",
    ]);
    expect(screen.getByText(/2 Claude Code subagents/).textContent).toBe(
      "2 Claude Code subagents · no reading",
    );
  });

  it("says when the session has no other agents", async () => {
    route([]);
    render(<AeRailAgents sessionId="conv_root" />);
    expect(await screen.findByText("No other agents in this session.")).toBeTruthy();
    const section = screen.getByRole("region", { name: "Agents" });
    expect(within(section).queryByText(/running/)).toBeNull();
  });

  it("says what failed when the child list cannot load", async () => {
    route(null);
    render(<AeRailAgents sessionId="conv_root" />);
    expect(await screen.findByText(/Could not list this session's agents \(500/)).toBeTruthy();
  });

  it("fetches nothing while folded or the rail is closed", () => {
    route([]);
    useAeSessionRailStore.setState({ folded: { agents: true } });
    render(<AeRailAgents sessionId="conv_root" />);
    useAeSessionRailStore.setState({ open: false, folded: {} });
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});
