import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode, useState } from "react";
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { authenticatedFetch } from "@/lib/identity";
import { useChatStore } from "@/store/chatStore";
import { ComposerContextRing } from "@/components/composer/ComposerContextRing";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import { type AeContextSnapshotState, resetAeContextSnapshots } from "./aeContextUsage";
import { SNAPSHOT } from "./aeRailTestFixtures";
import {
  type AeLimitsAnswer,
  AePlanLimitsPanel,
  AePlanLimitsPopover,
  formatAgo,
  formatDuration,
  formatMoney,
  formatMoneyShort,
  formatReset,
  formatResetShort,
  formatTokens,
  limitTone,
  windowLabel,
} from "./AePlanLimits";
import type { AeSessionContextsState } from "./aeSessionContext";

/** A fresh QueryClient per render, retries off, as the app's provider supplies one. */
function QueryWrapper({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: QueryWrapper });

const NOW = Date.parse("2026-09-24T16:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

const ANSWER: AeLimitsAnswer = {
  now: iso(NOW),
  harnesses: {
    claude: {
      harness: "claude",
      source: "statusline",
      observed_at: iso(NOW - 4 * 60_000),
      plan: null,
      windows: [
        {
          id: "five_hour",
          label: "5-hour limit",
          used_percent: 37.5,
          resets_at: iso(NOW + 2 * 3_600_000),
          window_minutes: 300,
        },
        {
          id: "seven_day",
          label: "Weekly, all models",
          used_percent: 92,
          resets_at: iso(NOW + 3 * 86_400_000),
          window_minutes: 10080,
        },
      ],
      note: "A note from the relay.",
    },
    codex: null,
  },
};

const FULL: AeLimitsAnswer = {
  now: iso(NOW),
  harnesses: {
    claude: {
      harness: "claude",
      source: "statusline+usage",
      observed_at: iso(NOW - 60_000),
      plan: "Max 20x",
      windows: [
        {
          id: "five_hour",
          label: "5-hour limit",
          used_percent: 41,
          resets_at: iso(NOW + 2 * 3_600_000),
          window_minutes: 300,
        },
        {
          id: "seven_day",
          label: "Weekly, all models",
          used_percent: 63,
          resets_at: iso(NOW + 3 * 86_400_000),
          window_minutes: 10080,
        },
        {
          id: "seven_day.model.fable",
          label: "Weekly · Fable",
          used_percent: 22,
          resets_at: iso(NOW + 3 * 86_400_000),
          window_minutes: 10080,
        },
      ],
      note: null,
      credits: {
        enabled: true,
        used_minor: 7881,
        limit_minor: 40000,
        used_percent: 19.7,
        currency: "USD",
      },
      contexts: [
        {
          conversation_id: "conv_a",
          observed_at: iso(NOW - 2 * 60_000),
          model: "Fable",
          window_size: 1_000_000,
          used_tokens: 216_800,
          input_tokens: 5_000,
          cache_write_tokens: 1_800,
          cache_read_tokens: 210_000,
        },
      ],
      hint: null,
    },
    codex: null,
  },
};

afterEach(cleanup);

/** A snapshot as `useAeContextSnapshot` hands it to the panel. */
function snapshotState(overrides: Partial<AeContextSnapshotState> = {}): AeContextSnapshotState {
  return { data: SNAPSHOT, loading: false, fresh: true, refresh: () => {}, ...overrides };
}

describe("formatting", () => {
  it("formats durations coarsely", () => {
    expect(formatDuration(30_000)).toBe("<1m");
    expect(formatDuration(5 * 60_000)).toBe("5m");
    expect(formatDuration(2 * 3_600_000 + 10 * 60_000)).toBe("2h 10m");
    expect(formatDuration(3 * 3_600_000)).toBe("3h");
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
  });

  it("says how old a reading is", () => {
    expect(formatAgo(iso(NOW - 10_000), NOW)).toBe("just now");
    expect(formatAgo(iso(NOW - 4 * 60_000), NOW)).toBe("4m ago");
  });

  it("gives the reset as a time and a countdown, or says it passed", () => {
    expect(formatReset(null, NOW)).toBeNull();
    expect(formatReset(iso(NOW + 2 * 3_600_000), NOW)).toMatch(/^Resets .+ \(in 2h\)$/);
    expect(formatReset(iso(NOW - 60_000), NOW)).toBe("Window reset; waiting for a new reading");
  });

  it("words a reset the way a row shows it, short", () => {
    expect(formatResetShort(null, NOW)).toBeNull();
    expect(formatResetShort(iso(NOW + 21 * 60_000), NOW)).toBe("Resets in 21m");
    expect(formatResetShort(iso(NOW + 2 * 3_600_000 + 10 * 60_000), NOW)).toBe("Resets in 2h 10m");
    // A day or more out: the weekday and the clock, no countdown.
    const later = formatResetShort(iso(NOW + 3 * 86_400_000), NOW);
    expect(later).toMatch(/^Resets \S+ \d/);
    expect(later).not.toContain(" in ");
    expect(formatResetShort(iso(NOW - 60_000), NOW)).toBe("Waiting for a new reading");
  });

  it("drops a whole amount's cents, keeps the rest", () => {
    expect(formatMoneyShort(0, "USD")).toBe("$0");
    expect(formatMoneyShort(20000, "USD")).toBe("$200");
    expect(formatMoneyShort(7881, "USD")).toBe("$78.81");
    expect(formatMoneyShort(100, "not-a-currency")).toBe("1.00 not-a-currency");
  });

  it("names the all-models window the way Claude Desktop does", () => {
    const w = { id: "x", used_percent: 1, resets_at: null, window_minutes: null };
    expect(windowLabel({ ...w, label: "Weekly, all models" })).toBe("Weekly · all models");
    expect(windowLabel({ ...w, label: "Weekly · Fable" })).toBe("Weekly · Fable");
    expect(windowLabel({ ...w, label: "5-hour limit" })).toBe("5-hour limit");
  });

  it("prints tokens and money the way the usage popover does", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(216_800)).toBe("216.8k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatMoney(7881, "USD")).toBe("$78.81");
    expect(formatMoney(40000, "USD")).toBe("$400.00");
    expect(formatMoney(500, "JPY")).toContain("500");
    expect(formatMoney(100, "not-a-currency")).toBe("1.00 not-a-currency");
  });

  it("tones bars at 70 and 90", () => {
    expect(limitTone(69)).toBe("normal");
    expect(limitTone(70)).toBe("warning");
    expect(limitTone(90)).toBe("critical");
  });
});

describe("AePlanLimitsPanel", () => {
  it("renders bars, reset times and the stamp for the session's own plan only", () => {
    render(<AePlanLimitsPanel data={ANSWER} now={NOW} />);
    const blocks = screen.getAllByTestId("ae-limits-harness");
    expect(blocks.map((b) => b.getAttribute("data-harness"))).toEqual(["claude"]);
    const [claude] = blocks;
    expect(within(claude).getByText("4m ago")).toBeTruthy();
    const bars = within(claude).getAllByRole("progressbar");
    expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual([
      expect.stringMatching(/^5-hour limit: 38% used\. Resets .+ \(in 2h\)$/),
      expect.stringMatching(/^Weekly · all models: 92% used\. Resets .+ \(in 3d\)$/),
    ]);
    expect(bars[1].querySelector("[data-segment]")?.className).toContain("bg-destructive");
    // The row gives the reset in short; its title keeps the clock time and countdown.
    const [fiveHour] = within(claude).getAllByTestId("ae-limit-window");
    expect(within(fiveHour).getByText("Resets in 2h")).toBeTruthy();
    expect(within(fiveHour).getByText("38%")).toBeTruthy();
    expect(fiveHour.getAttribute("title")).toMatch(/^Resets .+ \(in 2h\)$/);
    expect(within(claude).getByText("A note from the relay.")).toBeTruthy();
    expect(screen.queryByText(/detailed breakdown/)).toBeNull();
  });

  it("says what to do when Codex has no reading", () => {
    render(<AePlanLimitsPanel data={ANSWER} now={NOW} harness="codex-native" />);
    const [codex] = screen.getAllByTestId("ae-limits-harness");
    expect(codex.getAttribute("data-harness")).toBe("codex");
    // One plain line; what to do about it is the tooltip.
    const empty = within(codex).getByTestId("ae-limits-empty");
    expect(empty.textContent).toBe("No reading yet");
    expect(empty.getAttribute("title")).toContain("codex login");
  });

  it("says what to do when Claude has no reading", () => {
    render(<AePlanLimitsPanel data={{ now: iso(NOW), harnesses: {} }} now={NOW} />);
    const [claude] = screen.getAllByTestId("ae-limits-harness");
    const empty = within(claude).getByTestId("ae-limits-empty");
    expect(empty.textContent).toBe("No reading yet");
    expect(empty.getAttribute("title")).toContain("Send one message in any Claude session");
    expect(claude.textContent).not.toContain("docs/PLAN-LIMITS.md");
  });

  it("renders the full Claude panel in the usage popover's order", () => {
    render(
      <AePlanLimitsPanel
        data={FULL}
        now={NOW}
        conversationId="conv_a"
        contextWindow={1_000_000}
        tokensUsed={216_800}
        harness="claude-native"
        model="claude-fable-5-1"
      />,
    );
    const bars = screen.getAllByRole("progressbar");
    expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "This session context (Claude Code): 22% used",
      expect.stringMatching(/^5-hour limit: 41% used\. Resets .+ \(in 2h\)$/),
      expect.stringMatching(/^Weekly · all models: 63% used\. Resets .+ \(in 3d\)$/),
      expect.stringMatching(/^Weekly · Fable: 22% used\. Resets .+ \(in 3d\)$/),
      expect.stringMatching(/^Usage credits: 20% used\. Resets .+$/),
    ]);
    expect(screen.getByTestId("ae-context-value").textContent).toBe("216.8k / 1M (22%)");
    expect(screen.getByTestId("ae-limits-plan").textContent).toBe("Max 20x");
    expect(screen.getByText("$78.81 of $400")).toBeTruthy();
    expect(screen.getByText("Weekly · all models")).toBeTruthy();
    const breakdown = screen.getByTestId("ae-context-breakdown");
    expect(breakdown.textContent).toContain("210k cached");
    expect(breakdown.textContent).toContain("1.8k written");
    expect(breakdown.textContent).toContain("5k new");
    expect(screen.queryByTestId("ae-limits-hint")).toBeNull();
  });

  it("ends with a button that opens the session rail on Context", () => {
    useAeSessionRailStore.setState({ open: false, sheetOpen: false, focus: null });
    const onShowRail = vi.fn();
    render(<AePlanLimitsPanel data={FULL} now={NOW} onShowRail={onShowRail} />);
    const button = screen.getByRole("button", { name: "Show details in session rail" });
    expect(button.querySelector("svg")).toBeTruthy();
    fireEvent.click(button);
    expect(onShowRail).toHaveBeenCalledTimes(1);
    const rail = useAeSessionRailStore.getState();
    expect(rail.open).toBe(true);
    expect(rail.sheetOpen).toBe(false);
    expect(rail.focus?.id).toBe("context");
    expect(rail.folded.context).toBe(false);
  });

  it("draws Claude's categories from a fresh snapshot, with the top three plus Other", () => {
    render(
      <AePlanLimitsPanel
        data={FULL}
        now={Date.parse(SNAPSHOT.observedAt) + 60_000}
        conversationId="conv_a"
        harness="claude-native"
        model="claude-opus-5-5[1m]"
        contextWindow={1_000_000}
        tokensUsed={216_800}
        snapshot={snapshotState()}
      />,
    );
    expect(screen.getByTestId("ae-context-value").textContent).toBe("495.2k / 1M (50%)");
    expect(screen.getByTestId("ae-category-bar")).toBeTruthy();
    expect(screen.queryByTestId("ae-context-breakdown")).toBeNull();
    expect(
      within(screen.getByTestId("ae-category-legend"))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Messages40%", "MCP tools3%", "System tools2%", "Other5%"]);
    expect(screen.getByTestId("ae-context-sub").textContent).toBe(
      "472k until auto-compact · Claude Code · Opus 5.5 · 1m ago",
    );
  });

  it("keeps the prompt cache bar until a snapshot is fresh, and for other harnesses", () => {
    const panel = (harness: string, fresh: boolean) => {
      cleanup();
      render(
        <AePlanLimitsPanel
          data={FULL}
          now={NOW}
          conversationId="conv_a"
          harness={harness}
          contextWindow={1_000_000}
          tokensUsed={216_800}
          snapshot={snapshotState({ fresh })}
        />,
      );
      return Boolean(screen.queryByTestId("ae-category-bar"));
    };
    expect(panel("claude-native", false)).toBe(false);
    expect(screen.getByTestId("ae-context-breakdown")).toBeTruthy();
    expect(panel("codex-native", true)).toBe(false);
    expect(panel("claude-native", true)).toBe(true);
  });

  it("opens and closes each section's explainer with a tap", () => {
    render(
      <AePlanLimitsPanel data={FULL} now={NOW} conversationId="conv_a" harness="claude-native" />,
    );
    const [contextInfo, planInfo] = screen.getAllByTestId("ae-limits-info-toggle");
    const [contextLine, planLine] = screen.getAllByTestId("ae-limits-info");
    expect(contextInfo.getAttribute("aria-label")).toBe("About the context window");
    expect(planInfo.getAttribute("aria-label")).toBe("About plan limits");
    expect(contextLine.hidden).toBe(true);
    expect(contextLine.textContent).toContain("one session's window does not include another's");
    expect(planLine.textContent).toBe("Account-wide; shared by every session on that plan.");
    fireEvent.click(contextInfo);
    expect(contextInfo.getAttribute("aria-expanded")).toBe("true");
    expect(contextLine.hidden).toBe(false);
    expect(planLine.hidden).toBe(true);
    fireEvent.click(contextInfo);
    expect(contextLine.hidden).toBe(true);
  });

  it("keeps the plan explainer open while the limits load, arrive and fail", () => {
    const toggle = () => screen.getByRole("button", { name: "About plan limits" });
    const line = () => within(screen.getByTestId("ae-limits-plans")).getByTestId("ae-limits-info");
    const { rerender } = render(<AePlanLimitsPanel loading now={NOW} />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    fireEvent.click(toggle());
    expect(line().hidden).toBe(false);
    rerender(<AePlanLimitsPanel data={FULL} now={NOW} />);
    expect(screen.getByTestId("ae-limits-plan").textContent).toBe("Max 20x");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(line().hidden).toBe(false);
    rerender(<AePlanLimitsPanel data={FULL} error={new Error("502 Bad Gateway")} now={NOW} />);
    expect(line().hidden).toBe(false);
    fireEvent.click(toggle());
    expect(line().hidden).toBe(true);
  });

  it("tones the context bar with the ring's steps, not the plan limit steps", () => {
    const contextBar = (tokensUsed: number) => {
      cleanup();
      render(<AePlanLimitsPanel now={NOW} contextWindow={1_000_000} tokensUsed={tokensUsed} />);
      const bar = within(screen.getByTestId("ae-limits-context")).getByRole("progressbar");
      return bar.querySelector("[data-segment]")?.className ?? "";
    };
    expect(contextBar(500_000)).toContain("bg-chart-1");
    // 65% is still grey on a plan limit bar (limitTone warns from 70).
    expect(contextBar(650_000)).toContain("bg-warning");
    expect(contextBar(850_000)).toContain("bg-destructive");
  });

  it("puts the ring's tone on the context percentage", () => {
    const percent = (tokensUsed: number) => {
      cleanup();
      render(<AePlanLimitsPanel now={NOW} contextWindow={1_000_000} tokensUsed={tokensUsed} />);
      return screen.getByTestId("ae-context-value").lastElementChild?.className ?? "";
    };
    expect(percent(500_000)).toBe("");
    expect(percent(650_000)).toContain("text-amber-700");
    expect(percent(850_000)).toContain("text-destructive");
  });

  it("joins the prompt cache parts into the context bar, by share of the live figure", () => {
    render(
      <AePlanLimitsPanel
        data={FULL}
        now={NOW}
        conversationId="conv_a"
        harness="claude-native"
        contextWindow={1_000_000}
        tokensUsed={250_000}
      />,
    );
    const bar = within(screen.getByTestId("ae-limits-context")).getByRole("progressbar");
    // The fill is the live figure, not the status line's older 216.8k.
    expect(within(bar).getByTestId("ae-meter-fill").style.width).toBe("25%");
    const segments = Array.from(bar.querySelectorAll<HTMLElement>("[data-segment]"));
    expect(segments.map((s) => s.className.match(/bg-\S+/)?.[0])).toEqual([
      "bg-chart-1",
      "bg-chart-3",
      "bg-chart-5",
    ]);
    // Each part's share of the breakdown (210k, 1.8k and 5k of 216.8k), never its count.
    const shares = segments.map((s) => Number(s.style.flexGrow));
    expect(shares[0]).toBeCloseTo(210_000 / 216_800, 5);
    expect(shares[1]).toBeCloseTo(1_800 / 216_800, 5);
    expect(shares[2]).toBeCloseTo(5_000 / 216_800, 5);
    // The legend is the key: the same colours, never the "nearly full" ones.
    const legend = screen.getByTestId("ae-context-breakdown");
    const dots = Array.from(legend.querySelectorAll("span.rounded-full"));
    expect(dots.map((dot) => dot.className.match(/bg-\S+/)?.[0])).toEqual([
      "bg-chart-1",
      "bg-chart-3",
      "bg-chart-5",
    ]);
    expect(legend.getAttribute("title")).toContain("How those tokens were billed (prompt cache)");
    expect(legend.innerHTML).not.toMatch(/bg-(warning|destructive)/);
  });

  it("draws a nearly full context as one toned fill, as the ring does", () => {
    render(
      <AePlanLimitsPanel
        data={FULL}
        now={NOW}
        conversationId="conv_a"
        harness="claude-native"
        contextWindow={1_000_000}
        tokensUsed={850_000}
      />,
    );
    const bar = within(screen.getByTestId("ae-limits-context")).getByRole("progressbar");
    const segments = Array.from(bar.querySelectorAll<HTMLElement>("[data-segment]"));
    expect(segments).toHaveLength(1);
    expect(segments[0].className).toContain("bg-destructive");
    // The legend still names the parts, but drops the dots no red fill matches (2026-10-14).
    const legend = screen.getByTestId("ae-context-breakdown");
    expect(legend.textContent).toContain("210k cached");
    expect(legend.querySelector("span.rounded-full")).toBeNull();
  });

  it("keys the legend with dots at a normal tone and drops them at the warning tone", () => {
    const legendAt = (tokensUsed: number) => {
      cleanup();
      render(
        <AePlanLimitsPanel
          data={FULL}
          now={NOW}
          conversationId="conv_a"
          harness="claude-native"
          contextWindow={1_000_000}
          tokensUsed={tokensUsed}
        />,
      );
      const legend = screen.getByTestId("ae-context-breakdown");
      return {
        dots: legend.querySelectorAll("span.rounded-full").length,
        parts: Array.from(legend.children).map((part) => part.textContent),
      };
    };
    const parts = ["210k cached", "1.8k written", "5k new"];
    expect(legendAt(500_000)).toEqual({ dots: 3, parts });
    // 65%: the bar is one amber fill, so the legend keeps only its words (2026-10-14).
    expect(legendAt(650_000)).toEqual({ dots: 0, parts });
  });

  it("shows another session's breakdown only for that session", () => {
    render(
      <AePlanLimitsPanel
        data={FULL}
        now={NOW}
        conversationId="conv_other"
        harness="claude-native"
      />,
    );
    expect(screen.queryByTestId("ae-context-breakdown")).toBeNull();
    // No live ring figures and no capture for this session: unavailable, never a 0% bar.
    const context = screen.getByTestId("ae-limits-context");
    expect(within(context).queryByRole("progressbar")).toBeNull();
    expect(within(context).getByTestId("ae-context-unavailable").textContent).toContain(
      "No reading yet; it appears after the session's next reply.",
    );
  });

  it("falls back to the session's status line when the ring has no figures", () => {
    render(
      <AePlanLimitsPanel data={FULL} now={NOW} conversationId="conv_a" harness="claude-native" />,
    );
    expect(screen.getByTestId("ae-context-value").textContent).toBe("216.8k / 1M (22%)");
    expect(screen.getByText("from Claude Code's status line, 2m ago")).toBeTruthy();
  });

  it("shows the hint when the login lacks the profile scope, and credits turned off", () => {
    const claude = FULL.harnesses.claude!;
    const data: AeLimitsAnswer = {
      now: iso(NOW),
      harnesses: {
        claude: {
          ...claude,
          plan: null,
          windows: claude.windows.slice(0, 2),
          credits: { ...claude.credits!, enabled: false },
          hint: "Per-model weekly limits need a login.",
        },
      },
    };
    render(<AePlanLimitsPanel data={data} now={NOW} />);
    expect(screen.getByTestId("ae-limits-hint").textContent).toBe(
      "Per-model weekly limits need a login.",
    );
    expect(screen.getByTestId("ae-limit-credits").textContent).toBe("Usage creditsOff");
    expect(screen.queryByTestId("ae-limits-plan")).toBeNull();
  });

  it("says what failed", () => {
    render(<AePlanLimitsPanel error={new Error("404 Not Found")} now={NOW} />);
    expect(screen.getByText(/Could not load plan limits \(404 Not Found\)/)).toBeTruthy();
  });
});

describe("AePlanLimitsPanel session contexts", () => {
  // FULL's status line for conv_a, plus Claude limits and a Codex weekly window.
  const WITH_CODEX: AeLimitsAnswer = {
    now: iso(NOW),
    harnesses: {
      claude: FULL.harnesses.claude,
      codex: {
        harness: "codex",
        source: "app-server",
        observed_at: iso(NOW - 60_000),
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
  const contextLabels = () =>
    within(screen.getByTestId("ae-limits-context"))
      .queryAllByRole("progressbar")
      .map((bar) => bar.getAttribute("aria-label"));
  const planOrder = () =>
    screen.getAllByTestId("ae-limits-harness").map((block) => block.getAttribute("data-harness"));

  it("labels a Codex session's context and puts the Codex plan first", () => {
    render(
      <AePlanLimitsPanel
        data={WITH_CODEX}
        now={NOW}
        conversationId="conv_codex"
        harness="codex-native"
        model="gpt-5.5"
        contextWindow={400_000}
        tokensUsed={120_000}
      />,
    );
    expect(contextLabels()).toEqual(["This session context (Codex): 30% used"]);
    const active = screen.getByTestId("ae-context-active");
    expect(within(active).getByTestId("ae-usage-who").textContent).toBe("Codex · gpt-5.5");
    expect(planOrder()).toEqual(["codex"]);
    // Only one plan is listed, so it needs no "This session" tag.
    expect(screen.queryByTestId("ae-limits-in-use")).toBeNull();
    // Context and plan limits are separate sections.
    expect(
      within(screen.getByTestId("ae-limits-plans")).queryByText(/This session context/),
    ).toBeNull();
  });

  it("never shows a Claude status line for a Codex session, even on the same id", () => {
    render(
      <AePlanLimitsPanel
        data={WITH_CODEX}
        now={NOW}
        conversationId="conv_a"
        harness="codex-native"
      />,
    );
    expect(contextLabels()).toEqual([]);
    expect(screen.queryByTestId("ae-context-breakdown")).toBeNull();
    expect(screen.getByTestId("ae-context-unavailable").textContent).toContain(
      "No reading yet; it appears after the session's next reply.",
    );
  });

  it("labels a Claude Code session and keeps its cache breakdown", () => {
    render(
      <AePlanLimitsPanel
        data={WITH_CODEX}
        now={NOW}
        conversationId="conv_a"
        harness="claude-native"
        model="claude-fable-5-1"
        contextWindow={1_000_000}
        tokensUsed={216_800}
      />,
    );
    expect(contextLabels()).toEqual(["This session context (Claude Code): 22% used"]);
    expect(screen.getByTestId("ae-context-breakdown")).toBeTruthy();
    expect(planOrder()).toEqual(["claude"]);
  });

  it("gives each collaborator its own row and never sums them", () => {
    const sessions: AeSessionContextsState = {
      self: {
        harness: "codex-native",
        llmModel: "gpt-5.5",
        contextWindow: 400_000,
        lastTotalTokens: 80_000,
      },
      collaborators: [
        {
          id: "conv_a",
          name: "Review the diff",
          // A Claude Code child with no snapshot figures: its status line speaks for it.
          snapshot: {
            harness: "claude-native",
            llmModel: null,
            contextWindow: null,
            lastTotalTokens: null,
          },
        },
        {
          id: "conv_pi",
          name: "Write tests",
          snapshot: {
            harness: "pi",
            llmModel: "gemini-3-pro",
            contextWindow: 1_000_000,
            lastTotalTokens: 100_000,
          },
        },
        {
          id: "conv_quiet",
          name: "Draft docs",
          snapshot: {
            harness: "codex-native",
            llmModel: null,
            contextWindow: null,
            lastTotalTokens: null,
          },
        },
        { id: "conv_gone", name: "Lost child", snapshot: null, error: "404 Not Found" },
      ],
      hidden: 2,
    };
    render(
      <AePlanLimitsPanel
        data={WITH_CODEX}
        now={NOW}
        conversationId="conv_codex"
        harness="codex-native"
        model="gpt-5.5"
        contextWindow={400_000}
        tokensUsed={120_000}
        sessions={sessions}
      />,
    );
    // Live store figures win over the snapshot for the active row; each
    // running collaborator is a lane under it with its own window.
    const collaborators = screen.getByTestId("ae-context-collaborators");
    expect(
      within(collaborators)
        .getAllByRole("progressbar")
        .map((bar) => bar.getAttribute("aria-label")),
    ).toEqual([
      "Review the diff context (Claude Code): 22% used",
      "Write tests context (Pi): 10% used",
    ]);
    const lanes = within(collaborators).getAllByTestId("ae-context-lane");
    expect(lanes.map((lane) => lane.textContent)).toEqual([
      "Review the diff · Claude Code22%",
      "Write tests · Pi10%",
      "Draft docs · Codex-",
      "Lost child-",
    ]);
    // A lane without a reading says why in its tooltip.
    expect(lanes[3].getAttribute("title")).toContain("Could not load this session (404 Not Found)");
    // No row reads a combined total of the windows above.
    expect(screen.queryByText(/2\.4M|336\.8k/)).toBeNull();
  });

  it("marks an old status line as possibly out of date", () => {
    render(
      <AePlanLimitsPanel
        data={FULL}
        now={NOW + 3 * 3_600_000}
        conversationId="conv_a"
        harness="claude-native"
      />,
    );
    expect(screen.getByText(/status line, 3h 2m ago \(may be out of date\)$/)).toBeTruthy();
    const bar = within(screen.getByTestId("ae-limits-context")).getByRole("progressbar");
    expect(bar.querySelector("[data-segment]")?.className).toContain("bg-foreground/25");
  });

  it("drops the legend dots on a stale reading at a normal tone", () => {
    render(
      <AePlanLimitsPanel
        data={FULL}
        now={NOW + 3 * 3_600_000}
        conversationId="conv_a"
        harness="claude-native"
      />,
    );
    // 22% is a normal tone, but a stale bar is one grey fill (2026-10-14).
    expect(screen.getByTestId("ae-context-value").textContent).toBe("216.8k / 1M (22%)");
    const legend = screen.getByTestId("ae-context-breakdown");
    expect(legend.querySelector("span.rounded-full")).toBeNull();
    expect(Array.from(legend.children).map((part) => part.textContent)).toEqual([
      "210k cached",
      "1.8k written",
      "5k new",
    ]);
  });

  it("counts down to auto-compact on a 1M Claude Code window and names the model", () => {
    const { rerender } = render(
      <AePlanLimitsPanel
        data={WITH_CODEX}
        now={NOW}
        conversationId="conv_a"
        harness="claude-native"
        model="claude-opus-5-5[1m]"
        contextWindow={1_000_000}
        tokensUsed={443_100}
      />,
    );
    const left = screen.getByTestId("ae-context-autocompact");
    expect(left.textContent).toBe("524k until auto-compact");
    expect(left.getAttribute("title")).toContain("967k");
    expect(screen.getByTestId("ae-usage-who").textContent).toBe("Claude Code · Opus 5.5");
    // A 200k window has no documented compaction point to count down to.
    rerender(
      <AePlanLimitsPanel
        data={WITH_CODEX}
        now={NOW}
        conversationId="conv_a"
        harness="claude-native"
        model="claude-sonnet-4-5"
        contextWindow={200_000}
        tokensUsed={90_000}
      />,
    );
    expect(screen.queryByTestId("ae-context-autocompact")).toBeNull();
  });

  it("says unavailable before the session exists rather than showing zero", () => {
    render(<AePlanLimitsPanel data={WITH_CODEX} now={NOW} harness="codex-native" />);
    expect(contextLabels()).toEqual([]);
    expect(screen.getByTestId("ae-context-unavailable").textContent).toContain(
      "No session yet; the reading appears after the first reply.",
    );
  });

  it("trusts the session snapshot when the store still holds the previous agent", () => {
    // The agent moved from Claude Code to Codex; the store has not rebound yet.
    render(
      <AePlanLimitsPanel
        data={WITH_CODEX}
        now={NOW}
        conversationId="conv_a"
        harness="claude-native"
        model="claude-fable-5-1"
        contextWindow={1_000_000}
        tokensUsed={216_800}
        sessions={{
          self: {
            harness: "codex-native",
            llmModel: "gpt-5.5",
            contextWindow: null,
            lastTotalTokens: null,
          },
          collaborators: [],
        }}
      />,
    );
    expect(contextLabels()).toEqual([]);
    expect(screen.queryByTestId("ae-context-breakdown")).toBeNull();
    const active = screen.getByTestId("ae-context-active");
    expect(within(active).getByTestId("ae-usage-who").textContent).toBe("Codex · gpt-5.5");
    expect(planOrder()).toEqual(["codex"]);
  });

  it("leaves finished agents out of the lanes and counts Claude Code's subagents", () => {
    render(
      <AePlanLimitsPanel
        data={FULL}
        now={NOW}
        conversationId="conv_a"
        harness="claude-native"
        sessions={{
          collaborators: [
            {
              id: "conv_done",
              name: "Old review",
              running: false,
              snapshot: {
                harness: "pi",
                llmModel: "gemini-3-pro",
                contextWindow: 1_000_000,
                lastTotalTokens: 100_000,
              },
            },
          ],
          subagents: 3,
        }}
      />,
    );
    expect(screen.queryAllByTestId("ae-context-lane")).toEqual([]);
    expect(screen.getByTestId("ae-context-subagents").textContent).toBe(
      "+ 3 Claude Code subagents running (no reading)",
    );
  });

  it("says how many agents past the cap are not shown", () => {
    render(
      <AePlanLimitsPanel
        now={NOW}
        conversationId="conv_a"
        harness="claude-native"
        sessions={{ collaborators: [], hidden: 2 }}
      />,
    );
    expect(screen.getByTestId("ae-context-hidden").textContent).toBe("+ 2 more agents not shown");
  });
});

/** Answers the popover's requests by path: limits, session snapshots, child lists. */
function routeFetch(
  limits: AeLimitsAnswer,
  sessions: Record<string, Record<string, unknown>> = {},
  children: Record<string, Record<string, unknown>[]> = {},
) {
  vi.mocked(authenticatedFetch).mockImplementation((input) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (url === "/v1/ae/limits") return json(limits);
    const childList = url.match(/^\/v1\/sessions\/([^/?]+)\/child_sessions$/);
    if (childList) return json({ object: "list", data: children[childList[1]] ?? [] });
    const snapshot = url.match(/^\/v1\/sessions\/([^/?]+)\?/);
    const wire = snapshot ? sessions[snapshot[1]] : undefined;
    if (wire) return json({ agent_id: "agent", status: "idle", created_at: 0, ...wire });
    return json({ detail: "not found" }, 404);
  });
}

describe("AePlanLimitsPopover", () => {
  beforeEach(() => {
    resetAeContextSnapshots();
    vi.mocked(authenticatedFetch).mockReset();
    routeFetch(ANSWER);
  });

  afterEach(() => {
    useChatStore.setState({
      conversationId: null,
      contextWindow: null,
      tokensUsed: null,
      sessionHarness: null,
      llmModel: null,
    });
  });

  // Upstream's ring, unchanged, with the popover mounted beside it the way
  // ChatPage.tsx mounts it: a renamed ring test id fails here.
  function renderRing() {
    return render(
      <TooltipProvider>
        <div data-testid="bar" className="flex gap-1">
          <ComposerContextRing contextWindow={100_000} tokensUsed={12_000} />
          <AePlanLimitsPopover />
        </div>
      </TooltipProvider>,
    );
  }

  it("adds no element beside the ring and fetches only when opened", async () => {
    renderRing();
    const ring = screen.getByTestId("composer-context-ring");
    expect(ring.parentElement).toBe(screen.getByTestId("bar"));
    expect(screen.getByTestId("bar").children).toHaveLength(1);
    expect(authenticatedFetch).not.toHaveBeenCalled();
    fireEvent.click(ring);
    await waitFor(() => expect(screen.getAllByRole("progressbar")).toHaveLength(2));
    expect(authenticatedFetch).toHaveBeenCalledWith("/v1/ae/limits", { method: "GET" });
    expect(screen.getByTestId("ae-plan-limits")).toBeTruthy();
  });

  it("closes on a second click on the ring and on Escape", async () => {
    renderRing();
    const ring = screen.getByTestId("composer-context-ring");
    fireEvent.click(ring);
    await waitFor(() => expect(screen.getByTestId("ae-plan-limits")).toBeTruthy());
    fireEvent.pointerDown(ring);
    fireEvent.click(ring);
    await waitFor(() => expect(screen.queryByTestId("ae-plan-limits")).toBeNull());
    fireEvent.click(ring);
    await waitFor(() => expect(screen.getByTestId("ae-plan-limits")).toBeTruthy());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("ae-plan-limits")).toBeNull());
  });

  it("closes on a press outside, like upstream's other popovers", async () => {
    renderRing();
    fireEvent.click(screen.getByTestId("composer-context-ring"));
    await waitFor(() => expect(screen.getByTestId("ae-plan-limits")).toBeTruthy());
    // Radix arms its outside-press listener a tick after the content mounts.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body); // a full press: Radix defers the dismiss to the click
    await waitFor(() => expect(screen.queryByTestId("ae-plan-limits")).toBeNull());
  });

  it("closes when the window loses focus (a click in another split pane)", async () => {
    renderRing();
    fireEvent.click(screen.getByTestId("composer-context-ring"));
    await waitFor(() => expect(screen.getByTestId("ae-plan-limits")).toBeTruthy());
    fireEvent.blur(window);
    await waitFor(() => expect(screen.queryByTestId("ae-plan-limits")).toBeNull());
  });

  it("shows this session's context from the chat store", async () => {
    routeFetch(FULL, { conv_a: { id: "conv_a", harness: "claude-native" } });
    useChatStore.setState({
      conversationId: "conv_a",
      contextWindow: 100_000,
      tokensUsed: 12_000,
      sessionHarness: "claude-native",
    });
    renderRing();
    fireEvent.click(screen.getByTestId("composer-context-ring"));
    await waitFor(() => expect(screen.getByTestId("ae-context-breakdown")).toBeTruthy());
    expect(screen.getByTestId("ae-context-value").textContent).toBe("12k / 100k (12%)");
    expect(screen.getByRole("dialog", { name: "Usage" })).toBeTruthy();
  });

  it("lists collaborators' own windows only while open", async () => {
    routeFetch(
      ANSWER,
      {
        conv_codex: { id: "conv_codex", harness: "codex-native", llm_model: "gpt-5.5" },
        conv_kid: {
          id: "conv_kid",
          harness: "claude-native",
          llm_model: "claude-fable-5-1",
          context_window: 1_000_000,
          last_total_tokens: 50_000,
        },
      },
      {
        conv_codex: [
          {
            id: "conv_kid",
            title: "claude_code:review",
            task_summary: "Review the diff",
            tool: null,
            session_name: null,
            current_task_status: null,
            busy: true,
          },
        ],
      },
    );
    useChatStore.setState({
      conversationId: "conv_codex",
      contextWindow: 400_000,
      tokensUsed: 100_000,
      sessionHarness: "codex-native",
      llmModel: "gpt-5.5",
    });
    renderRing();
    expect(authenticatedFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("composer-context-ring"));
    await waitFor(() => expect(screen.getByTestId("ae-context-collaborators")).toBeTruthy());
    const context = screen.getByTestId("ae-limits-context");
    expect(
      within(context)
        .getAllByRole("progressbar")
        .map((bar) => bar.getAttribute("aria-label")),
    ).toEqual([
      "This session context (Codex): 25% used",
      "Review the diff context (Claude Code): 5% used",
    ]);
    expect(
      screen.getAllByTestId("ae-limits-harness").map((b) => b.getAttribute("data-harness")),
    ).toEqual(["codex"]);
    // A Codex session never asks for Claude's category snapshot.
    expect(
      vi
        .mocked(authenticatedFetch)
        .mock.calls.some(([url]) => String(url).endsWith("/context-usage")),
    ).toBe(false);
    // Closing stops the polling: no request lands after the popover is gone.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("ae-plan-limits")).toBeNull());
    const calls = vi.mocked(authenticatedFetch).mock.calls.length;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(vi.mocked(authenticatedFetch).mock.calls.length).toBe(calls);
  });

  it("loads Claude's category snapshot on open and keeps the cache bar until it arrives", async () => {
    let resolve!: (response: Response) => void;
    routeFetch(FULL, { conv_a: { id: "conv_a", harness: "claude-native" } });
    const route = vi.mocked(authenticatedFetch).getMockImplementation()!;
    vi.mocked(authenticatedFetch).mockImplementation((input, init) =>
      String(input) === "/v1/sessions/conv_a/context-usage"
        ? new Promise<Response>((r) => {
            resolve = r;
          })
        : route(input, init),
    );
    useChatStore.setState({
      conversationId: "conv_a",
      contextWindow: 1_000_000,
      tokensUsed: 216_800,
      sessionHarness: "claude-native",
    });
    renderRing();
    fireEvent.click(screen.getByTestId("composer-context-ring"));
    await waitFor(() => expect(screen.getByTestId("ae-context-breakdown")).toBeTruthy());
    expect(screen.queryByTestId("ae-category-bar")).toBeNull();
    resolve(new Response(JSON.stringify({ ...SNAPSHOT, observedAt: new Date().toISOString() })));
    await waitFor(() => expect(screen.getByTestId("ae-category-bar")).toBeTruthy());
    expect(screen.getByTestId("ae-context-value").textContent).toBe("495.2k / 1M (50%)");
  });

  it("closes and opens the rail on Context from its bottom button", async () => {
    useAeSessionRailStore.setState({ open: false, sheetOpen: false, focus: null });
    renderRing();
    fireEvent.click(screen.getByTestId("composer-context-ring"));
    fireEvent.click(await screen.findByRole("button", { name: "Show details in session rail" }));
    await waitFor(() => expect(screen.queryByTestId("ae-plan-limits")).toBeNull());
    expect(useAeSessionRailStore.getState()).toMatchObject({
      open: true,
      focus: { id: "context" },
    });
  });

  it("ignores clicks anywhere else", () => {
    renderRing();
    fireEvent.click(screen.getByTestId("bar"));
    expect(screen.queryByTestId("ae-plan-limits")).toBeNull();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});
