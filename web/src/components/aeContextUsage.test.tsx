import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/identity";
import { useContextUsage } from "./aeContextUsage";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));
beforeEach(() => vi.mocked(authenticatedFetch).mockReset());
describe("on-demand context", () => {
  it("fetches only when expanded and discards replies from another session", async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(authenticatedFetch).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { result, rerender } = renderHook(
      ({ session, open }) => useContextUsage(session, open, "claude"),
      { initialProps: { session: "first", open: false } },
    );
    expect(authenticatedFetch).not.toHaveBeenCalled();
    rerender({ session: "first", open: true });
    expect(authenticatedFetch).toHaveBeenCalledWith("/v1/sessions/first/context-usage");
    rerender({ session: "second", open: false });
    await act(async () => {
      resolve(new Response(JSON.stringify({ available: true })));
    });
    expect(result.current.data).toBeUndefined();
  });
  it("clears the displayed snapshot when folded", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(JSON.stringify({ available: true })),
    );
    const { result, rerender } = renderHook(
      ({ open }) => useContextUsage("session", open, "claude"),
      { initialProps: { open: true } },
    );
    await waitFor(() => expect(result.current.data?.available).toBe(true));
    rerender({ open: false });
    expect(result.current.data).toBeUndefined();
  });
  it("reports errors and retries when reopened", async () => {
    vi.mocked(authenticatedFetch)
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ available: false, reason: "Offline" })));
    const { result, rerender } = renderHook(
      ({ open }) => useContextUsage("session", open, "claude"),
      { initialProps: { open: true } },
    );
    await waitFor(() => expect(result.current.error).toMatch(/Could not load/));
    rerender({ open: false });
    rerender({ open: true });
    await waitFor(() => expect(result.current.data?.reason).toBe("Offline"));
  });
});
