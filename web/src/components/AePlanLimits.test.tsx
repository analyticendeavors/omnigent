import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { authenticatedFetch } from "@/lib/identity";
import { useChatStore } from "@/store/chatStore";
import { ComposerContextRing } from "@/components/composer/ComposerContextRing";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  type AeLimitsAnswer,
  AePlanLimitsPanel,
  AePlanLimitsPopover,
  formatAgo,
  formatDuration,
  formatMoney,
  formatReset,
  formatTokens,
  limitTone,
} from "./AePlanLimits";
import type { AeSessionContextsState } from "./aeSessionContext";

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
  it("renders bars, reset times, the stamp and a missing harness", () => {
    render(<AePlanLimitsPanel data={ANSWER} now={NOW} />);
    const [claude, codex] = screen.getAllByTestId("ae-limits-harness");
    expect(claude.getAttribute("data-harness")).toBe("claude");
    expect(codex.getAttribute("data-harness")).toBe("codex");
    expect(within(claude).getByText("Updated 4m ago")).toBeTruthy();
    const bars = within(claude).getAllByRole("progressbar");
    expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "5-hour limit: 38% used",
      "Weekly, all models: 92% used",
    ]);
    expect((bars[1].firstChild as HTMLElement).className).toContain("bg-destructive");
    expect(within(claude).getByText(/in 2h\)$/)).toBeTruthy();
    expect(within(claude).getByText("A note from the relay.")).toBeTruthy();
    expect(codex.textContent).toContain("No reading yet");
    expect(codex.textContent).toContain("codex login");
  });

  it("says what to do when Claude has no reading", () => {
    render(<AePlanLimitsPanel data={{ now: iso(NOW), harnesses: {} }} now={NOW} />);
    const [claude] = screen.getAllByTestId("ae-limits-harness");
    expect(claude.textContent).toContain("Send one message in any Claude session");
    expect(claude.textContent).toContain("docs/PLAN-LIMITS.md");
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
      "5-hour limit: 41% used",
      "Weekly, all models: 63% used",
      "Weekly · Fable: 22% used",
      "Usage credits: 20% used",
    ]);
    expect(screen.getByText("216.8k / 1M · 22%")).toBeTruthy();
    expect(screen.getByTestId("ae-limits-plan").textContent).toBe("Max 20x");
    expect(screen.getByText("$78.81 of $400.00")).toBeTruthy();
    const breakdown = screen.getByTestId("ae-context-breakdown");
    expect(breakdown.textContent).toContain("Cached 210k");
    expect(breakdown.textContent).toContain("Cache write 1.8k");
    expect(breakdown.textContent).toContain("New input 5k");
    expect(screen.queryByTestId("ae-limits-hint")).toBeNull();
  });

  it("tones the context bar with the ring's steps, not the plan limit steps", () => {
    const contextBar = (tokensUsed: number) => {
      cleanup();
      render(<AePlanLimitsPanel now={NOW} contextWindow={1_000_000} tokensUsed={tokensUsed} />);
      const bar = within(screen.getByTestId("ae-limits-context")).getByRole("progressbar");
      return (bar.firstChild as HTMLElement).className;
    };
    expect(contextBar(500_000)).toContain("bg-foreground/60");
    // 65% is still grey on a plan limit bar (limitTone warns from 70).
    expect(contextBar(650_000)).toContain("bg-warning");
    expect(contextBar(850_000)).toContain("bg-destructive");
  });

  it("captions the prompt cache bar and gives each part its own colour", () => {
    render(
      <AePlanLimitsPanel data={FULL} now={NOW} conversationId="conv_a" harness="claude-native" />,
    );
    const breakdown = screen.getByTestId("ae-context-breakdown");
    const caption = within(breakdown).getByTestId("ae-context-breakdown-caption");
    expect(caption.textContent).toBe("How those tokens were billed (prompt cache)");
    // The caption sits above the thin bar, so it is read before the bar.
    expect(breakdown.firstElementChild).toBe(caption);
    const dots = Array.from(breakdown.querySelectorAll("span.rounded-full"));
    expect(dots.map((dot) => dot.className.match(/bg-\S+/)?.[0])).toEqual([
      "bg-chart-1",
      "bg-chart-3",
      "bg-chart-5",
    ]);
    // Never the colours the bars use for "nearly full".
    expect(breakdown.innerHTML).not.toMatch(/bg-(warning|destructive)/);
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
      "Claude Code has not reported context usage",
    );
  });

  it("falls back to the session's status line when the ring has no figures", () => {
    render(
      <AePlanLimitsPanel data={FULL} now={NOW} conversationId="conv_a" harness="claude-native" />,
    );
    expect(screen.getByText("216.8k / 1M · 22%")).toBeTruthy();
    expect(screen.getByText("From Claude Code's status line, 2m ago")).toBeTruthy();
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
    expect(planOrder()).toEqual(["codex", "claude"]);
    const inUse = screen.getByTestId("ae-limits-in-use");
    expect(inUse.closest("[data-harness]")?.getAttribute("data-harness")).toBe("codex");
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
      "Codex has not reported context usage for this session yet",
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
    expect(planOrder()).toEqual(["claude", "codex"]);
    expect(
      screen
        .getByTestId("ae-limits-in-use")
        .closest("[data-harness]")
        ?.getAttribute("data-harness"),
    ).toBe("claude");
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
    // Live store figures win over the snapshot for the active row.
    expect(contextLabels()).toEqual([
      "This session context (Codex): 30% used",
      "Review the diff context (Claude Code): 22% used",
      "Write tests context (Pi): 10% used",
    ]);
    const collaborators = screen.getByTestId("ae-context-collaborators");
    const missing = within(collaborators).getAllByTestId("ae-context-unavailable");
    expect(missing.map((row) => row.getAttribute("data-session"))).toEqual([
      "conv_quiet",
      "conv_gone",
    ]);
    expect(missing[1].textContent).toContain("Could not load this session (404 Not Found)");
    expect(collaborators.textContent).toContain("2 more collaborators not shown.");
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
    expect((bar.firstChild as HTMLElement).className).toContain("bg-foreground/25");
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
    expect(planOrder()).toEqual(["codex", "claude"]);
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
    expect(screen.getByText("Usage")).toBeTruthy();
  });

  it("closes on a second click on the ring and on Escape", async () => {
    renderRing();
    const ring = screen.getByTestId("composer-context-ring");
    fireEvent.click(ring);
    await waitFor(() => expect(screen.getByText("Usage")).toBeTruthy());
    fireEvent.pointerDown(ring);
    fireEvent.click(ring);
    await waitFor(() => expect(screen.queryByText("Usage")).toBeNull());
    fireEvent.click(ring);
    await waitFor(() => expect(screen.getByText("Usage")).toBeTruthy());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Usage")).toBeNull());
  });

  it("closes on a press outside, like upstream's other popovers", async () => {
    renderRing();
    fireEvent.click(screen.getByTestId("composer-context-ring"));
    await waitFor(() => expect(screen.getByText("Usage")).toBeTruthy());
    // Radix arms its outside-press listener a tick after the content mounts.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body); // a full press: Radix defers the dismiss to the click
    await waitFor(() => expect(screen.queryByText("Usage")).toBeNull());
  });

  it("closes when the window loses focus (a click in another split pane)", async () => {
    renderRing();
    fireEvent.click(screen.getByTestId("composer-context-ring"));
    await waitFor(() => expect(screen.getByText("Usage")).toBeTruthy());
    fireEvent.blur(window);
    await waitFor(() => expect(screen.queryByText("Usage")).toBeNull());
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
    expect(screen.getByText("12k / 100k · 12%")).toBeTruthy();
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
            busy: false,
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
      screen
        .getByTestId("ae-limits-in-use")
        .closest("[data-harness]")
        ?.getAttribute("data-harness"),
    ).toBe("codex");
    // Closing stops the polling: no request lands after the popover is gone.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Usage")).toBeNull());
    const calls = vi.mocked(authenticatedFetch).mock.calls.length;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(vi.mocked(authenticatedFetch).mock.calls.length).toBe(calls);
  });

  it("ignores clicks anywhere else", () => {
    renderRing();
    fireEvent.click(screen.getByTestId("bar"));
    expect(screen.queryByText("Usage")).toBeNull();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});
