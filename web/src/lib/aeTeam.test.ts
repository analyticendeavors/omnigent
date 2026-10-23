import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AE_TEAM_LABEL,
  AE_TEAM_MEMBER_LABEL,
  aeTeamMemberKey,
  readAeTeam,
  saveAeTeam,
  type AeTeamMember,
} from "./aeTeam";
import { createSession, getSessionSlim, updateSession } from "./sessionsApi";
import { fetchChildSessions } from "@/hooks/useChildSessions";

vi.mock("./sessionsApi", () => ({
  createSession: vi.fn(),
  updateSession: vi.fn(),
  getSessionSlim: vi.fn(),
}));
vi.mock("@/hooks/useChildSessions", () => ({ fetchChildSessions: vi.fn() }));

const codex: AeTeamMember = {
  agentId: "ag_codex",
  agentName: "codex-native",
  displayName: "Codex",
  model: "test-codex-model",
};
const claude: AeTeamMember = {
  agentId: "ag_claude",
  agentName: "claude-native",
  displayName: "Claude",
  model: null,
};
const parent: Awaited<ReturnType<typeof getSessionSlim>> = {
  id: "parent",
  agentId: "ag_codex",
  agentName: "codex-native",
  status: "idle",
  createdAt: 0,
  title: null,
  items: [],
  permissionLevel: 4,
  parentSessionId: null,
  subAgentName: null,
  kind: "default",
  subagentRoutingOverride: "off",
};

describe("team persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fetchChildSessions).mockResolvedValue([]);
    vi.mocked(getSessionSlim).mockResolvedValue(parent);
    vi.mocked(createSession).mockResolvedValue({ ...parent, id: "new-child", kind: "sub_agent" });
  });

  it("ignores malformed and oversized rosters", () => {
    for (const raw of ["{", "null", JSON.stringify({ version: 9 }), " ".repeat(20_000)]) {
      expect(readAeTeam({ [AE_TEAM_LABEL]: raw })).toEqual({
        version: 1,
        mode: "auto",
        members: [],
      });
    }
  });

  it("creates an idle child with the selected model before publishing the roster", async () => {
    await saveAeTeam("parent", { version: 1, mode: "team", members: [codex] });
    expect(createSession).toHaveBeenCalledWith(
      "ag_codex",
      [],
      expect.objectContaining({
        parentSessionId: "parent",
        modelOverride: "test-codex-model",
        labels: { [AE_TEAM_MEMBER_LABEL]: aeTeamMemberKey(codex) },
      }),
    );
    expect(updateSession).toHaveBeenCalledWith("parent", {
      subagentRoutingOverride: "off",
      labels: {
        [AE_TEAM_LABEL]: JSON.stringify({
          version: 1,
          mode: "team",
          members: [{ ...codex, sessionId: "new-child" }],
          routingBeforeTeam: "off",
        }),
      },
    });
  });

  it("reuses a partially provisioned child when saving is retried", async () => {
    vi.mocked(fetchChildSessions).mockResolvedValue([
      {
        id: "existing",
        labels: { [AE_TEAM_MEMBER_LABEL]: aeTeamMemberKey(codex) },
        title: null,
        task_summary: null,
        tool: null,
        session_name: null,
        current_task_status: null,
        busy: false,
        last_message_preview: null,
        pending_elicitations_count: 0,
      },
    ]);
    await saveAeTeam("parent", { version: 1, mode: "team", members: [codex, claude] });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(
      "ag_claude",
      [],
      expect.not.objectContaining({ modelOverride: expect.anything() }),
    );
    expect(
      JSON.parse(vi.mocked(updateSession).mock.calls[0][1].labels![AE_TEAM_LABEL]).members[0]
        .sessionId,
    ).toBe("existing");
  });

  it("keeps the old roster if creating any selected member fails", async () => {
    vi.mocked(createSession).mockRejectedValueOnce(new Error("Host offline"));
    await expect(
      saveAeTeam("parent", { version: 1, mode: "team", members: [codex] }),
    ).rejects.toThrow("Host offline");
    expect(updateSession).not.toHaveBeenCalled();
  });

  it.each(["auto", "solo"] as const)("saves %s without provisioning children", async (mode) => {
    await saveAeTeam("parent", { version: 1, mode, members: [codex] });
    expect(fetchChildSessions).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith("parent", {
      labels: { [AE_TEAM_LABEL]: JSON.stringify({ version: 1, mode, members: [] }) },
    });
  });

  it("defaults to Auto while retaining an explicitly saved Solo preference", () => {
    expect(readAeTeam().mode).toBe("auto");
    expect(readAeTeam({ [AE_TEAM_LABEL]: '{"version":1,"mode":"solo","members":[]}' }).mode).toBe(
      "solo",
    );
  });

  it.each(["auto", "solo"] as const)(
    "restores the original routing when leaving a selected team for %s",
    async (mode) => {
      vi.mocked(getSessionSlim).mockResolvedValue({
        ...parent,
        subagentRoutingOverride: "off",
        labels: {
          [AE_TEAM_LABEL]: JSON.stringify({
            version: 1,
            mode: "team",
            members: [codex],
            routingBeforeTeam: "on",
          }),
        },
      });
      await saveAeTeam("parent", { version: 1, mode, members: [] });
      expect(createSession).not.toHaveBeenCalled();
      expect(updateSession).toHaveBeenCalledExactlyOnceWith("parent", {
        subagentRoutingOverride: "on",
        labels: { [AE_TEAM_LABEL]: JSON.stringify({ version: 1, mode, members: [] }) },
      });
    },
  );

  it("preserves the original routing across edits to an existing team", async () => {
    vi.mocked(getSessionSlim).mockResolvedValue({
      ...parent,
      subagentRoutingOverride: "off",
      labels: {
        [AE_TEAM_LABEL]: JSON.stringify({
          version: 1,
          mode: "team",
          members: [codex],
          routingBeforeTeam: "on",
        }),
      },
    });
    await saveAeTeam("parent", { version: 1, mode: "team", members: [claude] });
    const saved = readAeTeam(vi.mocked(updateSession).mock.calls.at(-1)![1].labels!);
    expect(saved.routingBeforeTeam).toBe("on");
  });

  it("clears the legacy Team routing override when returning to Auto", async () => {
    vi.mocked(getSessionSlim).mockResolvedValue({
      ...parent,
      subagentRoutingOverride: "off",
      labels: { [AE_TEAM_LABEL]: '{"version":1,"mode":"team","members":[]}' },
    });
    await saveAeTeam("parent", { version: 1, mode: "auto", members: [] });
    expect(updateSession).toHaveBeenCalledWith(
      "parent",
      expect.objectContaining({ subagentRoutingOverride: null }),
    );
  });

  it("keeps a manual routing change made after selecting Team", async () => {
    vi.mocked(getSessionSlim).mockResolvedValue({
      ...parent,
      subagentRoutingOverride: "on",
      labels: { [AE_TEAM_LABEL]: '{"version":1,"mode":"team","members":[]}' },
    });
    await saveAeTeam("parent", { version: 1, mode: "auto", members: [] });
    expect(updateSession).toHaveBeenCalledWith("parent", {
      labels: { [AE_TEAM_LABEL]: '{"version":1,"mode":"auto","members":[]}' },
    });
  });

  it("turns off automatic collaborator routing before creating pinned teammates", async () => {
    vi.mocked(getSessionSlim).mockResolvedValue({ ...parent, subagentRoutingOverride: "on" });
    await saveAeTeam("parent", { version: 1, mode: "team", members: [codex] });
    expect(updateSession).toHaveBeenNthCalledWith(1, "parent", { subagentRoutingOverride: "off" });
    expect(vi.mocked(updateSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(createSession).mock.invocationCallOrder[0],
    );
  });

  it("restores routing if a team cannot be provisioned", async () => {
    vi.mocked(getSessionSlim).mockResolvedValue({ ...parent, subagentRoutingOverride: "on" });
    vi.mocked(createSession).mockRejectedValue(new Error("Unavailable"));
    await expect(
      saveAeTeam("parent", { version: 1, mode: "team", members: [codex] }),
    ).rejects.toThrow("Unavailable");
    expect(updateSession).toHaveBeenLastCalledWith("parent", { subagentRoutingOverride: "on" });
  });

  describe("roles preset", () => {
    const roles = { preset: "yolo" };
    const labelled = (mode: string) => ({
      ...parent,
      labels: { [AE_TEAM_LABEL]: JSON.stringify({ version: 1, mode, members: [], roles }) },
    });
    const savedLabel = () =>
      JSON.parse(vi.mocked(updateSession).mock.calls.at(-1)![1].labels![AE_TEAM_LABEL]);

    it("reads the preset with the roster", () => {
      expect(readAeTeam(labelled("solo").labels).roles).toEqual(roles);
    });

    it.each([
      ["auto", "solo"],
      ["solo", "team"],
      ["team", "auto"],
    ] as const)("keeps the preset when switching %s to %s", async (from, to) => {
      vi.mocked(getSessionSlim).mockResolvedValue(labelled(from));
      await saveAeTeam("parent", {
        version: 1,
        mode: to,
        members: to === "team" ? [codex] : [],
      });
      expect(savedLabel().roles).toEqual(roles);
      expect(savedLabel().mode).toBe(to);
    });

    it("writes a new preset from the draft and clears it for null", async () => {
      vi.mocked(getSessionSlim).mockResolvedValue(labelled("auto"));
      await saveAeTeam("parent", { version: 1, mode: "auto", members: [], roles: { preset: "x" } });
      expect(savedLabel().roles).toEqual({ preset: "x" });
      await saveAeTeam("parent", { version: 1, mode: "auto", members: [], roles: null });
      expect(savedLabel()).not.toHaveProperty("roles");
    });

    it.each(["auto", "team"] as const)(
      "keeps a custom block this client cannot read as stored when saving %s",
      async (mode) => {
        const newer = { preset: "yolo", custom: { future: { shape: 2 } } };
        vi.mocked(getSessionSlim).mockResolvedValue({
          ...parent,
          labels: {
            [AE_TEAM_LABEL]: JSON.stringify({
              version: 1,
              mode: "solo",
              members: [],
              roles: newer,
            }),
          },
        });
        await saveAeTeam("parent", { version: 1, mode, members: mode === "team" ? [codex] : [] });
        expect(savedLabel().roles).toEqual(newer);
      },
    );
  });
});
