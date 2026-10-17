import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode, useState } from "react";
import { cleanup, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { authenticatedFetch } from "@/lib/identity";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import { useChatStore } from "@/store/chatStore";
import type { AeLimitsAnswer } from "../AePlanLimits";
import { AeRailUsage, usageSummary } from "./AeRailUsage";

/** A fresh QueryClient per render, retries off, as the app's provider supplies one. */
function QueryWrapper({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: QueryWrapper });

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const LIMITS: AeLimitsAnswer = {
  now: iso(NOW),
  harnesses: {
    claude: {
      harness: "claude",
      source: "statusline+usage",
      observed_at: iso(NOW - 3 * 60_000),
      plan: "Max 20x",
      windows: [
        {
          id: "five_hour",
          label: "5-hour limit",
          used_percent: 0,
          resets_at: iso(NOW + 3 * 3_600_000),
          window_minutes: 300,
        },
        {
          id: "seven_day",
          label: "Weekly, all models",
          used_percent: 100,
          resets_at: iso(NOW + 3 * 86_400_000),
          window_minutes: 10080,
        },
      ],
      note: null,
      credits: {
        enabled: true,
        used_minor: 15613,
        limit_minor: 20000,
        used_percent: 78,
        currency: "USD",
      },
    },
    codex: {
      harness: "codex",
      source: "app-server",
      observed_at: iso(NOW - 4 * 60_000),
      plan: "Pro",
      windows: [
        {
          id: "weekly",
          label: "Weekly limit",
          used_percent: 30,
          resets_at: iso(NOW + 86_400_000),
          window_minutes: 10080,
        },
      ],
      note: null,
    },
  },
};

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  vi.mocked(authenticatedFetch).mockReset();
  vi.mocked(authenticatedFetch).mockImplementation(() => json(LIMITS));
  useAeSessionRailStore.setState({ open: true, sheetOpen: false, folded: {} });
});
afterEach(() => {
  cleanup();
  useChatStore.setState({ sessionHarness: null });
});

describe("usageSummary", () => {
  it("names the fullest window at 80 percent or more, and nothing below", () => {
    expect(usageSummary(LIMITS)).toBe("Weekly 100%");
    const calm: AeLimitsAnswer = { ...LIMITS, harnesses: { codex: LIMITS.harnesses.codex } };
    expect(usageSummary(calm)).toBeNull();
    const fable = {
      ...LIMITS.harnesses.codex!,
      windows: [
        { ...LIMITS.harnesses.codex!.windows[0], label: "Weekly · Fable", used_percent: 84.4 },
      ],
    };
    expect(usageSummary({ ...LIMITS, harnesses: { claude: fable } })).toBe("Weekly Fable 84%");
    expect(usageSummary(undefined)).toBeNull();
  });
});

describe("AeRailUsage", () => {
  it("lists both plans, the session's own first and tagged", async () => {
    useChatStore.setState({ conversationId: "conv_a", sessionHarness: "codex-native" });
    render(<AeRailUsage sessionId="conv_a" />);
    await waitFor(() => expect(screen.getAllByTestId("ae-limits-harness")).toHaveLength(2));
    const [codex, claude] = screen.getAllByTestId("ae-limits-harness");
    expect(codex.getAttribute("data-harness")).toBe("codex");
    expect(within(codex).getByTestId("ae-limits-in-use").textContent).toBe("This session");
    expect(within(codex).getByText("Updated 4m ago")).toBeTruthy();
    expect(within(claude).queryByTestId("ae-limits-in-use")).toBeNull();
    expect(within(claude).getByText("Weekly · all models")).toBeTruthy();
    expect(within(claude).getByText("$156.13 of $200")).toBeTruthy();
    // Narrow rows: the reset without the word "Resets".
    expect(within(claude).getByText(/^in 2h 59m|^in 3h$/)).toBeTruthy();
    expect(screen.getByText("Weekly 100%")).toHaveClass("text-destructive");
  });

  it("tags no plan when the store is on another session", async () => {
    useChatStore.setState({ conversationId: "conv_other", sessionHarness: "codex-native" });
    render(<AeRailUsage sessionId="conv_a" />);
    await waitFor(() => expect(screen.getAllByTestId("ae-limits-harness")).toHaveLength(2));
    expect(screen.getAllByTestId("ae-limits-harness")[0].getAttribute("data-harness")).toBe(
      "claude",
    );
    expect(screen.queryByTestId("ae-limits-in-use")).toBeNull();
  });

  it("says what failed", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => json({}, 502));
    render(<AeRailUsage sessionId="conv_a" />);
    expect(await screen.findByText(/Could not load plan limits \(502/)).toBeTruthy();
  });

  it("asks for limits only while the section is unfolded", () => {
    useAeSessionRailStore.setState({ folded: { usage: true } });
    render(<AeRailUsage sessionId="conv_a" />);
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it("asks for the session's own account and keeps one reading per session", async () => {
    useChatStore.setState({ conversationId: "conv_a", sessionHarness: "claude-native" });
    const backup: AeLimitsAnswer = {
      ...LIMITS,
      harnesses: {
        claude: {
          ...LIMITS.harnesses.claude!,
          plan: null,
          account: "backup",
          account_label: "AE Backup",
        },
      },
    };
    vi.mocked(authenticatedFetch).mockImplementation((input) =>
      json(String(input).includes("session_id=conv%20b") ? backup : LIMITS),
    );
    const view = render(<AeRailUsage sessionId="conv_a" />);
    await waitFor(() => expect(screen.getAllByTestId("ae-limits-harness")).toHaveLength(2));
    expect(screen.queryByTestId("ae-limits-account")).toBeNull();
    expect(vi.mocked(authenticatedFetch).mock.calls.map(([url]) => String(url))).toEqual([
      "/v1/ae/limits?session_id=conv_a",
    ]);
    view.rerender(<AeRailUsage sessionId="conv b" />);
    await waitFor(() =>
      expect(screen.getByTestId("ae-limits-account").textContent).toBe("AE Backup"),
    );
    expect(vi.mocked(authenticatedFetch).mock.calls.map(([url]) => String(url))).toEqual([
      "/v1/ae/limits?session_id=conv_a",
      "/v1/ae/limits?session_id=conv%20b",
    ]);
  });
});
