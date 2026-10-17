// Tests for the rail's Triage section: labels read from the sidebar's cache,
// the status switch writing what the Status menu writes, the gate's four
// answers, the absorbed and unfiled lines, Next and the parked task.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/hooks/useConversations";
import type { AnyBlock, BlockContext } from "@/lib/blocks";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import type { ConversationsInfiniteData } from "@/lib/sessionListCache";
import { useChatStore } from "@/store/chatStore";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/identity", () => ({
  authenticatedFetch: mocks.fetch,
  getCurrentAuthorId: () => null,
}));
vi.mock("@/components/ui/toast", () => ({ showToast: mocks.toast }));

import { AeRailTriage } from "./AeRailTriage";

const ctx: BlockContext = {
  agent: null,
  depth: 0,
  turn: 0,
  timestamp: 0,
  responseId: "r",
  itemId: null,
};

function conv(labels: Record<string, string>): Conversation {
  return {
    id: "s1",
    object: "conversation",
    title: "s1",
    created_at: 1,
    updated_at: 1,
    labels,
    permission_level: null,
  };
}

function pages(rows: Conversation[]): ConversationsInfiniteData {
  return {
    pages: [{ data: rows, first_id: null, last_id: null, has_more: false }],
    pageParams: [undefined],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let gateAnswer: () => Response;
let client: QueryClient;

function route(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  if (url === "/v1/ae/capacity") return Promise.resolve(json(200, { limit: 3, working: [] }));
  if (method === "PATCH" && url === "/v1/sessions/s1") return Promise.resolve(json(200, {}));
  if (url === "/v1/ae/gate/s1/reply") return Promise.resolve(gateAnswer());
  if (url.startsWith("/v1/ae/lot")) {
    return Promise.resolve(
      json(200, { tasks: [{ id: "t9", title: "Show live PRs", url: "https://tasks.example/x" }] }),
    );
  }
  return Promise.resolve(json(404, { detail: "Not Found" }));
}

function setLabels(labels: Record<string, string>) {
  act(() => client.setQueryData(["conversations"], pages([conv(labels)])));
}

function show(labels: Record<string, string> | null, blocks: AnyBlock[] = []) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (labels) client.setQueryData(["conversations"], pages([conv(labels)]));
  useChatStore.setState({ conversationId: "s1", blocks, hasMoreHistory: false });
  return render(
    <QueryClientProvider client={client}>
      <AeRailTriage sessionId="s1" />
    </QueryClientProvider>,
  );
}

function said(text: string): AnyBlock {
  return { type: "text_done", ctx, fullText: text, hasCodeBlocks: false };
}

function asked(text: string): AnyBlock {
  return { type: "user_message", ctx, content: [{ type: "input_text", text }] };
}

beforeEach(() => {
  gateAnswer = () => json(200, { posted: true });
  mocks.fetch.mockImplementation(route);
  useAeSessionRailStore.setState({ open: true, folded: {} });
});

afterEach(() => {
  cleanup();
  mocks.fetch.mockReset();
  mocks.toast.mockReset();
});

describe("AeRailTriage", () => {
  it("shows the status, the started line, the turns and the tags", () => {
    const started = Math.floor(Date.now() / 1000) - (2 * 3600 + 10 * 60);
    show(
      {
        "ae.status": "working",
        "ae.started": String(started),
        "ae.overflow": "1",
        "ae.triage": "capture",
      },
      [asked("one"), said("reply"), asked("two")],
    );
    const section = screen.getByRole("region", { name: "Triage" });
    expect(within(section).getAllByText("Working")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Working" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("ae-triage-started")).toHaveTextContent(
      "Started 2h 10m ago · 2 turns",
    );
    expect(screen.getByText("4th working")).toHaveAttribute(
      "title",
      "Started while three sessions were already working",
    );
    expect(screen.getByText("Capture mode")).toBeInTheDocument();
    expect(screen.queryByTestId("ae-triage-gate")).toBeNull();
  });

  it("sets the status through the labels PATCH, the way the Status menu does", async () => {
    show({ "ae.status": "working" });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Review" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(mocks.fetch).toHaveBeenCalledWith("/v1/sessions/s1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: { "ae.status": "review" } }),
    });
  });

  it("refuses Working at the slot limit with the menu's toast", async () => {
    mocks.fetch.mockImplementation((url: string, init?: RequestInit) =>
      url === "/v1/ae/capacity"
        ? Promise.resolve(
            json(200, {
              limit: 3,
              working: [
                { id: "a", title: "A" },
                { id: "b", title: "B" },
                { id: "c", title: "C" },
              ],
            }),
          )
        : route(url, init),
    );
    show({ "ae.status": "parked" });
    fireEvent.click(screen.getByRole("button", { name: "Working" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(String(mocks.toast.mock.calls[0][0])).toContain("all 3 slots are working");
    expect(mocks.fetch).not.toHaveBeenCalledWith("/v1/sessions/s1", expect.anything());
  });

  it("answers an open gate and shows the answer until the labels change", async () => {
    show({
      "ae.status": "working",
      "ae.gate": "open",
      "ae.fork": "Show which merged pull requests are live on the box",
      "ae.fork_suspect": "0123456789abcdef",
    });
    const section = screen.getByRole("region", { name: "Triage" });
    expect(within(section).getByText("1 question open")).toBeInTheDocument();
    const gate = screen.getByTestId("ae-triage-gate");
    expect(gate).toHaveTextContent("Split this off?");
    expect(gate).toHaveTextContent("Show which merged pull requests are live on the box");
    expect(gate).toHaveTextContent("The second model also reads this as separate work");
    fireEvent.click(within(gate).getByRole("button", { name: "Save for later" }));
    await screen.findByText("Answered: Save for later");
    expect(mocks.fetch).toHaveBeenCalledWith("/v1/ae/gate/s1/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "C" }),
    });
    setLabels({ "ae.status": "working", "ae.gate": "answered" });
    expect(screen.queryByTestId("ae-triage-gate")).toBeNull();
    expect(within(section).getAllByText("Working").length).toBeGreaterThan(0);
  });

  it("shows a failed answer and brings the buttons back", async () => {
    gateAnswer = () =>
      json(409, { error: { code: "conflict", message: "no open gate on session s1" } });
    show({ "ae.gate": "open", "ae.fork": "Fork" });
    fireEvent.click(screen.getByRole("button", { name: "Drop it" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('Could not send "Drop it": no open gate on session s1.');
    expect(screen.getByRole("button", { name: "Do it now" })).toBeEnabled();
  });

  it("folds open the absorbed lines and shows an empty unfiled row", () => {
    show({ "ae.absorbed": "3", "ae.unfiled": "0" }, [
      said("Absorbed: Tabler icon for the rail button, same file"),
      said("Absorbed: Phone frame for the popover, same mockup"),
    ]);
    const absorbed = screen.getByRole("button", { name: /Absorbed/ });
    expect(absorbed).toHaveTextContent("3");
    expect(screen.queryByText("Phone frame for the popover, same mockup")).toBeNull();
    fireEvent.click(absorbed);
    expect(screen.getByText("Phone frame for the popover, same mockup")).toBeInTheDocument();
    expect(screen.getByText("1 more in older messages not loaded here.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Unfiled/ })).toBeNull();
    expect(screen.getByText("Unfiled")).toBeInTheDocument();
  });

  it("shows Next and links the parked task from the lot", async () => {
    show({ "ae.next": "Say go to build the rail", "ae.task": "t9" });
    expect(screen.getByText("Say go to build the rail")).toBeInTheDocument();
    const link = await screen.findByRole("link", { name: /Show live PRs/ });
    expect(link).toHaveAttribute("href", "https://tasks.example/x");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("says so when the labels have not loaded", () => {
    show(null);
    expect(screen.getByText("This session's labels have not loaded yet.")).toBeInTheDocument();
  });
});
