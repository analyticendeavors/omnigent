// Plain-English help for the preset and family settings (omnigent-ae, 2026-10-26).
// One table: every control in Settings > Roles, Settings > Chat > Spend and
// Pin a lead's family, and the controls whose effect is not clear from their label, has an entry here. `tooltip` entries show in an info
// icon placed on a line that already exists; `existing` entries keep the hint
// line the control already had (the text is repeated here so the test can
// check it). The slot cap parameters are described in the policy registry
// (packages/ae_omni_policies registry.py), not here.

export const AE_HINT_MAX = 140;

/** The cost cap on one preset review, as the Settings text shows it. */
export const AE_INSIGHTS_COST_CAP = "$2";

export interface AeSettingHint {
  /** The control as the page labels it. */
  label: string;
  /** What the control does and the effect of each choice, for the info icon. */
  hint: string;
  /** "tooltip": shown by AeHint. "existing": the page already shows this line. */
  source: "tooltip" | "existing";
}

/** The one-line description under "Spend shows" on a desktop window; the hint below is its phone tooltip. */
export const AE_SPEND_SHORT =
  "Tokens (default): new input plus output. Cost: API-rate estimate. Both: each. Off: none.";
/** The one-line description under "Pin a lead's family". */
export const AE_PIN_FAMILY_SHORT =
  "Yes pins a lead's open sessions with it. No (default) pins only the lead.";

const EFFORT = "Effort: low is fastest, max is slowest.";

export const AE_SETTING_HINTS = {
  "roles.presets": {
    label: "Presets",
    hint: "Click a preset to edit it. Your default starts every new session. Pin a preset to keep it in the row.",
    source: "tooltip",
  },
  "roles.lead": {
    label: "Lead",
    hint: `The session you talk to. Session model (default) keeps the chat model. Auto: the lead names its own. ${EFFORT}`,
    source: "tooltip",
  },
  "roles.planner": {
    label: "Planner",
    hint: `Does design and root-cause work. Auto lets the lead choose. ${EFFORT}`,
    source: "tooltip",
  },
  "roles.reviewer": {
    label: "Reviewer",
    hint: "Checks finished work. Up to 3 reviewers, each a Claude or Codex model and effort. Codex is skipped if Helpers is Own subagents only.",
    source: "tooltip",
  },
  "roles.builder": {
    label: "Builder",
    hint: `Writes code. Auto lets the lead choose. ${EFFORT}`,
    source: "tooltip",
  },
  "roles.helper": {
    label: "Helper",
    hint: `Watches, polls and commits. Auto lets the lead choose. ${EFFORT}`,
    source: "tooltip",
  },
  "reviewer.add": {
    label: "Adding reviewers",
    hint: "Adds a reviewer, up to 3. The new one is Codex on its Sol model if ready, else a Claude model not used yet. The x removes one.",
    source: "tooltip",
  },
  "rules.raise_or_lower": {
    label: "Raise a stuck child, or lower the lead",
    hint: "Off: the lead never changes a model or effort. Tell me after (default): it does, then says so. Ask first: it asks you each time.",
    source: "tooltip",
  },
  "rules.lead_steps_down": {
    label: "Lead steps down for mechanical work",
    hint: "On (default): the lead may lower its own model for routine work such as watching CI. Off: it keeps its model.",
    source: "tooltip",
  },
  "rules.auto_raises": {
    label: "Automatic raises per child",
    hint: "Raises per child without asking, 0 to 3 (default 1). Past that, each raise asks you. Ask first ignores it.",
    source: "tooltip",
  },
  "rules.helpers": {
    label: "Helpers",
    hint: "Any agent or session (default): the lead may bring in other agents. Own subagents only: it keeps work in its own subagents.",
    source: "tooltip",
  },
  "rules.review_merge": {
    label: "With more than one reviewer",
    hint: "One merged verdict (default): a single combined report. Each list, then verdict: every reviewer's findings first.",
    source: "tooltip",
  },
  "rules.reviewer_unavailable": {
    label: "A reviewer is offline or not set up",
    hint: "Run the rest, tell me (default): the others run and you are told. Ask me: the lead asks you before the review.",
    source: "tooltip",
  },
  "nudge.update": {
    label: "Update to a newer model",
    hint: "Switches this row to the newer model in the same family and keeps its effort. Undo puts it back. Nothing changes until you click.",
    source: "tooltip",
  },
  "nudge.update_all": {
    label: "Update all",
    hint: "Switches every listed row to its newer model, each keeping its effort. Undo all puts them back. Nothing is saved until you press Save.",
    source: "tooltip",
  },
  "roles.apply_start_on": {
    label: "Apply START ON lines",
    hint: 'When a session\'s first message has a line starting "START ON:", set its preset, or its model and effort, before the first turn.',
    source: "existing",
  },
  "preset.when_to_use": {
    label: "When to use",
    hint: "A sentence the lead reads when a session is set to Lead picks, to choose this preset. Not used for other sessions.",
    source: "tooltip",
  },
  "preset.shortcut": {
    label: "Shortcut",
    hint: "Alt plus the preset's place in the list, for the first 9. Drag a preset in All presets to change its number.",
    source: "tooltip",
  },
  "preset.default": {
    label: "Make my default",
    hint: "Your default preset starts every new session. Only one preset is the default; choosing another replaces it.",
    source: "tooltip",
  },
  "insights.enabled": {
    label: "Collect run logs and review presets",
    hint: "Records each run's preset, roles, models, time, cost, raises, step-downs, hangs and review results. Stored on the server only.",
    source: "existing",
  },
  "insights.show": {
    label: "Presets card shows",
    hint: "Both (default): cost and tokens. Cost: API-rate estimate. Tokens: what a subscription uses up. The card is in Admin Center.",
    source: "tooltip",
  },
  "insights.frequency": {
    label: "How often",
    hint: "Every 2 weeks (default). Monthly runs the first Monday 07:00; Run now mid-month can push the next review out up to 8 weeks.",
    source: "tooltip",
  },
  "insights.reviewer": {
    label: "Reviewer",
    hint: `Default planner, capped at ${AE_INSIGHTS_COST_CAP} per run`,
    source: "existing",
  },
  "insights.scope": {
    label: "Presets it reviews",
    hint: "All (default): starters, yours and every user's presets. Own: starters and your presets only. Only admins can choose.",
    source: "tooltip",
  },
  "insights.run_now": {
    label: "Run now",
    hint: `Starts a review now. It counts as a review (Monthly can slip up to 8 weeks) and is capped at ${AE_INSIGHTS_COST_CAP}.`,
    source: "tooltip",
  },
  "chat.spend_display": {
    label: "Spend shows",
    hint: "Tokens (default): new input plus output, cache reads excluded. Cost: API-rate estimate. Both: each. Off: no spend shown.",
    source: "existing",
  },
  "chat.pin_family": {
    label: "Pin a lead's family",
    hint: "Yes: also pins its open sessions, or none if pin spots run short. No (default): lead only. Unpinning removes all pinned members, closed too.",
    source: "existing",
  },
  "chat.suggestion_keys": {
    label: "Suggestion keys",
    hint: "Next and Previous step through the composer's suggestions when it offers several. Defaults Alt+] and Alt+[. Change records a new combo.",
    source: "tooltip",
  },
  "chat.session_list_reset": {
    label: "Session list",
    hint: "Reset manual order clears your saved order, so sessions list newest first. Undo shows for 8 seconds.",
    source: "tooltip",
  },
} as const satisfies Record<string, AeSettingHint>;

export type AeSettingHintId = keyof typeof AE_SETTING_HINTS;

export function aeHint(id: AeSettingHintId): string {
  return AE_SETTING_HINTS[id].hint;
}
