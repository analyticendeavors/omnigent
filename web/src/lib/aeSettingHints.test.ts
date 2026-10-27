import { describe, expect, it } from "vitest";
import {
  AE_HINT_MAX,
  AE_INSIGHTS_COST_CAP,
  AE_PIN_FAMILY_SHORT,
  AE_SETTING_HINTS,
  AE_SPEND_SHORT,
  type AeSettingHint,
} from "./aeSettingHints";

const entries = Object.entries(AE_SETTING_HINTS) as [string, AeSettingHint][];
const BANNED =
  /leverage|seamless|powerful|robust|utiliz|furthermore|additionally|game-changing|deep dive|circle back|synergy|—|–|--|Reid|Analytic|Havens|Steve|[\u{1F300}-\u{1FAFF}]/iu;

/** Hints for a control with more than one choice: each names its default. */
const CHOICES = [
  "roles.lead",
  "rules.raise_or_lower",
  "rules.lead_steps_down",
  "rules.auto_raises",
  "rules.helpers",
  "rules.review_merge",
  "rules.reviewer_unavailable",
  "insights.show",
  "insights.frequency",
  "insights.scope",
  "chat.spend_display",
  "chat.pin_family",
  "family.child_prompts",
  "family.relay",
] as const;

describe("the setting hints", () => {
  it("gives every entry a label and a hint", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, entry] of entries) {
      expect(entry.label.trim(), id).not.toBe("");
      expect(entry.hint.trim(), id).not.toBe("");
    }
  });

  it("keeps every hint, existing ones too, within the length limit, in plain words", () => {
    for (const [id, entry] of entries) {
      expect(entry.hint.length, id).toBeLessThanOrEqual(AE_HINT_MAX);
      expect(entry.hint, id).not.toMatch(BANNED);
    }
    for (const text of [AE_SPEND_SHORT, AE_PIN_FAMILY_SHORT]) {
      expect(text.length).toBeLessThanOrEqual(AE_HINT_MAX);
      expect(text).not.toMatch(BANNED);
    }
  });

  it("names the default in every hint with a choice", () => {
    for (const id of CHOICES) expect(AE_SETTING_HINTS[id].hint, id).toMatch(/default/i);
  });

  it("states the real defaults", () => {
    expect(AE_SETTING_HINTS["rules.raise_or_lower"].hint).toContain("Tell me after (default)");
    expect(AE_SETTING_HINTS["rules.helpers"].hint).toContain("Any agent or session (default)");
    expect(AE_SETTING_HINTS["rules.review_merge"].hint).toContain("One merged verdict (default)");
    expect(AE_SETTING_HINTS["rules.reviewer_unavailable"].hint).toContain(
      "Run the rest, tell me (default)",
    );
    expect(AE_SETTING_HINTS["insights.show"].hint).toContain("Both (default)");
    expect(AE_SETTING_HINTS["insights.frequency"].hint).toContain("Every 2 weeks (default)");
    expect(AE_SETTING_HINTS["insights.scope"].hint).toContain("All (default)");
  });

  it("takes the review cost cap from the shared constant", () => {
    expect(AE_SETTING_HINTS["insights.run_now"].hint).toContain(AE_INSIGHTS_COST_CAP);
    expect(AE_SETTING_HINTS["insights.reviewer"].hint).toContain(AE_INSIGHTS_COST_CAP);
  });
});

describe("the Older models hint", () => {
  it("says what the fold holds and that the current model's group opens by itself", () => {
    const { hint } = AE_SETTING_HINTS["reviewer.older"];
    expect(hint).toMatch(/opens on its own/);
    expect(hint.length).toBeLessThanOrEqual(AE_HINT_MAX);
  });
});
