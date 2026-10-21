import { describe, expect, it } from "vitest";
import type { AeLimitWindow, AeLimitsAnswer } from "@/components/AePlanLimits";
import {
  AE_LIMIT_GATE_PERCENT,
  aeHasOtherClaudeAccount,
  aeHeadlineWindows,
  aeLimitGate,
  aeLimitGateShort,
  AE_LIMIT_GATE_DISMISS_KEEP,
  type AeLimitDismissal,
  aeLimitDismissed,
  aeLimitGateDismiss,
  aeLimitGateText,
} from "./aeLimitGate";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const IN_2H = "2026-10-21T14:00:00Z";
const IN_2D = "2026-10-23T09:00:00Z";
const NEXT_WEEK = "2026-10-30T09:00:00Z";

function win(id: string, used: number, resets: string | null, minutes: number | null) {
  return {
    id,
    label: id,
    used_percent: used,
    resets_at: resets,
    window_minutes: minutes,
  } satisfies AeLimitWindow;
}

const five = (used: number, resets: string | null = IN_2H) => win("five_hour", used, resets, 300);
const week = (used: number, resets: string | null = IN_2D) => win("seven_day", used, resets, 10080);

function answer(
  windows: AeLimitWindow[],
  over: { account?: string | null; account_label?: string | null } = {},
): AeLimitsAnswer {
  return {
    now: new Date(NOW).toISOString(),
    harnesses: {
      claude: {
        harness: "claude",
        source: "statusline",
        observed_at: new Date(NOW).toISOString(),
        plan: null,
        windows,
        note: null,
        ...over,
      },
    },
  };
}

describe("aeLimitGate", () => {
  it("is 90 percent", () => {
    expect(AE_LIMIT_GATE_PERCENT).toBe(90);
  });

  for (const [name, make] of [
    ["5-hour", (used: number) => [five(used), week(10)]],
    ["weekly", (used: number) => [five(10), week(used)]],
  ] as const) {
    it(`${name}: none below 90, a gate at and above it`, () => {
      expect(aeLimitGate(answer(make(89.9)), "claude", NOW)).toBeNull();
      const at = aeLimitGate(answer(make(90)), "claude", NOW);
      expect(at).toMatchObject({ span: name, percent: 90 });
      const above = aeLimitGate(answer(make(97.6)), "claude", NOW);
      expect(above).toMatchObject({ span: name, percent: 98 });
    });
  }

  it("the fullest window wins", () => {
    expect(aeLimitGate(answer([five(95), week(92)]), "claude", NOW)?.span).toBe("5-hour");
    expect(aeLimitGate(answer([five(91), week(96)]), "claude", NOW)?.span).toBe("weekly");
  });

  it("a tie goes to the window that resets later", () => {
    expect(aeLimitGate(answer([five(93), week(93)]), "claude", NOW)?.span).toBe("weekly");
  });

  it("no windows, no answer or no harness gives no gate", () => {
    expect(aeLimitGate(answer([]), "claude", NOW)).toBeNull();
    expect(aeLimitGate(undefined, "claude", NOW)).toBeNull();
    expect(aeLimitGate(answer([five(99)]), null, NOW)).toBeNull();
    expect(aeLimitGate(answer([five(99)]), "codex", NOW)).toBeNull();
  });

  it("ignores per-model weekly rows and a window that already reset", () => {
    const opus = win("seven_day.model.opus", 99, IN_2D, 10080);
    expect(aeLimitGate(answer([five(10), week(10), opus]), "claude", NOW)).toBeNull();
    expect(aeLimitGate(answer([five(99, "2026-10-21T11:00:00Z")]), "claude", NOW)).toBeNull();
  });

  it("picks Codex's windows by length and names the account", () => {
    const codex: AeLimitsAnswer = {
      now: new Date(NOW).toISOString(),
      harnesses: {
        codex: {
          harness: "codex",
          source: "codex",
          observed_at: new Date(NOW).toISOString(),
          plan: null,
          note: null,
          windows: [win("codex.primary", 40, IN_2H, 300), win("codex.secondary", 91, IN_2D, 10080)],
        },
      },
    };
    expect(aeHeadlineWindows(codex.harnesses.codex!.windows).week?.id).toBe("codex.secondary");
    expect(aeLimitGate(codex, "codex", NOW)).toMatchObject({ label: "Codex", span: "weekly" });
  });

  it("labels the account", () => {
    const named = aeLimitGate(
      answer([week(92)], { account: "ae", account_label: "AE Default" }),
      "claude",
      NOW,
    );
    expect(named?.label).toBe("AE Default");
    expect(aeLimitGate(answer([week(92)]), "claude", NOW)?.label).toBe("Default CLI account");
  });

  it("reads like the brief", () => {
    const gate = aeLimitGate(answer([week(92.4)], { account_label: "AE Default" }), "claude", NOW)!;
    expect(aeLimitGateText(gate, NOW, () => "Thu 09:00")).toBe(
      "AE Default is at 92% of its weekly limit, resets Thu 09:00",
    );
    expect(aeLimitGateShort(gate)).toBe("92% weekly");
    const noReset = aeLimitGate(answer([week(92, null)]), "claude", NOW)!;
    expect(aeLimitGateText(noReset, NOW)).toBe("Default CLI account is at 92% of its weekly limit");
  });
});

describe("dismiss", () => {
  const gateOf = (windows: AeLimitWindow[], dismissed: AeLimitDismissal[] = []) =>
    aeLimitGate(answer(windows), "claude", NOW, dismissed);

  it("holds until resets_at changes, then the gate returns", () => {
    const first = gateOf([week(92)])!;
    const dismissed = aeLimitGateDismiss([], first);
    expect(gateOf([week(92)], dismissed)).toBeNull();
    // Later readings of the same window, seconds apart and fuller, across the half hour too.
    expect(gateOf([week(95, "2026-10-23T09:00:07Z")], dismissed)).toBeNull();
    const halfHour = aeLimitGateDismiss([], gateOf([week(92, "2026-10-23T09:29:58Z")])!);
    expect(gateOf([week(93, "2026-10-23T09:30:01Z")], halfHour)).toBeNull();
    // The next window.
    expect(gateOf([week(91, NEXT_WEEK)], dismissed)?.span).toBe("weekly");
  });

  it("a dismissed fuller window does not hide the other one", () => {
    const fiveHour = gateOf([five(95), week(91)])!;
    expect(fiveHour.span).toBe("5-hour");
    const dismissed = aeLimitGateDismiss([], fiveHour);
    expect(gateOf([five(95), week(91)], dismissed)?.span).toBe("weekly");
  });

  it("dismissing one window keeps the other's dismissal", () => {
    let dismissed = aeLimitGateDismiss([], gateOf([five(92), week(20)])!);
    dismissed = aeLimitGateDismiss(dismissed, gateOf([five(92), week(93)], dismissed)!);
    expect(gateOf([five(94), week(93)], dismissed)).toBeNull();
  });

  it("a dismissal is the account's, not another account's", () => {
    const dismissed = aeLimitGateDismiss([], gateOf([week(92)])!);
    const other = aeLimitGate(
      answer([week(92)], { account: "personal" }),
      "claude",
      NOW,
      dismissed,
    );
    expect(other?.account).toBe("personal");
  });

  it("keeps the newest dismissals only, one per window", () => {
    let dismissed: AeLimitDismissal[] = [];
    for (let i = 0; i < AE_LIMIT_GATE_DISMISS_KEEP + 3; i++) {
      const gate = aeLimitGate(answer([week(92)], { account: `a${i}` }), "claude", NOW)!;
      dismissed = aeLimitGateDismiss(dismissed, gate);
    }
    const last = aeLimitGate(answer([week(92)], { account: "a10" }), "claude", NOW)!;
    dismissed = aeLimitGateDismiss(dismissed, last);
    expect(dismissed).toHaveLength(AE_LIMIT_GATE_DISMISS_KEEP);
    expect(dismissed.at(-1)?.window).toBe(last.windowKey);
    expect(dismissed.filter((d) => d.window === last.windowKey)).toHaveLength(1);
    expect(aeLimitDismissed(dismissed, "claude|a0|seven_day", IN_2D)).toBe(false);
  });
});

describe("aeHasOtherClaudeAccount", () => {
  const rows = [
    { family: "claude-oauth-active", env_var: "" },
    { family: "claude-oauth", env_var: "personal" },
  ];

  it("is true when the host has a login other than the session's", () => {
    expect(aeHasOtherClaudeAccount(rows, undefined)).toBe(true);
    expect(aeHasOtherClaudeAccount(rows, "personal")).toBe(true);
  });

  it("is false with one login, or on provider credentials", () => {
    expect(aeHasOtherClaudeAccount([rows[0]!], undefined)).toBe(false);
    expect(aeHasOtherClaudeAccount([rows[0]!], "")).toBe(false);
    expect(aeHasOtherClaudeAccount([...rows, { family: "claude-provider-bedrock" }], "")).toBe(
      false,
    );
    expect(aeHasOtherClaudeAccount([], undefined)).toBe(false);
  });
});
