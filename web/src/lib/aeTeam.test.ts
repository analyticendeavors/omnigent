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

describe("team persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fetchChildSessions).mockResolvedValue([]);
    vi.mocked(getSessionSlim).mockResolvedValue({ subagentRoutingOverride: "off" } as Awaited<
      ReturnType<typeof getSessionSlim>
    >);
    vi.mocked(createSession).mockResolvedValue({ id: "new-child" } as Awaited<
      ReturnType<typeof createSession>
    >);
  });

  it("ignores malformed and oversized rosters", () => {
    for (const raw of ["{", "null", JSON.stringify({ version: 9 }), " ".repeat(20_000)]) {
      expect(readAeTeam({ [AE_TEAM_LABEL]: raw })).toEqual({
        version: 1,
        mode: "solo",
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

  it("switches to Solo without starting or deleting children", async () => {
    await saveAeTeam("parent", { version: 1, mode: "solo", members: [codex] });
    expect(fetchChildSessions).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith("parent", {
      labels: { [AE_TEAM_LABEL]: '{"version":1,"mode":"solo","members":[]}' },
    });
  });

  it("turns off automatic collaborator routing before creating pinned teammates", async () => {
    vi.mocked(getSessionSlim).mockResolvedValue({ subagentRoutingOverride: "on" } as Awaited<
      ReturnType<typeof getSessionSlim>
    >);
    await saveAeTeam("parent", { version: 1, mode: "team", members: [codex] });
    expect(updateSession).toHaveBeenNthCalledWith(1, "parent", { subagentRoutingOverride: "off" });
    expect(vi.mocked(updateSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(createSession).mock.invocationCallOrder[0],
    );
  });

  it("restores routing if a team cannot be provisioned", async () => {
    vi.mocked(getSessionSlim).mockResolvedValue({ subagentRoutingOverride: "on" } as Awaited<
      ReturnType<typeof getSessionSlim>
    >);
    vi.mocked(createSession).mockRejectedValue(new Error("Unavailable"));
    await expect(
      saveAeTeam("parent", { version: 1, mode: "team", members: [codex] }),
    ).rejects.toThrow("Unavailable");
    expect(updateSession).toHaveBeenLastCalledWith("parent", { subagentRoutingOverride: "on" });
  });
});
