import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/hooks/useConversations";
import { AE_PARKING_LOT_PATH } from "@/lib/aeLabels";
import { AE_SLOT_LIMIT_QUERY_KEY } from "@/lib/aeSlotLimit";
import type { ConversationsInfiniteData } from "@/lib/sessionListCache";
import { AeSlotsPill, readAeSlotCount } from "./AeSlotsPill";

afterEach(cleanup);

function row(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    object: "conversation",
    title: id,
    created_at: 1,
    updated_at: 1,
    labels: { "ae.status": "working" },
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

function renderPill(qc: QueryClient, path = "/") {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AeSlotsPill />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("readAeSlotCount", () => {
  it("counts working, top-level, unarchived rows across every conversations list once", () => {
    const qc = new QueryClient();
    qc.setQueryData(
      ["conversations", "", false],
      pages([row("a"), row("b"), row("sub", { parent_session_id: "a" })]),
    );
    qc.setQueryData(
      ["conversations", "", true],
      pages([
        row("a"),
        row("archived", { archived: true }),
        row("parked", { labels: { "ae.status": "parked" } }),
      ]),
    );
    qc.setQueryData(["project-sessions", "p"], pages([row("folder-only")]));
    expect(readAeSlotCount(qc)).toBe(2);
  });

  it("is zero with nothing cached", () => {
    expect(readAeSlotCount(new QueryClient())).toBe(0);
  });
});

describe("AeSlotsPill", () => {
  it("reads Dashboard n/3 and links to the Dashboard", () => {
    const qc = new QueryClient();
    qc.setQueryData(["conversations", "", false], pages([row("a")]));
    renderPill(qc);
    const link = screen.getByRole("link", { name: "Dashboard 1/3" });
    expect(link).toHaveAttribute("href", AE_PARKING_LOT_PATH);
    expect(screen.getByTestId("ae-slots-count")).toHaveAttribute("data-full", "false");
    expect(screen.getByTestId("ae-slots-count")).not.toHaveClass("text-destructive");
  });

  it("turns red at the limit and stays red past it", () => {
    const qc = new QueryClient();
    qc.setQueryData(["conversations", "", false], pages([row("a"), row("b"), row("c")]));
    renderPill(qc);
    expect(screen.getByRole("link", { name: "Dashboard 3/3" })).toBeInTheDocument();
    expect(screen.getByTestId("ae-slots-count")).toHaveAttribute("data-full", "true");
    expect(screen.getByTestId("ae-slots-count")).toHaveClass("text-destructive");

    act(() => {
      qc.setQueryData(
        ["conversations", "", false],
        pages([row("a"), row("b"), row("c"), row("d")]),
      );
    });
    expect(screen.getByRole("link", { name: "Dashboard 4/3" })).toBeInTheDocument();
    expect(screen.getByTestId("ae-slots-count")).toHaveAttribute("data-full", "true");
  });

  it("counts against the server's limit once it is known", () => {
    const qc = new QueryClient();
    qc.setQueryData(AE_SLOT_LIMIT_QUERY_KEY, 4);
    qc.setQueryData(["conversations", "", false], pages([row("a"), row("b"), row("c")]));
    renderPill(qc);
    expect(screen.getByRole("link", { name: "Dashboard 3/4" })).toBeInTheDocument();
    expect(screen.getByTestId("ae-slots-count")).toHaveAttribute("data-full", "false");

    act(() => {
      qc.setQueryData(
        ["conversations", "", false],
        pages([row("a"), row("b"), row("c"), row("d")]),
      );
    });
    expect(screen.getByRole("link", { name: "Dashboard 4/4" })).toBeInTheDocument();
    expect(screen.getByTestId("ae-slots-count")).toHaveAttribute("data-full", "true");
  });

  it("repaints when the cache changes", () => {
    const qc = new QueryClient();
    renderPill(qc);
    expect(screen.getByRole("link", { name: "Dashboard 0/3" })).toBeInTheDocument();

    act(() => {
      qc.setQueryData(["conversations", "", false], pages([row("a"), row("b")]));
    });
    expect(screen.getByRole("link", { name: "Dashboard 2/3" })).toBeInTheDocument();

    act(() => {
      qc.setQueryData(
        ["conversations", "", false],
        pages([row("a", { labels: { "ae.status": "parked" } })]),
      );
    });
    expect(screen.getByRole("link", { name: "Dashboard 0/3" })).toBeInTheDocument();
  });

  it("is the active row on either Dashboard route and nowhere else", () => {
    const qc = new QueryClient();
    renderPill(qc, "/extensions/analyticendeavors.parking-lot/your-move");
    expect(screen.getByRole("link", { name: "Dashboard 0/3" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    cleanup();
    renderPill(qc, "/c/abc");
    expect(screen.getByRole("link", { name: "Dashboard 0/3" })).not.toHaveAttribute("aria-current");
  });

  it("keeps the installed app's icon badge on the slot count", () => {
    const setAppBadge = vi.fn(async () => undefined);
    const clearAppBadge = vi.fn(async () => undefined);
    Object.assign(navigator, { setAppBadge, clearAppBadge });
    try {
      const qc = new QueryClient();
      qc.setQueryData(["conversations", "", false], pages([row("a"), row("b")]));
      renderPill(qc);
      expect(setAppBadge).toHaveBeenLastCalledWith(2);
      act(() => {
        qc.setQueryData(["conversations", "", false], pages([]));
      });
      expect(clearAppBadge).toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, "setAppBadge");
      Reflect.deleteProperty(navigator, "clearAppBadge");
    }
  });
});
