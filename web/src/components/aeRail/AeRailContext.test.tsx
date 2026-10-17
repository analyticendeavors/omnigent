import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { authenticatedFetch } from "@/lib/identity";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import { useChatStore } from "@/store/chatStore";
import { resetAeContextSnapshots } from "../aeContextUsage";
import { SNAPSHOT } from "../aeRailTestFixtures";
import { AeRailContext } from "./AeRailContext";

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const snapshotNow = () => ({
  ...SNAPSHOT,
  observedAt: new Date(Date.now() - 60_000).toISOString(),
});
const contextCalls = () =>
  vi.mocked(authenticatedFetch).mock.calls.filter(([url]) => String(url).endsWith("/context-usage"))
    .length;

const realCompact = useChatStore.getState().compact;
let sessionCount = 0;
let sessionId = "";

/** Seeds the chat store with a new conversation each time, so no earlier test's entry is reused. */
function setSession(harness: string, extra: Record<string, unknown> = {}) {
  sessionCount += 1;
  sessionId = `conv_${sessionCount}`;
  useChatStore.setState({
    conversationId: sessionId,
    sessionHarness: harness,
    llmModel: "claude-opus-5-5[1m]",
    contextWindow: 1_000_000,
    tokensUsed: 300_000,
    ...extra,
  });
}

beforeEach(() => {
  resetAeContextSnapshots();
  vi.mocked(authenticatedFetch).mockReset();
  vi.mocked(authenticatedFetch).mockImplementation(() => json(snapshotNow()));
  useAeSessionRailStore.setState({ open: true, sheetOpen: false, folded: {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useChatStore.setState({
    compact: realCompact,
    conversationId: null,
    sessionHarness: null,
    llmModel: null,
    contextWindow: null,
    tokensUsed: null,
  });
});

describe("AeRailContext", () => {
  it("shows Claude's snapshot: totals, bar, rows, countdown and the snapshot's age", async () => {
    setSession("claude-native");
    render(<AeRailContext sessionId={sessionId} />);
    await waitFor(() => expect(screen.getByTestId("ae-category-bar")).toBeTruthy());
    const body = screen.getByTestId("ae-rail-context");
    expect(within(body).getByText("50% used")).toBeTruthy();
    expect(within(body).getByText("495.2k / 1M")).toBeTruthy();
    expect(within(body).getAllByTestId("ae-category-row")[0].textContent).toBe(
      "Messages399.7k40.0%",
    );
    expect(screen.getByTestId("ae-rail-countdown").textContent).toBe(
      "About 472k until auto-compact",
    );
    expect(screen.getByText("Estimated snapshot · Opus 5.5 · 1m ago")).toBeTruthy();
    expect(contextCalls()).toBe(1);
    // Folded, the header keeps the percentage.
    fireEvent.click(screen.getByRole("button", { name: "Context" }));
    expect(screen.getByText("50% used")).toBeTruthy();
    expect(screen.queryByTestId("ae-rail-context")).toBeNull();
  });

  it("asks again from the refresh button", async () => {
    setSession("claude-native");
    render(<AeRailContext sessionId={sessionId} />);
    const refresh = await screen.findByRole("button", { name: "Refresh snapshot" });
    await waitFor(() => expect(refresh).not.toBeDisabled());
    fireEvent.click(refresh);
    await waitFor(() => expect(contextCalls()).toBe(2));
  });

  it("fetches nothing while the rail is closed", () => {
    useAeSessionRailStore.setState({ open: false });
    setSession("claude-native");
    render(<AeRailContext sessionId={sessionId} />);
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it("says what failed and retries from Try again", async () => {
    vi.mocked(authenticatedFetch)
      .mockImplementationOnce(() => json({ detail: "down" }, 502))
      .mockImplementation(() => json(snapshotNow()));
    setSession("claude-native");
    render(<AeRailContext sessionId={sessionId} />);
    expect(
      await screen.findByText(/Could not load the context snapshot \(HTTP 502\)/),
    ).toBeTruthy();
    // The live figure still shows while the snapshot is missing.
    expect(screen.getByText("30% used")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("ae-category-bar")).toBeTruthy());
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  it("shows why a runner cannot take a snapshot", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ available: false, reason: "The runner is offline." }),
    );
    setSession("claude-native");
    render(<AeRailContext sessionId={sessionId} />);
    expect(await screen.findByText("The runner is offline.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("gives other harnesses the plain bar and never asks for categories", () => {
    setSession("codex-native", {
      llmModel: "gpt-5.5",
      contextWindow: 400_000,
      tokensUsed: 100_000,
    });
    render(<AeRailContext sessionId={sessionId} />);
    expect(screen.getByText("25% used")).toBeTruthy();
    expect(screen.getByText("100k / 400k")).toBeTruthy();
    expect(
      screen.getByText("A category breakdown is available for Claude Code sessions."),
    ).toBeTruthy();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it("says when there is no reading at all", () => {
    setSession("pi", { contextWindow: null, tokensUsed: null });
    render(<AeRailContext sessionId={sessionId} />);
    expect(screen.getByText(/No reading yet/)).toBeTruthy();
  });
});

describe("Compact session", () => {
  it("asks once, then compacts on the second click", async () => {
    const compact = vi.fn(() => Promise.resolve());
    setSession("claude-native", { compact });
    render(<AeRailContext sessionId={sessionId} />);
    const button = await screen.findByTestId("ae-rail-compact");
    expect(button.textContent).toBe("Compact session");
    fireEvent.click(button);
    expect(button.textContent).toBe("Compact now?");
    expect(compact).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(compact).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(button.textContent).toBe("Compact session"));
  });

  it("drops the confirmation after three seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const compact = vi.fn(() => Promise.resolve());
    setSession("claude-native", { compact });
    render(<AeRailContext sessionId={sessionId} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const button = screen.getByTestId("ae-rail-compact");
    fireEvent.click(button);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(button.textContent).toBe("Compact session");
    fireEvent.click(button);
    expect(compact).not.toHaveBeenCalled();
  });

  it("says what failed when compaction is refused", async () => {
    const compact = vi.fn(() => Promise.reject(new Error("409 Conflict")));
    setSession("claude-native", { compact });
    render(<AeRailContext sessionId={sessionId} />);
    const button = await screen.findByTestId("ae-rail-compact");
    fireEvent.click(button);
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not compact the session (409 Conflict). Try again, or send /compact from the composer.",
    );
  });

  it("reads nothing from the store for a session the composer is not on", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => json(snapshotNow()));
    setSession("claude-native");
    render(<AeRailContext sessionId="conv_other" />);
    // The store's harness belongs to another session: no snapshot probe, no compaction.
    expect(
      await screen.findByText("A category breakdown is available for Claude Code sessions."),
    ).toBeTruthy();
    expect(contextCalls()).toBe(0);
    expect(screen.queryByTestId("ae-rail-compact")).toBeNull();
  });
});
