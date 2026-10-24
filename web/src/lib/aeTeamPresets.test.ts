import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AeRolePreset } from "./aeRoles";
import { AE_TEAM_LABEL, type AeTeamMember } from "./aeTeam";
import {
  aeIsLegacySolo,
  aeMigratedSessionRoles,
  aeSaveTeamMember,
  aeSessionsLocked,
  aeSessionsLockedHint,
  aeToggleMember,
} from "./aeTeamPresets";
import { createSession, getSessionSlim, updateSession } from "./sessionsApi";
import { fetchChildSessions } from "@/hooks/useChildSessions";

vi.mock("./sessionsApi", () => ({
  createSession: vi.fn(),
  updateSession: vi.fn(),
  getSessionSlim: vi.fn(),
}));
vi.mock("@/hooks/useChildSessions", () => ({ fetchChildSessions: vi.fn() }));

const preset = (id: string, helpers?: "any" | "own"): AeRolePreset => ({
  id,
  title: id === "solo" ? "Solo" : id,
  icon: "scale",
  color: "teal",
  description: "",
  when_to_use: "",
  pinned: false,
  roles: {
    lead: { mode: "session" },
    planner: { mode: "fixed", model: "claude-opus-5-5", effort: "high" },
    reviewer: { mode: "auto" },
    builder: { mode: "auto" },
    helper: { mode: "auto" },
  },
  rules: {
    raise_or_lower: "tell",
    lead_steps_down: true,
    auto_raises: 1,
    ...(helpers ? { helpers } : {}),
  },
});
const WITH_SOLO = { default_preset: "b", presets: [preset("b"), preset("solo", "own")] };
const WITHOUT_SOLO = { default_preset: "b", presets: [preset("b"), preset("y")] };
const solo = (extra: object = {}) => ({
  [AE_TEAM_LABEL]: JSON.stringify({ version: 1, mode: "solo", members: [], ...extra }),
});

const codex: AeTeamMember = {
  agentId: "ag_codex",
  agentName: "codex-native",
  displayName: "Codex",
  model: null,
  sessionId: "child-codex",
};
const gemini: AeTeamMember = {
  agentId: "ag_gemini",
  agentName: "gemini-native",
  displayName: "Gemini CLI",
  model: null,
};

describe("reading a label saved before the fold", () => {
  it("spots a Solo label and nothing else", () => {
    expect(aeIsLegacySolo(solo())).toBe(true);
    expect(aeIsLegacySolo()).toBe(false);
    expect(aeIsLegacySolo({ [AE_TEAM_LABEL]: '{"version":1,"mode":"team"}' })).toBe(false);
    expect(aeIsLegacySolo({ [AE_TEAM_LABEL]: "{" })).toBe(false);
  });

  it("reads Solo with no roles as the Solo starter when the user has it", () => {
    expect(aeMigratedSessionRoles(solo(), null, WITH_SOLO)).toEqual({ preset: "solo" });
  });

  it("reads Solo as the default kept in house when the user has no Solo preset", () => {
    const roles = aeMigratedSessionRoles(solo(), null, WITHOUT_SOLO);
    expect(roles?.preset).toBe("b");
    expect(roles?.custom?.rules.helpers).toBe("own");
    expect(roles?.custom?.roles).toEqual(preset("b").roles);
  });

  it("reads Solo as an edited solo preset (Helpers any) customized to own", () => {
    const edited = { default_preset: "b", presets: [preset("b"), preset("solo", "any")] };
    const roles = aeMigratedSessionRoles(solo(), null, edited);
    expect(roles).toEqual({
      preset: "solo",
      custom: {
        roles: preset("solo").roles,
        rules: { ...preset("solo", "any").rules, helpers: "own" },
      },
    });
  });

  it("greys the list for a legacy Solo label whatever the roles say", () => {
    const leadPicks = { kind: "lead-picks" } as const;
    expect(aeSessionsLocked(leadPicks, true)).toBe(true);
    expect(aeSessionsLocked(leadPicks, false)).toBe(false);
    expect(
      aeSessionsLocked(
        { kind: "preset", preset: preset("y"), isDefault: false, edited: false },
        false,
      ),
    ).toBe(false);
  });

  it("keeps a chosen preset and only turns its Helpers to own", () => {
    const roles = aeMigratedSessionRoles(solo(), { preset: "y" }, WITHOUT_SOLO);
    expect(roles).toEqual({
      preset: "y",
      custom: { roles: preset("y").roles, rules: { ...preset("y").rules, helpers: "own" } },
    });
    expect(aeMigratedSessionRoles(solo(), { preset: "solo" }, WITH_SOLO)).toEqual({
      preset: "solo",
    });
  });

  it("leaves new-shape labels, Lead picks and unreadable roles alone", () => {
    const team = { [AE_TEAM_LABEL]: '{"version":1,"mode":"team","members":[]}' };
    expect(aeMigratedSessionRoles(team, null, WITH_SOLO)).toBeNull();
    expect(aeMigratedSessionRoles(solo(), { preset: "lead-picks" }, WITH_SOLO)).toEqual({
      preset: "lead-picks",
    });
    const raw = { preset: "y", raw: { preset: "y", custom: { future: 1 } } };
    expect(aeMigratedSessionRoles(solo(), raw, WITHOUT_SOLO)).toBe(raw);
  });

  it("names the preset in the greyed-out hint", () => {
    expect(
      aeSessionsLockedHint({
        kind: "preset",
        preset: preset("solo", "own"),
        isDefault: false,
        edited: false,
      }),
    ).toBe("Solo uses own subagents only. Pick another preset to add sessions.");
  });
});

describe("adding or removing one session", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fetchChildSessions).mockResolvedValue([]);
    vi.mocked(createSession).mockResolvedValue({
      id: "child-gemini",
      kind: "sub_agent",
    } as Awaited<ReturnType<typeof createSession>>);
    vi.mocked(updateSession).mockImplementation(
      async (_id, patch) => patch as Awaited<ReturnType<typeof updateSession>>,
    );
  });

  const parentWith = (label: object) =>
    ({
      id: "parent",
      agentId: "ag_claude",
      subagentRoutingOverride: "off",
      labels: { [AE_TEAM_LABEL]: JSON.stringify(label) },
    }) as unknown as Awaited<ReturnType<typeof getSessionSlim>>;
  const savedLabel = () =>
    JSON.parse(vi.mocked(updateSession).mock.calls.at(-1)![1].labels![AE_TEAM_LABEL]);

  it("toggles one member per agent", () => {
    expect(aeToggleMember([codex], gemini, true)).toEqual([codex, gemini]);
    expect(aeToggleMember([codex, gemini], codex, false)).toEqual([gemini]);
    expect(aeToggleMember([codex], { ...codex, sessionId: undefined }, true)).toEqual([codex]);
  });

  it("adds a session on the freshest label, keeping roles and unknown fields", async () => {
    vi.mocked(getSessionSlim).mockResolvedValue(
      parentWith({
        version: 1,
        mode: "team",
        members: [codex],
        routingBeforeTeam: "on",
        roles: { preset: "y", custom: { future: 1 } },
        future: true,
      }),
    );
    await aeSaveTeamMember("parent", gemini, true);
    const label = savedLabel();
    expect(label.mode).toBe("team");
    expect(label.members.map((m: AeTeamMember) => m.agentId)).toEqual(["ag_codex", "ag_gemini"]);
    expect(label.roles).toEqual({ preset: "y", custom: { future: 1 } });
    expect(label.future).toBe(true);
    expect(label.routingBeforeTeam).toBe("on");
  });

  it("removing the last session writes Auto and keeps the roles", async () => {
    vi.mocked(getSessionSlim).mockResolvedValue(
      parentWith({ version: 1, mode: "team", members: [codex], roles: { preset: "y" } }),
    );
    await aeSaveTeamMember("parent", codex, false);
    expect(savedLabel()).toEqual({ version: 1, mode: "auto", members: [], roles: { preset: "y" } });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses a seventh session", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ ...codex, agentId: `ag_${i}` }));
    vi.mocked(getSessionSlim).mockResolvedValue(
      parentWith({ version: 1, mode: "team", members: six }),
    );
    await expect(aeSaveTeamMember("parent", gemini, true)).rejects.toThrow("up to 6");
    expect(updateSession).not.toHaveBeenCalled();
  });
});
