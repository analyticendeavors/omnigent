import { describe, expect, it } from "vitest";
import { aeParseRolesState, aeRoleSummary, type AeRoleTable } from "./aeRoles";
import type { AeTeamOption } from "./aeTeamOptions";
import {
  AE_CODEX_AGENT_ID,
  AE_CODEX_AGENT_NAME,
  aeAgentEfforts,
  aeParseReviewerMulti,
  aeReviewerAgentOption,
  aeReviewerAgentStatus,
  aeReviewerNumberOf,
  aeReviewerList,
  aeReviewerMemberNote,
  aeReviewerMemberTag,
  aeReviewerNumbers,
  aeReviewsCard,
  aeReviewerSummary,
  aeWriteReviewers,
} from "./aeReviewers";

const codex = {
  mode: "agent" as const,
  agent: AE_CODEX_AGENT_ID,
  name: "Codex",
  model: null,
  effort: "medium" as const,
};
const named = { ...codex, agent: "random-seeded-id", agent_name: AE_CODEX_AGENT_NAME };
// The agents list as the sessions picker builds it: Codex under an id that is not the built-in one.
const liveCodex = {
  agent: { id: "live-codex-id", name: AE_CODEX_AGENT_NAME, harness: "codex-native" },
  name: "Codex",
  readiness: { state: "available", reason: "ready", selectable: true },
} as unknown as AeTeamOption;
const sonnet = { mode: "fixed" as const, model: "claude-sonnet-5-5", effort: "medium" as const };

const roles = (reviewer: unknown) => ({
  lead: { mode: "session" },
  planner: { mode: "fixed", model: "claude-opus-5-5", effort: "high" },
  reviewer,
  builder: sonnet,
  helper: { mode: "fixed", model: "claude-haiku-5-5", effort: "low" },
});
const stateWith = (reviewer: unknown, rules: Record<string, unknown> = {}) =>
  aeParseRolesState({
    revision: 0,
    default_preset: "p",
    presets: [
      {
        id: "p",
        title: "Balanced",
        icon: "scale",
        color: "teal",
        roles: roles(reviewer),
        rules: { raise_or_lower: "tell", lead_steps_down: true, auto_raises: 1, ...rules },
      },
    ],
  });

describe("aeReviewers", () => {
  it("keeps reading the old single reviewer and writes it back unchanged", () => {
    const state = stateWith(sonnet);
    expect(state?.presets[0].roles.reviewer).toEqual(sonnet);
    expect(aeWriteReviewers(aeReviewerList(sonnet))).toEqual(sonnet);
    expect(aeWriteReviewers([{ mode: "auto" }])).toEqual({ mode: "auto" });
  });

  it("parses 1 to 3 reviewers, null model and effort, and the new rules", () => {
    const state = stateWith(
      { mode: "multi", reviewers: [sonnet, { ...codex, effort: null }] },
      { review_merge: "separate", reviewer_unavailable: "ask" },
    );
    const preset = state?.presets[0];
    expect(preset?.roles.reviewer).toEqual({
      mode: "multi",
      reviewers: [sonnet, { ...codex, agent_name: null, effort: null }],
    });
    expect(preset?.rules.review_merge).toBe("separate");
    expect(preset?.rules.reviewer_unavailable).toBe("ask");
  });

  it("rejects 0 or 4 reviewers, Auto past slot 1 and a bad agent slot", () => {
    expect(aeParseReviewerMulti({ mode: "multi", reviewers: [] })).toBeNull();
    expect(
      aeParseReviewerMulti({ mode: "multi", reviewers: [sonnet, sonnet, sonnet, sonnet] }),
    ).toBeNull();
    expect(
      aeParseReviewerMulti({ mode: "multi", reviewers: [sonnet, { mode: "auto" }] }),
    ).toBeNull();
    expect(
      aeParseReviewerMulti({ mode: "multi", reviewers: [{ ...codex, agent: "" }] }),
    ).toBeNull();
    expect(
      aeParseReviewerMulti({ mode: "multi", reviewers: [{ ...codex, name: "x".repeat(41) }] }),
    ).toBeNull();
    expect(stateWith({ mode: "multi", reviewers: [] })).toBeNull();
  });

  it("writes the multi shape for 2 or 3 reviewers or a lone agent, never a 4th", () => {
    expect(aeWriteReviewers([sonnet, codex])).toEqual({
      mode: "multi",
      reviewers: [sonnet, codex],
    });
    expect(aeWriteReviewers([codex])).toEqual({ mode: "multi", reviewers: [codex] });
    const four = aeWriteReviewers([sonnet, codex, sonnet, codex]);
    expect(four.mode === "multi" && four.reviewers).toHaveLength(3);
    expect(aeWriteReviewers([sonnet, { mode: "auto" }])).toEqual(sonnet);
  });

  it("summarizes reviewers compactly with the right row label", () => {
    expect(aeReviewerSummary({ mode: "multi", reviewers: [sonnet, codex] })).toBe(
      "Sonnet 5.5 medium + Codex",
    );
    const table = roles({ mode: "multi", reviewers: [sonnet, codex] }) as AeRoleTable;
    expect(aeRoleSummary(table)).toContain("Reviewers Sonnet 5.5 medium + Codex");
    expect(aeRoleSummary(roles(sonnet) as AeRoleTable)).toContain("Reviewer Sonnet 5.5 medium");
  });

  it("builds the Reviews card, amber when the agent cannot run", () => {
    const shown = { roles: { reviewer: aeWriteReviewers([sonnet, codex]) }, rules: {} };
    const base = { title: "Balanced", rules: {} };
    const ready = aeReviewsCard(shown, base, { options: [], host: null, loaded: false });
    expect(ready).toEqual({
      title: "Reviews: one merged verdict",
      text: "From Balanced. Each reviewer works alone; Codex runs as its own session.",
      warning: false,
    });
    const offline = aeReviewsCard(shown, base, {
      options: [],
      host: { status: "offline" },
      loaded: true,
    });
    expect(offline?.warning).toBe(true);
    expect(offline?.text).toBe(
      "Codex is offline. If it is still offline at review time, Sonnet 5.5 reviews alone.",
    );
    expect(
      aeReviewsCard({ roles: { reviewer: sonnet }, rules: {} }, base, {
        options: [],
        host: null,
        loaded: true,
      }),
    ).toBeNull();
  });

  it("notes an added session that is already a reviewer", () => {
    expect(aeReviewerMemberNote(2)).toBe(
      "Already Reviewer 2 in this preset. A review always starts a fresh session, never this one.",
    );
    expect(aeReviewerMemberNote(undefined)).toBeNull();
    expect(aeReviewerMemberTag(3)).toBe("Already Reviewer 3 in this preset");
    const preset = { roles: { reviewer: aeWriteReviewers([sonnet, codex]) } };
    expect(aeReviewerNumbers({ kind: "preset", preset })?.get(AE_CODEX_AGENT_ID)).toBe(2);
    expect(aeReviewerNumbers({ kind: "lead-picks" })).toBeUndefined();
  });

  it("keeps the registered name on an agent slot and drops a bad one", () => {
    const state = stateWith({ mode: "multi", reviewers: [named] });
    expect(state?.presets[0].roles.reviewer).toEqual({ mode: "multi", reviewers: [named] });
    expect(
      aeParseReviewerMulti({ mode: "multi", reviewers: [{ ...named, agent_name: "no spaces" }] }),
    ).toBeNull();
  });

  it("finds the live agent by registered name when the stored id is not listed", () => {
    expect(aeReviewerAgentOption(named, [liveCodex])).toBe(liveCodex);
    expect(aeReviewerAgentOption({ agent: "random-seeded-id" }, [liveCodex])).toBeNull();
    const up = aeReviewerAgentStatus(named, [liveCodex], { status: "online" });
    expect(up.status).toBe("ready");
    expect(aeReviewerAgentStatus(codex, [liveCodex], { status: "online" }).status).toBe("missing");
    const preset = { roles: { reviewer: aeWriteReviewers([sonnet, named]) } };
    const numbers = aeReviewerNumbers({ kind: "preset", preset });
    expect(aeReviewerNumberOf(numbers, liveCodex.agent)).toBe(2);
    expect(aeReviewerNumberOf(numbers, { id: "x", name: "other" })).toBeUndefined();
  });

  it("offers only the efforts the agent's harness takes", () => {
    expect(aeAgentEfforts("claude-native")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(aeAgentEfforts("antigravity-native")).toEqual(["low", "medium", "high"]);
    expect(aeAgentEfforts("gemini")).toEqual(["low", "medium", "high"]);
    expect(aeAgentEfforts("codex-native", ["low", "high", "none"])).toEqual(["low", "high"]);
    expect(aeAgentEfforts("codex-native", [])).toHaveLength(5);
    expect(aeAgentEfforts(null)).toHaveLength(5);
  });

  it("shows skipped agents, amber and without an agent session, when Helpers is own", () => {
    const shown = {
      roles: { reviewer: aeWriteReviewers([sonnet, codex]) },
      rules: { helpers: "own" as const },
    };
    const card = aeReviewsCard(
      shown,
      { title: "Solo", rules: {} },
      {
        options: [liveCodex],
        host: { status: "online" },
        loaded: true,
      },
    );
    expect(card).toEqual({
      title: "Reviews: Sonnet 5.5 only",
      text: "Codex skipped: Helpers is set to own subagents only. Sonnet 5.5 reviews alone.",
      warning: true,
    });
    expect(card?.text).not.toMatch(/session/);
    const two = aeReviewsCard(
      { ...shown, roles: { reviewer: aeWriteReviewers([sonnet, sonnet, codex]) } },
      undefined,
      { options: [], host: null, loaded: false },
    );
    expect(two?.title).toBe("Reviews: one merged verdict");
    expect(two?.warning).toBe(true);
    expect(two?.text).not.toMatch(/runs as its own session/);
    const any = aeReviewsCard({ ...shown, rules: { helpers: "any" } }, undefined, {
      options: [],
      host: null,
      loaded: false,
    });
    expect(any?.warning).toBe(false);
  });

  it("does not read or rewrite a session-mode reviewer as Auto", () => {
    expect(stateWith({ mode: "session" })).toBeNull();
    expect(stateWith({ mode: "multi", reviewers: [{ mode: "session" }] })).toBeNull();
  });

  it("adds no review rules to a preset that has none, so a re-save is the same", () => {
    const state = stateWith({ mode: "multi", reviewers: [sonnet, codex] });
    expect(state?.presets[0].rules).toEqual({
      raise_or_lower: "tell",
      lead_steps_down: true,
      auto_raises: 1,
    });
  });
});
