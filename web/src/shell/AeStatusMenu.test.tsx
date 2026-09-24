// Tests for the sidebar's Status submenu (omnigent-ae patch P4): the five
// items with the stored status checked, the labels PATCH, the slot check
// before Working (server answer first, the sidebar cache when the route
// cannot answer), the error toasts, and the cache overlay.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Conversation } from "@/hooks/useConversations";
import type { ConversationsInfiniteData } from "@/lib/sessionListCache";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  isMobile: false,
}));

vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));
vi.mock("@/components/ui/toast", () => ({ showToast: mocks.toast }));
vi.mock("@/hooks/useIsMobileViewport", () => ({ useIsMobileViewport: () => mocks.isMobile }));

import {
  AE_STATUS_HINTS,
  type AeMenuComponents,
  AeStatusMenu,
  applyAeStatus,
  checkAeSlotRoom,
  overlayAeStatusIntoCaches,
} from "./AeStatusMenu";

function conv(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    object: "conversation",
    title: id,
    created_at: 1,
    updated_at: 1,
    labels: {},
    permission_level: null,
    ...extra,
  };
}

function pages(rows: Conversation[]): ConversationsInfiniteData {
  return {
    pages: [
      {
        data: rows,
        first_id: rows[0]?.id ?? null,
        last_id: rows.at(-1)?.id ?? null,
        has_more: false,
      },
    ],
    pageParams: [undefined],
  };
}

function json(status: number, body: unknown, statusText = ""): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

/** Route the mocked fetch: the capacity GET and the labels PATCH. */
function serve({
  capacity = json(404, { detail: "Not Found" }, "Not Found"),
  patch = json(200, {}),
}: { capacity?: Response | Error; patch?: Response } = {}) {
  mocks.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/v1/ae/capacity") {
      if (capacity instanceof Error) throw capacity;
      return capacity;
    }
    if (init?.method === "PATCH") return patch;
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  });
}

function patchCalls() {
  return mocks.fetch.mock.calls.filter(([, init]) => init?.method === "PATCH");
}

const openSub = ({ children }: { children?: ReactNode }) => (
  <DropdownMenuSub open>{children}</DropdownMenuSub>
);

const bundle: AeMenuComponents = {
  Item: DropdownMenuItem,
  Sub: openSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

function renderMenu(conversation: Conversation, qc = new QueryClient(), onDone = vi.fn()) {
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <DropdownMenu open>
          <DropdownMenuTrigger>menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <AeStatusMenu components={bundle} conversation={conversation} onDone={onDone} />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { qc, onDone };
}

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.toast.mockReset();
  mocks.isMobile = false;
});
afterEach(cleanup);

describe("AeStatusMenu", () => {
  it("offers a Status submenu with the five values and the stored one checked", () => {
    renderMenu(conv("s1", { labels: { "ae.status": "review" } }));
    expect(screen.getByTestId("ae-status-menu")).toHaveTextContent("Status");
    const items = screen.getAllByTestId("ae-status-item");
    expect(items.map((item) => item.textContent)).toEqual([
      "Working",
      "Blocked",
      "Review",
      "Parked",
      "Reference",
    ]);
    expect(items.map((item) => item.getAttribute("role"))).toEqual(Array(5).fill("menuitemradio"));
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
      "false",
      "false",
    ]);
  });

  it("checks nothing for a session without a status", () => {
    renderMenu(conv("s1"));
    const checked = screen
      .getAllByTestId("ae-status-item")
      .filter((item) => item.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(0);
  });

  it("renders the items inline under a heading on mobile", () => {
    mocks.isMobile = true;
    renderMenu(conv("s1", { labels: { "ae.status": "parked" } }));
    expect(screen.queryByTestId("ae-status-menu")).toBeNull();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getAllByTestId("ae-status-item")).toHaveLength(5);
  });

  it("writes the label through the session PATCH and paints the row", async () => {
    serve();
    const qc = new QueryClient();
    qc.setQueryData(["conversations", "", false], pages([conv("s1")]));
    const { onDone } = renderMenu(conv("s1"), qc);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Parked/ }));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    const [path, init] = patchCalls()[0];
    expect(path).toBe("/v1/sessions/s1");
    expect(JSON.parse(init.body as string)).toEqual({ labels: { "ae.status": "parked" } });
    expect(onDone).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        qc.getQueryData<ConversationsInfiniteData>(["conversations", "", false])?.pages[0].data[0]
          .labels,
      ).toEqual({ "ae.status": "parked" }),
    );
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("says in the Parked hint that it files nothing to the task-store", () => {
    expect(AE_STATUS_HINTS.parked).toMatch(/Label only/);
    expect(AE_STATUS_HINTS.parked).toMatch(/nothing is filed to the task-store/);
    expect(AE_STATUS_HINTS.review).toMatch(/Done/);
  });
});

describe("applyAeStatus", () => {
  it("does nothing when the session already holds the status", async () => {
    serve();
    const wrote = await applyAeStatus(
      new QueryClient(),
      conv("s1", { labels: { "ae.status": "parked" } }),
      "parked",
    );
    expect(wrote).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("refuses Working when the server says every slot is taken", async () => {
    serve({
      capacity: json(200, {
        limit: 3,
        slots_used: 3,
        working: [
          { id: "a", title: "Alpha" },
          { id: "b", title: "Beta" },
          { id: "c", title: "Gamma" },
        ],
      }),
    });
    const wrote = await applyAeStatus(
      new QueryClient(),
      conv("s1", { labels: { "ae.status": "parked" } }),
      "working",
    );
    expect(wrote).toBe(false);
    expect(patchCalls()).toHaveLength(0);
    const message = mocks.toast.mock.calls[0][0] as string;
    expect(message).toContain("all 3 slots are working (Alpha, Beta, Gamma)");
    expect(message).toContain("ride unparked");
    expect(message).not.toContain("sidebar");
  });

  it("writes Working when the server has a free slot", async () => {
    serve({
      capacity: json(200, { limit: 3, slots_used: 2, working: [{ id: "a" }, { id: "b" }] }),
    });
    const wrote = await applyAeStatus(new QueryClient(), conv("s1"), "working");
    expect(wrote).toBe(true);
    expect(JSON.parse(patchCalls()[0][1].body as string)).toEqual({
      labels: { "ae.status": "working" },
    });
  });

  it("falls back to the sidebar's count when the capacity route cannot answer", async () => {
    serve({ capacity: new TypeError("Failed to fetch") });
    const qc = new QueryClient();
    const working = { "ae.status": "working" };
    qc.setQueryData(
      ["conversations", "", false],
      pages([
        conv("a", { labels: working }),
        conv("b", { labels: working }),
        conv("c", { labels: working }),
        conv("s1"),
      ]),
    );
    expect(await applyAeStatus(qc, conv("s1"), "working")).toBe(false);
    expect(mocks.toast.mock.calls[0][0]).toContain("by the sidebar's count");
    expect(patchCalls()).toHaveLength(0);
  });

  it("does not count archived or sub-agent rows in the fallback", async () => {
    serve();
    const qc = new QueryClient();
    const working = { "ae.status": "working" };
    qc.setQueryData(
      ["conversations", "", false],
      pages([
        conv("a", { labels: working }),
        conv("b", { labels: working }),
        conv("c", { labels: working, archived: true }),
        conv("d", { labels: working, parent_session_id: "a" }),
      ]),
    );
    expect(await checkAeSlotRoom(qc, "s1")).toEqual({ ok: true });
  });

  it("surfaces the server's refusal of the PATCH and leaves the cache alone", async () => {
    serve({ patch: json(403, { detail: "Only the owner can edit labels" }, "Forbidden") });
    const qc = new QueryClient();
    qc.setQueryData(["conversations", "", false], pages([conv("s1")]));
    expect(await applyAeStatus(qc, conv("s1"), "review")).toBe(false);
    const message = mocks.toast.mock.calls[0][0] as string;
    expect(message).toContain("Could not set the status to Review");
    expect(message).toContain("403 Forbidden: Only the owner can edit labels");
    expect(
      qc.getQueryData<ConversationsInfiniteData>(["conversations", "", false])?.pages[0].data[0]
        .labels,
    ).toEqual({});
  });
});

describe("overlayAeStatusIntoCaches", () => {
  it("paints every cached copy of the row and keeps its other labels", () => {
    const qc = new QueryClient();
    const row = conv("s1", { labels: { "ae.status": "working", "ae.next": "ship it" } });
    const other = conv("s2", { labels: { "ae.status": "working" } });
    qc.setQueryData(["conversations", "", false], pages([row, other]));
    qc.setQueryData(["project-sessions", "Sprint"], pages([row]));
    qc.setQueryData(["pinned-conversations"], { conversations: [row], filterHonored: true });
    qc.setQueryData(["conversation-backfill", "s1"], row);

    overlayAeStatusIntoCaches(qc, "s1", "parked");

    const expected = { "ae.status": "parked", "ae.next": "ship it" };
    const flat = qc.getQueryData<ConversationsInfiniteData>(["conversations", "", false]);
    expect(flat?.pages[0].data[0].labels).toEqual(expected);
    expect(flat?.pages[0].data[1].labels).toEqual({ "ae.status": "working" });
    expect(
      qc.getQueryData<ConversationsInfiniteData>(["project-sessions", "Sprint"])?.pages[0].data[0]
        .labels,
    ).toEqual(expected);
    expect(
      qc.getQueryData<{ conversations: Conversation[] }>(["pinned-conversations"])?.conversations[0]
        .labels,
    ).toEqual(expected);
    expect(qc.getQueryData<Conversation>(["conversation-backfill", "s1"])?.labels).toEqual(
      expected,
    );
  });

  it("leaves a cache without the row untouched", () => {
    const qc = new QueryClient();
    const data = pages([conv("s2")]);
    qc.setQueryData(["conversations", "", false], data);
    overlayAeStatusIntoCaches(qc, "s1", "parked");
    expect(qc.getQueryData(["conversations", "", false])).toBe(data);
  });
});
