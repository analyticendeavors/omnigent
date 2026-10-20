import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode, useState } from "react";
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
function route(
  children: Record<string, unknown>[] | null,
  sessions: Record<string, object> = {},
  items: Record<string, object[]> = {},
) {
  vi.mocked(authenticatedFetch).mockImplementation((input) => {
    const url = String(input);
    const itemsOf = url.match(/^\/v1\/sessions\/([^/?]+)\/items\?/)?.[1];
    if (itemsOf) return json({ object: "list", data: items[itemsOf] ?? [] });
    if (url.split("?")[0] === "/v1/ae/limits") return json({ now: "", harnesses: {} });
    if (url.endsWith("/child_sessions")) {
      return children ? json({ object: "list", data: children }) : json({ detail: "x" }, 500);
    }
    const id = url.match(/^\/v1\/sessions\/([^/?]+)\?/)?.[1] ?? "";
    return json({ id, agent_id: "a", status: "idle", created_at: 0, ...sessions[id] });
  });
}

const SUBAGENT = { "omnigent.wrapper": "claude-code-native-ui-subagent" };

beforeEach(() => {
  vi.mocked(authenticatedFetch).mockReset();
  window.localStorage.removeItem("ae.rail.agents.finishedOpen");
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
        child("conv_sub1", { tool: "Find the card", labels: SUBAGENT }),
        child("conv_sub2", { tool: "Map the data", labels: SUBAGENT }),
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
    const subs = screen.getAllByTestId("ae-rail-subagent").map((row) => row.textContent);
    expect(subs).toEqual(["Find the card", "Map the data"]);
  });

  it("notes when a running subagent waits on the user and never shows its prompt", async () => {
    const now = Math.floor(Date.now() / 1000);
    route([
      child("conv_a", {
        tool: "Find the card",
        labels: SUBAGENT,
        created_at: now - 180,
        last_message_preview: "Reading aeSessionContext.ts",
      }),
      child("conv_b", {
        tool: "Review the diff",
        labels: SUBAGENT,
        created_at: now - 420,
        last_message_preview: "Checking the tests",
        pending_elicitations_count: 1,
      }),
      child("conv_c", {
        tool: "Start up",
        labels: SUBAGENT,
        last_message_preview: "<system-reminder>context</system-reminder>",
      }),
    ]);
    render(<AeRailAgents sessionId="conv_root" />);
    await waitFor(() => expect(screen.getAllByTestId("ae-rail-subagent")).toHaveLength(3));
    const rows = screen.getAllByTestId("ae-rail-subagent");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Find the card3m",
      "Review the diff7mWaiting on you",
      "Start up",
    ]);
    expect(rows.map((row) => row.dataset.activity)).toEqual(["working", "awaiting", "working"]);
    expect(screen.getByText("3 running")).toBeTruthy();
    expect(screen.queryByTestId("ae-rail-agents-finished-toggle")).toBeNull();
  });

  it("shows a running subagent's newest step over its prompt", async () => {
    route(
      [
        child("conv_a", {
          tool: "Find the card",
          labels: SUBAGENT,
          last_message_preview: "Read-only task, timebox 6 minutes",
        }),
        child("conv_b", { tool: "Map the data", labels: SUBAGENT }),
      ],
      {},
      {
        conv_a: [
          { type: "function_call_output", output: "..." },
          {
            type: "function_call",
            name: "Bash",
            arguments: JSON.stringify({ command: "head -5 x", description: "Read patch 0086" }),
          },
        ],
        conv_b: [
          {
            type: "function_call",
            name: "Read",
            arguments: JSON.stringify({ file_path: "/a/b/aeSessionContext.ts" }),
          },
        ],
      },
    );
    render(<AeRailAgents sessionId="conv_root" />);
    await waitFor(() =>
      expect(screen.getAllByTestId("ae-rail-subagent").map((row) => row.textContent)).toEqual([
        "Find the cardRead patch 0086",
        "Map the dataReading aeSessionContext.ts",
      ]),
    );
  });

  it("folds finished subagents into a Finished group that remembers being opened", async () => {
    const now = Math.floor(Date.now() / 1000);
    route([
      child("conv_live", { tool: "Still going", labels: SUBAGENT }),
      child("conv_old", {
        tool: "Older pass",
        labels: SUBAGENT,
        busy: false,
        current_task_status: "completed",
        updated_at: now - 2400,
      }),
      child("conv_new", {
        tool: "Newer pass",
        labels: SUBAGENT,
        busy: false,
        current_task_status: "completed",
        updated_at: now - 720,
      }),
    ]);
    const first = render(<AeRailAgents sessionId="conv_root" />);
    const toggle = await screen.findByTestId("ae-rail-agents-finished-toggle");
    expect(toggle.textContent).toBe("Finished2");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByTestId("ae-rail-subagent")).toHaveLength(1);
    fireEvent.click(toggle);
    const rows = screen.getAllByTestId("ae-rail-subagent").map((row) => row.textContent);
    expect(rows).toEqual(["Still going", "Newer pass12m ago", "Older pass40m ago"]);
    first.unmount();
    render(<AeRailAgents sessionId="conv_root" />);
    expect(
      (await screen.findByTestId("ae-rail-agents-finished-toggle")).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("hides subagents cleared in the Agents tab", async () => {
    const now = Math.floor(Date.now() / 1000);
    window.localStorage.setItem("ae.agentsPane.clearedAt.conv_root", String(now - 600));
    route([
      child("conv_cleared", {
        tool: "Cleared pass",
        labels: SUBAGENT,
        busy: false,
        current_task_status: "completed",
        updated_at: now - 900,
      }),
      child("conv_kept", {
        tool: "Kept pass",
        labels: SUBAGENT,
        busy: false,
        current_task_status: "completed",
        updated_at: now - 60,
      }),
    ]);
    try {
      render(<AeRailAgents sessionId="conv_root" />);
      const toggle = await screen.findByTestId("ae-rail-agents-finished-toggle");
      expect(toggle.textContent).toBe("Finished1");
      expect(screen.getByText("1 finished")).toBeTruthy();
    } finally {
      window.localStorage.removeItem("ae.agentsPane.clearedAt.conv_root");
    }
  });

  it("says nothing runs now when every agent has finished", async () => {
    route([
      child("conv_done", {
        tool: "Done pass",
        labels: SUBAGENT,
        busy: false,
        current_task_status: "completed",
      }),
    ]);
    render(<AeRailAgents sessionId="conv_root" />);
    expect(await screen.findByText("Nothing running now.")).toBeTruthy();
    expect(screen.getByText("1 finished")).toBeTruthy();
  });

  it("says when no agent has run in the session", async () => {
    route([]);
    render(<AeRailAgents sessionId="conv_root" />);
    expect(await screen.findByText("No agents have run in this session.")).toBeTruthy();
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
