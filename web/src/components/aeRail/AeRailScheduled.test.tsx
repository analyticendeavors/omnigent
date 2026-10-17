// Tests for the rail's Scheduled section: the tasks aimed at this session,
// Pause and Resume through the task PATCH, the before-closing line, and the
// empty and error states.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import { useChatStore } from "@/store/chatStore";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  children: [] as ChildSessionInfo[],
}));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));
vi.mock("@/hooks/useChildSessions", () => ({
  useChildSessions: (id: string | null) => ({
    children: id ? mocks.children : [],
    isLoading: false,
    error: null,
  }),
}));
vi.mock("@/hooks/useSession", () => ({ useActiveRootSessionId: (id: string) => id }));

import { AeRailScheduled } from "./AeRailScheduled";

const CHECKIN = "a".repeat(32);
const OTHER = "b".repeat(32);

function wire(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: CHECKIN,
    name: "Task",
    prompt: "",
    rrule: "FREQ=DAILY",
    owner_user_id: null,
    agent_id: "agent",
    timezone: "America/Los_Angeles",
    created_at: 0,
    updated_at: 0,
    state: "active",
    last_run_at: null,
    last_run_status: null,
    next_run_at: null,
    ...extra,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function child(id: string, busy: boolean): ChildSessionInfo {
  return {
    id,
    title: id,
    task_summary: null,
    tool: null,
    session_name: null,
    current_task_status: null,
    busy,
    last_message_preview: null,
    pending_elicitations_count: 0,
  } as ChildSessionInfo;
}

let tasks: Record<string, unknown>[];
let patchAnswer: () => Response;

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useChatStore.setState({ conversationId: "conv_me", blocks: [], hasMoreHistory: false });
  return render(
    <QueryClientProvider client={client}>
      <AeRailScheduled sessionId="conv_me" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  tasks = [];
  patchAnswer = () => json(200, wire({ state: "paused" }));
  mocks.children = [];
  mocks.fetch.mockImplementation((url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET" && url.startsWith("/v1/scheduled-tasks")) {
      return Promise.resolve(json(200, { scheduled_tasks: tasks }));
    }
    if (init?.method === "PATCH") return Promise.resolve(patchAnswer());
    return Promise.resolve(json(404, {}));
  });
  useAeSessionRailStore.setState({ open: true, folded: {} });
});

afterEach(() => {
  cleanup();
  mocks.fetch.mockReset();
});

describe("AeRailScheduled", () => {
  it("lists the check-in and the tasks naming this session, with the closing line", async () => {
    tasks = [
      wire({
        name: "AE orchestrator check-in",
        rrule: "FREQ=HOURLY;INTERVAL=1;UNTIL=20261021T065959Z",
        prompt: "call post_message once with session_id conv_me",
        next_run_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
      wire({ id: OTHER, name: "Recheck CI on the rail pull request", prompt: "conv_me CI" }),
      wire({ id: "c".repeat(32), name: "Somebody else's", prompt: "conv_other" }),
    ];
    mocks.children = [child("k1", true), child("k2", false)];
    show();
    const rows = await screen.findAllByTestId("ae-schedule-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Check-in every hour");
    expect(rows[0]).toHaveTextContent(/Next .* · until Oct 20/);
    expect(rows[1]).toHaveTextContent("Recheck CI on the rail pull request");
    expect(screen.queryByText("Somebody else's")).toBeNull();
    const section = screen.getByRole("region", { name: "Scheduled" });
    expect(within(section).getByText("2 active")).toBeInTheDocument();
    expect(
      screen.getByText("Before closing: 2 schedules active, 1 agent running."),
    ).toBeInTheDocument();
  });

  it("pauses a task through the task PATCH", async () => {
    tasks = [wire({ name: "AE orchestrator check-in", prompt: "session_id conv_me" })];
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Pause Check-in every day" }));
    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith(
        `/v1/scheduled-tasks/${CHECKIN}`,
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ state: "paused" }) }),
      ),
    );
  });

  it("shows Paused and a Resume that sends active", async () => {
    tasks = [wire({ id: OTHER, name: "Nightly", prompt: "conv_me", state: "paused" })];
    patchAnswer = () => json(200, wire({ id: OTHER, state: "active" }));
    show();
    const row = await screen.findByTestId("ae-schedule-row");
    expect(row).toHaveTextContent("Paused");
    fireEvent.click(within(row).getByRole("button", { name: "Resume Nightly" }));
    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith(
        `/v1/scheduled-tasks/${OTHER}`,
        expect.objectContaining({ body: JSON.stringify({ state: "active" }) }),
      ),
    );
    expect(screen.queryByText(/active$/)).toBeNull();
  });

  it("says what failed when a pause does not go through", async () => {
    tasks = [wire({ id: OTHER, name: "Nightly", prompt: "conv_me" })];
    patchAnswer = () => json(500, { error: { code: "internal", message: "scheduler is offline" } });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Pause Nightly" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not pause it: scheduler is offline.",
    );
  });

  it("is empty when nothing is aimed at this session", async () => {
    tasks = [wire({ prompt: "conv_other" })];
    show();
    expect(await screen.findByText("Nothing scheduled for this session.")).toBeInTheDocument();
    expect(screen.queryByText(/Before closing/)).toBeNull();
  });

  it("keeps the closing line for running agents when nothing is scheduled", async () => {
    mocks.children = [child("k1", true)];
    show();
    expect(
      await screen.findByText("Before closing: nothing scheduled, 1 agent running."),
    ).toBeInTheDocument();
  });

  it("says when the list cannot be read", async () => {
    mocks.fetch.mockImplementation(() =>
      Promise.resolve(json(503, { error: { code: "unavailable", message: "database down" } })),
    );
    show();
    expect(
      await screen.findByText(/Could not read the scheduled tasks: database down/),
    ).toBeInTheDocument();
  });
});
