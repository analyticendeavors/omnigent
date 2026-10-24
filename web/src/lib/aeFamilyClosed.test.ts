import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/hooks/useConversations";

const fetchPage = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useConversations", () => ({ fetchConversationsPage: fetchPage }));

import { aeFamilies } from "./aeFamily";
import {
  aeClosedPill,
  aeClosedTitle,
  aeGroupArchived,
  resetAeFamilyClosedCache,
  toggleAeFamilyClosed,
  useAeFamilyClosed,
} from "./aeFamilyClosed";

function row(id: string, labels: Record<string, string> = {}, extra: Partial<Conversation> = {}) {
  return { id, title: id, updated_at: 0, labels, ...extra } as Conversation;
}

afterEach(() => {
  localStorage.clear();
  resetAeFamilyClosedCache();
  fetchPage.mockReset();
});

describe("aeGroupArchived", () => {
  it("keeps archived rows started by a shown lead", () => {
    const rows = [
      row("a", { "ae.orch": "lead" }, { archived: true }),
      row("b", { "ae.orch": "other" }, { archived: true }),
      row("c", { "ae.orch": "lead" }),
      row("d", { "ae.orch": "1" }, { archived: true }),
    ];
    const out = aeGroupArchived(rows, new Set(["lead"]));
    expect([...out.keys()]).toEqual(["lead"]);
    expect(out.get("lead")!.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("closed summary text", () => {
  const s = { total: 15, open: 3, closed: 12, archived: 9, working: 2, review: 1 };
  it("reads N · M open and the breakdown, leaving out zero parts", () => {
    expect(aeClosedPill(s)).toBe("15 · 3 open");
    expect(aeClosedTitle(s)).toBe(
      "15 sessions: 2 working, 1 done waiting for your read, 12 closed (9 archived)",
    );
    expect(aeClosedTitle({ ...s, review: 0, archived: 0, total: 14 })).toBe(
      "14 sessions: 2 working, 12 closed",
    );
  });
});

describe("useAeFamilyClosed", () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      children,
    );
  const families = aeFamilies(
    [row("lead"), row("kid", { "ae.orch": "lead" })] as Conversation[],
    true,
  );

  it("reads archived rows once for Family grouping and remembers open groups", async () => {
    fetchPage.mockResolvedValue({
      data: [row("old", { "ae.orch": "lead" }, { archived: true })],
    });
    const { result, rerender } = renderHook(({ on }) => useAeFamilyClosed(families, on), {
      wrapper,
      initialProps: { on: false },
    });
    expect(fetchPage).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(result.current.archived.get("lead")?.[0].id).toBe("old"));
    expect(fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: "archived", limit: 200, includeArchived: true }),
    );
    expect(result.current.open.has("lead")).toBe(false);
    act(() => toggleAeFamilyClosed("lead", true));
    expect(result.current.open.has("lead")).toBe(true);
    expect(JSON.parse(localStorage.getItem("omnigent:ae-family-closed-open")!)).toEqual(["lead"]);
    resetAeFamilyClosedCache();
    rerender({ on: true });
    expect(result.current.open.has("lead")).toBe(true);
  });

  it("pages through the archived read and counts a lead's child on page 2", async () => {
    fetchPage
      .mockResolvedValueOnce({
        data: [row("x", { "ae.orch": "elsewhere" }, { archived: true })],
        last_id: "x",
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [row("deep", { "ae.orch": "lead" }, { archived: true })],
        last_id: "deep",
        has_more: false,
      });
    const { result } = renderHook(() => useAeFamilyClosed(families, true), { wrapper });
    await waitFor(() => expect(result.current.archived.get("lead")?.[0].id).toBe("deep"));
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[1][0]).toMatchObject({
      after: "x",
      visibility: "archived",
      limit: 200,
    });
    expect(result.current.capped).toBe(false);
  });

  it("stops at 5 pages and says older archived are not counted", async () => {
    let n = 0;
    fetchPage.mockImplementation(async () => {
      n += 1;
      return { data: [row(`p${n}`, {}, { archived: true })], last_id: `p${n}`, has_more: true };
    });
    const { result } = renderHook(() => useAeFamilyClosed(families, true), { wrapper });
    await waitFor(() => expect(result.current.capped).toBe(true));
    expect(fetchPage).toHaveBeenCalledTimes(5);
  });

  it("passes a search on to the archived read, and reads nothing outside Family grouping", async () => {
    fetchPage.mockResolvedValue({ data: [], last_id: null, has_more: false });
    const off = renderHook(() => useAeFamilyClosed(families, false, "find"), { wrapper });
    expect(fetchPage).not.toHaveBeenCalled();
    off.unmount();
    renderHook(() => useAeFamilyClosed(families, true, "find"), { wrapper });
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());
    expect(fetchPage.mock.calls[0][0]).toMatchObject({
      searchQuery: "find",
      visibility: "archived",
    });
  });

  it("keeps its own cache key, refetches when a listed member leaves, and keeps old data meanwhile", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const shared = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    fetchPage.mockResolvedValueOnce({
      data: [row("old", { "ae.orch": "lead" }, { archived: true })],
      last_id: null,
      has_more: false,
    });
    const three = aeFamilies(
      [
        row("lead"),
        row("kid", { "ae.orch": "lead" }),
        row("kid2", { "ae.orch": "lead" }),
      ] as Conversation[],
      true,
    );
    const { result, rerender } = renderHook(({ f }) => useAeFamilyClosed(f, true), {
      wrapper: shared,
      initialProps: { f: three },
    });
    await waitFor(() => expect(result.current.archived.get("lead")).toHaveLength(1));
    const keys = client
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey);
    expect(keys).toHaveLength(1);
    expect(keys[0][0]).toBe("ae-family-closed-archived");
    // kid2 is archived: it leaves the list, the key changes, and a fetch starts at once.
    let release: (v: unknown) => void = () => {};
    fetchPage.mockReturnValueOnce(
      new Promise((r) => {
        release = r;
      }),
    );
    rerender({ f: families });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(result.current.archived.get("lead")).toHaveLength(1);
    release({
      data: [
        row("old", { "ae.orch": "lead" }, { archived: true }),
        row("kid2", { "ae.orch": "lead" }, { archived: true }),
      ],
      last_id: null,
      has_more: false,
    });
    await waitFor(() => expect(result.current.archived.get("lead")).toHaveLength(2));
  });
});
