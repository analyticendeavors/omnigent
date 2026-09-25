import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { Conversation } from "@/hooks/useConversations";
import { AE_PARKING_LOT_PATH } from "@/lib/aeLabels";
import { AE_SLOT_LIMIT_QUERY_KEY } from "@/lib/aeSlotLimit";
import type { ConversationsInfiniteData } from "@/lib/sessionListCache";
import { AeSessionChip, readAeSessionStatus } from "./AeSessionChip";

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

function renderChip(qc: QueryClient, id: string) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AeSessionChip conversationId={id} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("readAeSessionStatus", () => {
  it("finds the row in any conversations list and derives blocked", () => {
    const qc = new QueryClient();
    qc.setQueryData(
      ["conversations", "", true],
      pages([row("w", { pending_elicitations_count: 1 })]),
    );
    expect(readAeSessionStatus(qc, "w")).toBe("blocked");
    expect(readAeSessionStatus(qc, "missing")).toBeNull();
  });
});

describe("AeSessionChip", () => {
  it("shows the session's status and the slot count, and opens the Dashboard", () => {
    const qc = new QueryClient();
    qc.setQueryData(
      ["conversations", "", false],
      pages([row("a"), row("p", { labels: { "ae.status": "parked" } })]),
    );
    renderChip(qc, "p");
    const chip = screen.getByTestId("ae-session-chip");
    expect(chip).toHaveAccessibleName("Parked; slots 1 of 3; open the Dashboard");
    expect(chip).toHaveAttribute("href", AE_PARKING_LOT_PATH);
    expect(chip).toHaveTextContent("1/3");
    expect(chip).toHaveAttribute("data-full", "false");
  });

  it("turns red at the limit and shows the count alone for an unknown session", () => {
    const qc = new QueryClient();
    renderChip(qc, "elsewhere");
    expect(screen.getByTestId("ae-session-chip")).toHaveAccessibleName(
      "slots 0 of 3; open the Dashboard",
    );
    act(() => {
      qc.setQueryData(["conversations", "", false], pages([row("a"), row("b"), row("c")]));
    });
    const chip = screen.getByTestId("ae-session-chip");
    expect(chip).toHaveTextContent("3/3");
    expect(chip).toHaveAttribute("data-full", "true");
    expect(chip).toHaveClass("text-destructive");
  });

  it("counts against the server's limit once it is known", () => {
    const qc = new QueryClient();
    qc.setQueryData(AE_SLOT_LIMIT_QUERY_KEY, 4);
    qc.setQueryData(["conversations", "", false], pages([row("a"), row("b"), row("c")]));
    renderChip(qc, "a");
    const chip = screen.getByTestId("ae-session-chip");
    expect(chip).toHaveAccessibleName("Working; slots 3 of 4; open the Dashboard");
    expect(chip).toHaveTextContent("3/4");
    expect(chip).toHaveAttribute("data-full", "false");
  });
});
