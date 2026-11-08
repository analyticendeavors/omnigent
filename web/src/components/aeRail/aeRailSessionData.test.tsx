import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { Conversation } from "@/hooks/useConversations";
import { useAeRailSessionLabels, useAeRailSessionRow } from "./aeRailSessionData";

function conversation(id: string, labels: Record<string, string>): Conversation {
  return {
    id,
    object: "conversation",
    title: id,
    created_at: 1,
    updated_at: 1,
    labels,
    permission_level: null,
  };
}

function list(rows: Conversation[]) {
  return {
    pages: [{ data: rows, first_id: null, last_id: null, has_more: false }],
    pageParams: [undefined],
  };
}

function setup() {
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

describe("useAeRailSessionLabels", () => {
  it("repaints when the conversations list changes", () => {
    const { qc, wrapper } = setup();
    qc.setQueryData(["conversations", "", false], list([conversation("a", { k: "1" })]));
    const { result } = renderHook(() => useAeRailSessionLabels("a"), { wrapper });
    expect(result.current).toEqual({ k: "1" });
    act(() => {
      qc.setQueryData(["conversations", "", false], list([conversation("a", { k: "2" })]));
    });
    expect(result.current).toEqual({ k: "2" });
  });

  it("follows the session snapshot, and a new id", () => {
    const { qc, wrapper } = setup();
    const { result, rerender } = renderHook(({ id }) => useAeRailSessionLabels(id), {
      wrapper,
      initialProps: { id: "a" },
    });
    expect(result.current).toBeNull();
    act(() => {
      qc.setQueryData(["session", "a"], { labels: { s: "1" } });
    });
    expect(result.current).toEqual({ s: "1" });
    act(() => {
      qc.setQueryData(["session", "b"], { labels: { s: "b" } });
    });
    expect(result.current).toEqual({ s: "1" });
    rerender({ id: "b" });
    expect(result.current).toEqual({ s: "b" });
  });
});

describe("useAeRailSessionRow", () => {
  it("repaints from the pinned list and the backfill row", () => {
    const { qc, wrapper } = setup();
    const { result } = renderHook(() => useAeRailSessionRow("a"), { wrapper });
    expect(result.current).toBeNull();
    act(() => {
      qc.setQueryData(["pinned-conversations"], { conversations: [conversation("a", { p: "1" })] });
    });
    expect(result.current?.labels).toEqual({ p: "1" });
    act(() => {
      qc.setQueryData(["conversations", "", false], list([conversation("a", { c: "1" })]));
    });
    expect(result.current?.labels).toEqual({ c: "1" });
  });

  it("repaints from the backfill row when nothing else holds the session", () => {
    const { qc, wrapper } = setup();
    const { result } = renderHook(() => useAeRailSessionRow("a"), { wrapper });
    act(() => {
      qc.setQueryData(["conversation-backfill", "a"], conversation("a", { b: "1" }));
    });
    expect(result.current?.labels).toEqual({ b: "1" });
  });
});
