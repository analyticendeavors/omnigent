import { describe, expect, it } from "vitest";
import {
  AE_PERSONA_INSTRUCTIONS_MAX,
  type AePersona,
  aeAllPersonas,
  aeDuplicatePersona,
  aeEffectiveSlot,
  aeNormalizeNewlines,
  aeParsePersona,
  aeParsePersonas,
  aePersonaBarredFromFirst,
  aePersonaId,
  aePersonaOf,
  aePersonaProblems,
  aePersonaUsers,
} from "./aePersonas";
import { aeParseRolesState, aeRolesDoc } from "./aeRoles";

const security: AePersona = {
  id: "security",
  name: "Security",
  purpose: "Security only",
  model: "claude-opus-5-5",
  effort: "high",
  when: "risky",
  trigger: "auth",
  instructions: "Report attack paths.",
};
const general: AePersona = {
  id: "general",
  name: "General",
  purpose: "Correctness",
  model: "claude-sonnet-5-5",
  effort: "medium",
  when: "always",
  instructions: "Review.",
};
const mine: AePersona = {
  id: "docs",
  name: "Docs",
  purpose: "Docs match",
  when: "always",
  instructions: "Read the docs.\nFlag stale claims.",
};
const all = aeAllPersonas([general, security], [mine]);

describe("aePersonas", () => {
  it("parses a persona and refuses a malformed one", () => {
    expect(aeParsePersona(security)).toEqual(security);
    expect(aeParsePersona({ ...mine, extra: 1 })).toEqual(mine);
    for (const bad of [
      null,
      { ...mine, id: "Bad Id" },
      { ...mine, name: 3 },
      { ...mine, instructions: undefined },
      { ...mine, effort: "huge" },
      { ...mine, when: "sometimes" },
      { ...mine, model: "" },
    ]) {
      expect(aeParsePersona(bad)).toBeNull();
    }
    expect(aeParsePersonas([mine, { id: 1 }])).toBeNull();
    expect(aeParsePersonas("x")).toBeNull();
  });

  it("lists the built-in personas first and marks where each comes from", () => {
    expect(all.map((p) => [p.id, p.builtin])).toEqual([
      ["general", true],
      ["security", true],
      ["docs", false],
    ]);
  });

  it("finds the persona a slot names, and none when it is gone or unnamed", () => {
    expect(aePersonaOf({ mode: "fixed", persona: "docs" }, all)?.name).toBe("Docs");
    expect(aePersonaOf({ mode: "fixed", persona: "gone" }, all)).toBeNull();
    expect(aePersonaOf({ mode: "fixed", model: "m", effort: "low" }, all)).toBeNull();
    expect(aePersonaOf({ mode: "auto" }, all)).toBeNull();
  });

  it("shows a persona-only slot on the persona's model, an override over it, and Auto without one", () => {
    expect(aeEffectiveSlot({ mode: "fixed", persona: "security" }, all)).toEqual({
      mode: "fixed",
      model: "claude-opus-5-5",
      effort: "high",
    });
    expect(aeEffectiveSlot({ mode: "fixed", persona: "security", effort: "low" }, all)).toEqual({
      mode: "fixed",
      model: "claude-opus-5-5",
      effort: "low",
    });
    expect(
      aeEffectiveSlot({ mode: "fixed", persona: "security", model: "claude-haiku-5-5" }, all),
    ).toEqual({ mode: "fixed", model: "claude-haiku-5-5", effort: "high" });
    expect(aeEffectiveSlot({ mode: "fixed", persona: "docs" }, all)).toEqual({ mode: "auto" });
    expect(aeEffectiveSlot({ mode: "fixed", persona: "gone" }, all)).toEqual({ mode: "auto" });
    const plain = { mode: "fixed" as const, model: "claude-opus-5-5", effort: "max" as const };
    expect(aeEffectiveSlot(plain, all)).toEqual(plain);
    const agent = {
      mode: "agent" as const,
      agent: "a",
      name: "A",
      model: null,
      effort: null,
      persona: "security",
    };
    expect(aeEffectiveSlot(agent, all)).toBe(agent);
  });

  it("bars a persona that runs only if risky from reviewer 1", () => {
    expect(aePersonaBarredFromFirst(security)).toBe(true);
    expect(aePersonaBarredFromFirst(general)).toBe(false);
  });

  it("names the presets that use a persona", () => {
    const presets = [
      {
        title: "A",
        roles: {
          reviewer: {
            mode: "multi" as const,
            reviewers: [
              { mode: "fixed" as const, model: "m", effort: "low" as const },
              { mode: "fixed" as const, persona: "docs" },
            ],
          },
        },
      },
      {
        title: "B",
        roles: { reviewer: { mode: "fixed" as const, model: "m", effort: "low" as const } },
      },
    ];
    expect(aePersonaUsers(presets, "docs")).toEqual(["A"]);
    expect(aePersonaUsers(presets, "other")).toEqual([]);
  });

  it("makes ids from names and avoids the ones in use, built-in ones included", () => {
    expect(aePersonaId("Docs Check!", [])).toBe("docs-check");
    expect(aePersonaId("Security", ["security"])).toBe("security-2");
    expect(aePersonaId("???", [])).toBe("persona");
    expect(aePersonaId("9 lives", [])).toMatch(/^[a-z0-9]/);
  });

  it("duplicates into a new user persona with its own id and a marked name", () => {
    const copy = aeDuplicatePersona(security, ["general", "security"]);
    expect(copy).toMatchObject({ name: "Security copy", id: "security-copy", when: "risky" });
    expect(copy.instructions).toBe(security.instructions);
    expect(aeDuplicatePersona({ ...mine, name: "n".repeat(40) }, []).name).toHaveLength(40);
  });

  it("explains what stops a draft from saving", () => {
    const { id: _id, ...draft } = mine;
    expect(aePersonaProblems(draft)).toEqual([]);
    expect(aePersonaProblems({ ...draft, name: " " })).toEqual(["Give it a name."]);
    expect(aePersonaProblems({ ...draft, purpose: "" })).toEqual(["Say what it is for."]);
    expect(aePersonaProblems({ ...draft, instructions: "  \n " })).toEqual([
      "Write its instructions.",
    ]);
    expect(aePersonaProblems({ ...draft, name: "n".repeat(41) })[0]).toContain("40");
    expect(aePersonaProblems({ ...draft, purpose: "a\nb" })[0]).toContain("one line");
    expect(
      aePersonaProblems({ ...draft, instructions: "x".repeat(AE_PERSONA_INSTRUCTIONS_MAX + 1) })[0],
    ).toContain("1000");
    expect(aePersonaProblems({ ...draft, instructions: "a\u0000b" })).toHaveLength(1);
    expect(aePersonaProblems({ ...draft, trigger: " " })).toHaveLength(1);
    expect(aePersonaProblems({ ...draft, trigger: "x".repeat(201) })[0]).toContain("200");
    expect(aePersonaProblems({ ...draft, instructions: "a\nb\n" })).toEqual([]);
  });

  it("normalizes line endings", () => {
    expect(aeNormalizeNewlines("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });
});

describe("the roles state with personas", () => {
  const body = {
    revision: 1,
    default_preset: "p",
    apply_start_on: true,
    presets: [],
    starters: [],
    builtin_personas: [general, security],
    personas: [mine],
  };

  it("reads the built-in and the user's personas and sends only the user's back", () => {
    const state = aeParseRolesState(body);
    expect(state?.builtin_personas).toEqual([general, security]);
    expect(state?.personas).toEqual([mine]);
    const doc = aeRolesDoc(state!);
    expect(doc.personas).toEqual([mine]);
    expect("builtin_personas" in doc).toBe(false);
  });

  it("leaves personas out of a save while the user has none", () => {
    const state = aeParseRolesState({ ...body, personas: undefined, builtin_personas: undefined });
    expect(state?.personas).toBeUndefined();
    expect(state?.builtin_personas).toEqual([]);
    expect("personas" in aeRolesDoc(state!)).toBe(false);
    expect(aeParseRolesState({ ...body, personas: [{ id: 1 }] })?.personas).toBeUndefined();
  });
});
