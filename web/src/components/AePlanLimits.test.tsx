import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { authenticatedFetch } from "@/lib/identity";
import { ComposerContextRing } from "@/components/composer/ComposerContextRing";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  type AeLimitsAnswer,
  AePlanLimitsPanel,
  AePlanLimitsPopover,
  formatAgo,
  formatDuration,
  formatReset,
  limitTone,
} from "./AePlanLimits";

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
  });

  it("says what failed", () => {
    render(<AePlanLimitsPanel error={new Error("404 Not Found")} now={NOW} />);
    expect(screen.getByText(/Could not load plan limits \(404 Not Found\)/)).toBeTruthy();
  });
});

describe("AePlanLimitsPopover", () => {
  beforeEach(() => {
    vi.mocked(authenticatedFetch).mockReset();
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(ANSWER), { status: 200 })),
    );
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
    expect(screen.getByText("Plan limits")).toBeTruthy();
  });

  it("closes on a second click on the ring and on Escape", async () => {
    renderRing();
    const ring = screen.getByTestId("composer-context-ring");
    fireEvent.click(ring);
    await waitFor(() => expect(screen.getByText("Plan limits")).toBeTruthy());
    fireEvent.pointerDown(ring);
    fireEvent.click(ring);
    await waitFor(() => expect(screen.queryByText("Plan limits")).toBeNull());
    fireEvent.click(ring);
    await waitFor(() => expect(screen.getByText("Plan limits")).toBeTruthy());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Plan limits")).toBeNull());
  });

  it("ignores clicks anywhere else", () => {
    renderRing();
    fireEvent.click(screen.getByTestId("bar"));
    expect(screen.queryByText("Plan limits")).toBeNull();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});
