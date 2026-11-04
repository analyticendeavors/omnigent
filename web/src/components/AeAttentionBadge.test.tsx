import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/identity", () => ({ authenticatedFetch: fetchMock }));

import { AE_ATTENTION_QUERY_KEY } from "@/lib/aeAttention";
import { AeAttentionBadge } from "./AeAttentionBadge";

function answer(body: unknown, ok = true, status = 200) {
  fetchMock.mockResolvedValue({ ok, status, json: async () => body });
}

function renderBadge(compact = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AeAttentionBadge compact={compact} />
    </QueryClientProvider>,
  );
}

const counts = (urgent: number, review: number) => ({
  sources: ["git", "box"],
  counts: { urgent, review, by_source: { git: { urgent, review } } },
  unknown: [] as string[],
});

beforeEach(() => fetchMock.mockReset());
afterEach(cleanup);

describe("AeAttentionBadge", () => {
  it("draws nothing at zero", async () => {
    answer(counts(0, 0));
    renderBadge();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("ae-attention-pill")).toBeNull();
  });

  it("draws a neutral pill with the review count", async () => {
    answer(counts(0, 17));
    renderBadge();
    const pill = await screen.findByTestId("ae-attention-pill");
    expect(pill.textContent).toBe("17");
    expect(pill.dataset.kind).toBe("review");
    expect(pill.className).not.toContain("bg-destructive");
    expect(pill.className).toContain("ring-1");
    expect(pill.className).toContain("ring-border");
  });

  it("draws a red pill with the urgent count and an aria-label with the split", async () => {
    answer(counts(6, 17));
    renderBadge();
    const pill = await screen.findByTestId("ae-attention-pill");
    expect(pill.textContent).toBe("6");
    expect(pill.dataset.kind).toBe("urgent");
    expect(pill.className).toContain("bg-destructive");
    expect(pill.className).toContain("text-white");
    expect(pill.className).toContain("dark:text-background");
    expect(pill.getAttribute("aria-label")).toBe("6 urgent, 17 to review");
    expect(pill.getAttribute("title")).toBe("6 urgent, 17 to review. Git 23.");
  });

  it("adds the question mark when a source could not be read", async () => {
    answer({ ...counts(6, 17), unknown: ["Git repos could not be read"] });
    renderBadge();
    const pill = await screen.findByTestId("ae-attention-pill");
    expect(pill.textContent).toBe("6 ?");
    expect(pill.getAttribute("aria-label")).toBe(
      "6 urgent, 17 to review, Git repos could not be read",
    );
  });

  it("shows a lone question mark when the route is down, never zero", async () => {
    answer({}, false, 500);
    renderBadge();
    const pill = await screen.findByTestId("ae-attention-pill");
    expect(pill.textContent).toBe("?");
    expect(pill.dataset.kind).toBe("unknown");
  });

  it("shows a lone question mark when a refetch fails after a good read, not the old count", async () => {
    answer(counts(6, 17));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AeAttentionBadge />
      </QueryClientProvider>,
    );
    expect((await screen.findByTestId("ae-attention-pill")).textContent).toBe("6");
    answer({}, false, 500);
    await qc.refetchQueries({ queryKey: AE_ATTENTION_QUERY_KEY });
    await waitFor(() => expect(screen.getByTestId("ae-attention-pill").textContent).toBe("?"));
    answer(counts(2, 0));
    await qc.refetchQueries({ queryKey: AE_ATTENTION_QUERY_KEY });
    await waitFor(() => expect(screen.getByTestId("ae-attention-pill").textContent).toBe("2"));
  });

  it("shows a lone question mark when the answer has no counts", async () => {
    answer({ nope: true });
    renderBadge();
    expect((await screen.findByTestId("ae-attention-pill")).textContent).toBe("?");
  });

  it("has a compact form: a filled dot for something to act on, a ring when unknown", async () => {
    answer(counts(2, 0));
    const first = renderBadge(true);
    const dot = await screen.findByTestId("ae-attention-dot");
    expect(dot.className).toContain("bg-destructive");
    expect(dot.getAttribute("aria-label")).toBe("2 urgent, 0 to review");
    first.unmount();
    answer({ ...counts(0, 0), unknown: ["Box health could not be read"] });
    renderBadge(true);
    const ring = await screen.findByTestId("ae-attention-dot");
    expect(ring.dataset.kind).toBe("unknown");
    expect(ring.className).toContain("bg-transparent");
  });
});
