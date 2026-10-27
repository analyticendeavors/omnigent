// Reviewers per preset (omnigent-ae, 2026-10-24): the Reviewer role holds one
// to three reviewers. Each slot is a Claude model and effort (a native
// subagent), Auto (slot 1 only) or another agent run as a child session. The
// server (ae_omni_policies role_prefs.py) stores one Claude reviewer as the
// plain role setting and anything else as {"mode": "multi", "reviewers": [...]}.
// This file parses, lists, writes back and summarizes that value.

import type { Host } from "@/hooks/useHosts";
import {
  AE_AGENT_EFFORTS,
  AE_ROLE_EFFORTS,
  type AeAgentEffort,
  type AeRoleEffort,
  type AeRoleSetting,
  aeModelLabel,
} from "@/lib/aeRoleBase";
import { nativeCodingAgentForHarness } from "@/lib/nativeCodingAgents";
import type { AeTeamOption } from "@/lib/aeTeamOptions";

export const AE_REVIEWERS_MAX = 3;
export const AE_AGENT_NAME_MAX = 40;
/** The built-in Codex agent's id: sha256("builtin:codex-native-ui"), first 32 hex. */
export const AE_CODEX_AGENT_ID = "16a06503889b0c3034496821afd41b9e";
/**
 * Its registered name. An install seeded before the id scheme keeps a random id for
 * this row, so a slot also stores the name and the live id is found by it.
 */
export const AE_CODEX_AGENT_NAME = "codex-native-ui";
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface AeReviewerAgentSlot {
  mode: "agent";
  agent: string;
  /** The agent's registered name ("codex-native-ui"); the live id is found by it when set. */
  agent_name?: string | null;
  /** The agent's display name when it was picked (aeTeamAgentName). */
  name: string;
  /** Null: the agent's default model. */
  model: string | null;
  /** Null: the agent's default effort. */
  effort: AeAgentEffort | null;
}

export type AeReviewerSlot =
  { mode: "auto" } | { mode: "fixed"; model: string; effort: AeRoleEffort } | AeReviewerAgentSlot;

export interface AeReviewerMulti {
  mode: "multi";
  reviewers: AeReviewerSlot[];
}

/** What `roles.reviewer` holds: the plain role setting (one reviewer) or the multi shape. */
export type AeReviewerSetting = AeRoleSetting | AeReviewerMulti;

export const AE_REVIEW_MERGES = ["merged", "separate"] as const;
export type AeReviewMerge = (typeof AE_REVIEW_MERGES)[number];
export const AE_REVIEWER_UNAVAILABLE = ["run_rest", "ask"] as const;
export type AeReviewerUnavailable = (typeof AE_REVIEWER_UNAVAILABLE)[number];

export const AE_REVIEW_MERGE_OPTIONS: { value: AeReviewMerge; label: string }[] = [
  { value: "merged", label: "One merged verdict" },
  { value: "separate", label: "Each list, then verdict" },
];
export const AE_REVIEWER_UNAVAILABLE_OPTIONS: { value: AeReviewerUnavailable; label: string }[] = [
  { value: "run_rest", label: "Run the rest, tell me" },
  { value: "ask", label: "Ask me" },
];

/** The merge rule of a preset or customization; absent reads as "merged". */
export function aeReviewMergeOf(rules: { review_merge?: AeReviewMerge } | undefined) {
  return rules?.review_merge === "separate" ? "separate" : "merged";
}
/** The unavailable-reviewer rule; absent reads as "run_rest". */
export function aeReviewerUnavailableOf(
  rules: { reviewer_unavailable?: AeReviewerUnavailable } | undefined,
) {
  return rules?.reviewer_unavailable === "ask" ? "ask" : "run_rest";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEffort(value: unknown): value is AeRoleEffort {
  return (AE_ROLE_EFFORTS as readonly unknown[]).includes(value);
}

function isAgentEffort(value: unknown): value is AeAgentEffort {
  return (AE_AGENT_EFFORTS as readonly unknown[]).includes(value);
}

function parseSlot(value: unknown, index: number): AeReviewerSlot | null {
  if (!isObject(value)) return null;
  if (value.mode === "auto") return index === 0 ? { mode: "auto" } : null;
  if (value.mode === "fixed") {
    if (typeof value.model !== "string" || !value.model || !isEffort(value.effort)) return null;
    return { mode: "fixed", model: value.model, effort: value.effort };
  }
  if (value.mode === "agent") return aeParseAgentSlot(value);
  return null;
}

/** An agent slot (the reviewer's, or a Codex planner, builder or helper), or null when malformed. */
export function aeParseAgentSlot(value: unknown): AeReviewerAgentSlot | null {
  if (!isObject(value) || value.mode !== "agent") return null;
  const { agent, name, model, effort, agent_name: agentName } = value;
  if (typeof agent !== "string" || !agent) return null;
  if (agentName != null && (typeof agentName !== "string" || !AGENT_NAME_PATTERN.test(agentName)))
    return null;
  if (typeof name !== "string" || !name || Array.from(name).length > AE_AGENT_NAME_MAX) return null;
  if (model != null && (typeof model !== "string" || !model)) return null;
  if (effort != null && !isAgentEffort(effort)) return null;
  return {
    mode: "agent",
    agent,
    agent_name: typeof agentName === "string" ? agentName : null,
    name,
    model: typeof model === "string" ? model : null,
    effort: isAgentEffort(effort) ? effort : null,
  };
}

/** The multi shape, or null when `value` is not a well-formed one (1 to 3 slots). */
export function aeParseReviewerMulti(value: unknown): AeReviewerMulti | null {
  if (!isObject(value) || value.mode !== "multi" || !Array.isArray(value.reviewers)) return null;
  const list = value.reviewers;
  if (list.length < 1 || list.length > AE_REVIEWERS_MAX) return null;
  const reviewers = list.map(parseSlot);
  return reviewers.every((slot): slot is AeReviewerSlot => slot !== null)
    ? { mode: "multi", reviewers }
    : null;
}

/** The reviewers as a list of 1 to 3 slots. A plain "session" setting reads as Auto. */
export function aeReviewerList(setting: AeReviewerSetting): AeReviewerSlot[] {
  if (setting.mode === "multi") return setting.reviewers.slice(0, AE_REVIEWERS_MAX);
  if (setting.mode === "session") return [{ mode: "auto" }];
  return [setting];
}

/**
 * The compact value to store: one Claude (or Auto) reviewer stays the plain
 * role setting, so presets saved before multi reviewers keep their shape; two
 * or three reviewers, or one agent reviewer, use the multi shape. Auto past
 * slot 1 and slots past 3 are dropped.
 */
export function aeWriteReviewers(slots: readonly AeReviewerSlot[]): AeReviewerSetting {
  const kept = slots
    .filter((slot, i) => slot.mode !== "auto" || i === 0)
    .slice(0, AE_REVIEWERS_MAX);
  if (kept.length === 0) return { mode: "auto" };
  if (kept.length === 1 && kept[0].mode !== "agent") return kept[0];
  return { mode: "multi", reviewers: kept };
}

/** "Reviewer" with one slot, "Reviewers" with two or three. */
export function aeReviewerRowLabel(setting: AeReviewerSetting): string {
  return aeReviewerList(setting).length > 1 ? "Reviewers" : "Reviewer";
}

function slotSummary(slot: AeReviewerSlot): string {
  if (slot.mode === "fixed") return `${aeModelLabel(slot.model)} ${slot.effort}`;
  if (slot.mode === "agent") return slot.name;
  return "auto";
}

/** "Sonnet 5.5 medium + Codex". */
export function aeReviewerSummary(setting: AeReviewerSetting): string {
  return aeReviewerList(setting).map(slotSummary).join(" + ");
}

/** The agent slots, each with its 1-based reviewer number. */
export function aeReviewerAgents(
  setting: AeReviewerSetting,
): { slot: AeReviewerAgentSlot; number: number }[] {
  return aeReviewerList(setting).flatMap((slot, i) =>
    slot.mode === "agent" ? [{ slot, number: i + 1 }] : [],
  );
}

/** Whether an agent reviewer can run on `host`: ready, offline, needs setup, or not listed. */
export type AeReviewerAgentStatus = "ready" | "offline" | "setup" | "missing";

export function aeReviewerAgentStatus(
  slot: Pick<AeReviewerAgentSlot, "agent" | "agent_name">,
  options: readonly AeTeamOption[],
  host: Pick<Host, "status"> | null,
): { status: AeReviewerAgentStatus; option: AeTeamOption | null } {
  const option = aeReviewerAgentOption(slot, options);
  if (!host || host.status !== "online") return { status: "offline", option };
  if (!option) return { status: "missing", option };
  if (option.readiness.selectable) return { status: "ready", option };
  return { status: option.readiness.state === "setup-required" ? "setup" : "offline", option };
}

/** Whether an agent is the Codex one: by its built-in id or name, else by its harness. */
export function aeIsCodexAgent(agent: { id: string; name: string; harness?: string | null }) {
  return (
    agent.id === AE_CODEX_AGENT_ID ||
    agent.name === AE_CODEX_AGENT_NAME ||
    nativeCodingAgentForHarness(agent.harness)?.key === "codex"
  );
}

/** Whether a stored agent slot runs on Codex; `option` is the listed agent it names, when found. */
export function aeIsCodexSlot(
  slot: Pick<AeReviewerAgentSlot, "agent" | "agent_name">,
  option: AeTeamOption | null,
): boolean {
  return option
    ? aeIsCodexAgent(option.agent)
    : slot.agent === AE_CODEX_AGENT_ID || slot.agent_name === AE_CODEX_AGENT_NAME;
}

/** The registered name to store on a slot, or null when it is not one the server accepts. */
export function aeAgentNameOf(name: string): string | null {
  return AGENT_NAME_PATTERN.test(name) ? name : null;
}

/** The option a slot names: by id, else by registered name (an install seeded under another id). */
export function aeReviewerAgentOption(
  slot: Pick<AeReviewerAgentSlot, "agent" | "agent_name">,
  options: readonly AeTeamOption[],
): AeTeamOption | null {
  return (
    options.find((o) => o.agent.id === slot.agent) ??
    (slot.agent_name ? options.find((o) => o.agent.name === slot.agent_name) : undefined) ??
    null
  );
}

/** Whether an agent (as the sessions list shows it) is the one a slot names. */
export function aeReviewerSlotIs(
  slot: Pick<AeReviewerAgentSlot, "agent" | "agent_name">,
  agent: { id: string; name: string },
): boolean {
  return slot.agent === agent.id || (!!slot.agent_name && slot.agent_name === agent.name);
}

/**
 * The efforts an agent slot can offer for its harness (the web twin of
 * efforts_for_harness in omnigent/util/reasoning_effort.py, cut to the efforts a
 * preset stores). `modelLevels` are the levels the chosen model lists, when the
 * harness reports them per model (Codex and Devin).
 */
export function aeAgentEfforts(
  harness: string | null | undefined,
  modelLevels: readonly string[] = [],
): AeAgentEffort[] {
  const key = nativeCodingAgentForHarness(harness)?.key;
  const name = (harness ?? "").toLowerCase();
  let levels: readonly AeAgentEffort[] = AE_ROLE_EFFORTS;
  if (key === "antigravity" || name.includes("gemini")) levels = ["low", "medium", "high"];
  else if (name.includes("copilot")) levels = ["low", "medium", "high", "xhigh"];
  if ((key === "codex" || key === "devin") && modelLevels.length > 0) {
    const pool = key === "codex" ? AE_AGENT_EFFORTS : levels;
    const listed = pool.filter((e) => modelLevels.includes(e));
    if (listed.length > 0) return listed;
  }
  return [...levels];
}

/** The settings route that sets up an agent's harness. */
export function aeAgentSetupHref(harness: string | null | undefined): string {
  return harness ? `/settings/harnesses/${encodeURIComponent(harness)}` : "/settings/harnesses";
}

interface ReviewRules {
  helpers?: "any" | "own";
  review_merge?: AeReviewMerge;
  reviewer_unavailable?: AeReviewerUnavailable;
}

/**
 * The "Reviews" card in "Who works on this?": null with fewer than two
 * reviewers. Amber (warning) when an agent reviewer cannot run on the host
 * now; while agents load, every agent counts as ready.
 */
export function aeReviewsCard(
  shown: { roles: { reviewer: AeReviewerSetting }; rules: ReviewRules },
  base: { title: string; rules: ReviewRules } | undefined,
  agents: {
    options: readonly AeTeamOption[];
    host: Pick<Host, "status"> | null;
    loaded: boolean;
  },
): { title: string; text: string; warning: boolean } | null {
  const slots = aeReviewerList(shown.roles.reviewer);
  if (slots.length < 2) return null;
  const merge = aeReviewMergeOf(shown.rules);
  const title =
    merge === "merged" ? "Reviews: one merged verdict" : "Reviews: each list, then verdict";
  // Own subagents only: an agent reviewer is a child session, so the lead skips it.
  if (shown.rules.helpers === "own") {
    const skipped = slots.flatMap((s) => (s.mode === "agent" ? [s.name] : []));
    if (skipped.length > 0) {
      const rest = slots.filter((s) => s.mode !== "agent").map(slotName);
      const who = rest.length ? rest.join(" and ") : "The lead";
      return {
        title: rest.length > 1 ? title : `Reviews: ${rest.length ? who : "the lead"} only`,
        text: `${skipped.join(" and ")} skipped: Helpers is set to own subagents only. ${who} ${
          rest.length > 1 ? "review, each alone" : rest.length ? "reviews alone" : "reviews"
        }.`,
        warning: true,
      };
    }
  }
  const down = agents.loaded
    ? slots.findIndex(
        (s) =>
          s.mode === "agent" &&
          aeReviewerAgentStatus(s, agents.options, agents.host).status !== "ready",
      )
    : -1;
  if (down >= 0) {
    const agent = slots[down] as AeReviewerAgentSlot;
    const status = aeReviewerAgentStatus(agent, agents.options, agents.host).status;
    const what =
      status === "setup" ? "needs setup" : status === "missing" ? "is not found" : "is offline";
    const rest = slots.filter((_, i) => i !== down).map(slotName);
    const fallback =
      aeReviewerUnavailableOf(shown.rules) === "ask"
        ? "the lead asks you before the review."
        : `${rest.join(" and ")} ${rest.length > 1 ? "review" : "reviews"} alone.`;
    const still = status === "offline" ? "still offline" : "still unavailable";
    return {
      title,
      text: `${agent.name} ${what}. If it is ${still} at review time, ${fallback}`,
      warning: true,
    };
  }
  const changed = !!base && merge !== aeReviewMergeOf(base.rules);
  const from = changed ? "Changed for this session." : base ? `From ${base.title}.` : "";
  const named = slots.flatMap((s) => (s.mode === "agent" ? [s.name] : []));
  const sessions =
    named.length === 0
      ? ""
      : named.length === 1
        ? ` ${named[0]} runs as its own session.`
        : ` ${named.join(" and ")} run as their own sessions.`;
  return {
    title,
    text: `${from} Each reviewer works alone;${sessions || " none sees another's findings."}`.trim(),
    warning: false,
  };
}

function slotName(slot: AeReviewerSlot): string {
  if (slot.mode === "fixed") return aeModelLabel(slot.model);
  if (slot.mode === "agent") return slot.name;
  return "the lead's pick";
}

/** The note on an added-session row whose agent is already a reviewer in the preset. */
export function aeReviewerMemberNote(number: number | undefined): string | null {
  return number
    ? `Already Reviewer ${number} in this preset. A review always starts a fresh session, never this one.`
    : null;
}

/** The short form for the composer menu's session rows. */
export function aeReviewerMemberTag(number: number | undefined): string | null {
  return number ? `Already Reviewer ${number} in this preset` : null;
}

/** Agent id to reviewer number for a resolved session choice; undefined for Lead picks. */
export function aeReviewerNumbers(
  choice: { kind: string; preset?: { roles: { reviewer: AeReviewerSetting } } } | null,
): ReadonlyMap<string, number> | undefined {
  const preset = choice?.kind === "preset" ? choice.preset : undefined;
  if (!preset) return undefined;
  const numbers = new Map<string, number>();
  for (const { slot, number } of aeReviewerAgents(preset.roles.reviewer)) {
    numbers.set(slot.agent, number);
    // Also by registered name, for an install whose agent id differs from the stored one.
    if (slot.agent_name) numbers.set(`name:${slot.agent_name}`, number);
  }
  return numbers;
}

/** The reviewer number of a listed agent, by id first and then by registered name. */
export function aeReviewerNumberOf(
  numbers: ReadonlyMap<string, number> | undefined,
  agent: { id: string; name: string },
): number | undefined {
  return numbers?.get(agent.id) ?? numbers?.get(`name:${agent.name}`);
}
