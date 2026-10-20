import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode, useState } from "react";
import { cleanup, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { authenticatedFetch } from "@/lib/identity";
import { AeSessionHoverStatus } from "./AeSessionHoverStatus";

function QueryWrapper({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: QueryWrapper });

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const call = (name: string, args: unknown) => ({
  type: "function_call",
  name,
  arguments: JSON.stringify(args),
});
const SUBAGENT = { "omnigent.wrapper": "claude-code-native-ui-subagent" };

/** Answers each session's newest items (newest first, as the server sends them) and child lists. */
function route(items: Record<string, unknown[]>, children: Record<string, unknown[]> = {}) {
  vi.mocked(authenticatedFetch).mockImplementation((input) => {
    const url = String(input);
    const kids = url.match(/^\/v1\/sessions\/([^/?]+)\/child_sessions/)?.[1];
    if (kids) return json({ object: "list", data: children[kids] ?? [] });
    const id = url.match(/^\/v1\/sessions\/([^/?]+)\/items\?/)?.[1] ?? "";
    return json({ object: "list", data: [...(items[id] ?? [])].reverse(), has_more: false });
  });
}

const NOW = Date.now();

beforeEach(() => vi.mocked(authenticatedFetch).mockReset());
afterEach(cleanup);

describe("AeSessionHoverStatus", () => {
  it("names a waiting session's question", async () => {
    route({
      conv_a: [call("AskUserQuestion", { questions: [{ question: "Force the deploy now?" }] })],
    });
    render(
      <AeSessionHoverStatus
        sessionId="conv_a"
        state={{ kind: "awaiting", count: 1 }}
        updatedAt={NOW - 360_000}
      />,
    );
    const status = screen.getByTestId("ae-hover-status");
    expect(status).toHaveTextContent("Waiting on you");
    await waitFor(() => expect(status).toHaveTextContent("Asks: Force the deploy now?"));
  });

  it("names the step a permission request holds when no question is open", async () => {
    route({ conv_a: [call("Bash", { description: "Deploy" })] });
    render(
      <AeSessionHoverStatus
        sessionId="conv_a"
        state={{ kind: "awaiting", count: 1 }}
        updatedAt={NOW}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("ae-hover-status")).toHaveTextContent("Approve: Deploy"),
    );
  });

  it("lists up to two running agents with their newest steps", async () => {
    const child = (id: string, tool: string, busy = true) => ({
      id,
      title: `general-purpose:${id}`,
      tool,
      session_name: id,
      labels: SUBAGENT,
      current_task_status: busy ? "in_progress" : "completed",
      busy,
    });
    route(
      {
        conv_b: [call("Bash", { description: "Run the relink tests" })],
        conv_c: [call("Read", { file_path: "/x/AdminHostCard.tsx" })],
      },
      {
        conv_p: [
          child("conv_b", "Build host relink helper"),
          child("conv_c", "Review the tile"),
          child("conv_d", "Third agent"),
          child("conv_e", "Done agent", false),
        ],
      },
    );
    render(
      <AeSessionHoverStatus
        sessionId="conv_p"
        state={{ kind: "waiting", agents: 3, sinceEventMs: null }}
        updatedAt={NOW - 40_000}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("ae-hover-status-agent").map((r) => r.textContent)).toEqual([
        "Build host relink helper· Run the relink tests",
        "Review the tile· Reading AdminHostCard.tsx",
      ]),
    );
    expect(screen.getByTestId("ae-hover-status")).toHaveTextContent("Waiting on 3 agents");
    expect(screen.getByText("1 more in the Agents tab")).toBeTruthy();
  });

  it("shows an idle session's last reply and a quiet session's last step", async () => {
    route({
      conv_i: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "PR 153 is live." }],
        },
      ],
      conv_q: [call("Bash", { description: "Render the tour" })],
    });
    render(<AeSessionHoverStatus sessionId="conv_i" state={null} updatedAt={NOW - 720_000} />);
    render(
      <AeSessionHoverStatus
        sessionId="conv_q"
        state={{ kind: "quiet", quietForMs: 540_000 }}
        updatedAt={NOW - 540_000}
      />,
    );
    await waitFor(() => {
      const [idle, quiet] = screen.getAllByTestId("ae-hover-status");
      expect(idle).toHaveTextContent("IdleLast reply: PR 153 is live.");
      expect(quiet).toHaveTextContent("Quiet for 9mLast step: Render the tour");
    });
  });

  it("names a failed session's error, not its last reply", async () => {
    route({
      conv_f: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
        { type: "error", title: "Runner disconnected", message: "x" },
      ],
    });
    render(<AeSessionHoverStatus sessionId="conv_f" state={{ kind: "error" }} updatedAt={NOW} />);
    await waitFor(() =>
      expect(screen.getByTestId("ae-hover-status")).toHaveTextContent(
        "Stopped with an errorError: Runner disconnected",
      ),
    );
  });

  it("fetches nothing for a scheduled session", () => {
    route({});
    render(
      <AeSessionHoverStatus
        sessionId="conv_s"
        state={{ kind: "scheduled", at: NOW + 3_600_000, waker: "the hourly check-in" }}
        updatedAt={NOW}
      />,
    );
    expect(screen.getByTestId("ae-hover-status")).toHaveTextContent(
      /^Paused; the hourly check-in wakes it/,
    );
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});
