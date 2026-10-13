import { describe, expect, it } from "vitest";
import type { AvailableAgent } from "@/hooks/useAvailableAgents";
import type { Host } from "@/hooks/useHosts";
import {
  aeTeamAgentName,
  aeTeamLeadName,
  aeTeamOptions,
  aeTeamReadiness,
  type AeTeamLead,
} from "./aeTeamOptions";

const codex: AvailableAgent = {
  id: "codex",
  name: "codex-native-ui",
  display_name: "Codex",
  harness: "codex-native",
  description: null,
  skills: [],
  builtin: true,
};
const claude: AvailableAgent = {
  ...codex,
  id: "claude",
  name: "claude-native-ui",
  display_name: "Claude Code",
  harness: "claude-native",
};
const host: Host = {
  host_id: "host",
  name: "Workstation",
  owner: "test",
  status: "online",
  configured_harnesses: {
    "codex-native": true,
    "claude-native": true,
    "claude-sdk": true,
    "pi-native": true,
  },
};
const leadFor = (agent: AvailableAgent): AeTeamLead => ({
  agentId: agent.id,
  agentName: agent.name,
  harness: agent.harness,
  labels: {},
});

describe("team agent names", () => {
  it("preserves distinct agent aliases without collapsing a shared native harness", () => {
    const work = { ...claude, id: "work", name: "claude-work", builtin: false };
    const personal = { ...claude, id: "personal", name: "claude-personal", builtin: false };
    expect(
      aeTeamOptions([work, personal, claude], host).map(({ agent, name }) => [agent.id, name]),
    ).toEqual([
      ["claude", "Claude Code"],
      ["personal", "claude-personal"],
      ["work", "claude-work"],
    ]);
    expect(aeTeamAgentName({ ...work, display_name: "Work reviewer" })).toBe("Work reviewer");
  });

  it("normalizes built-in clone names and preserves custom clone aliases", () => {
    expect(aeTeamAgentName({ ...codex, name: "codex-native-ui (fork ag_a) (switch ag_b)" })).toBe(
      "Codex",
    );
    expect(
      aeTeamAgentName({ ...codex, name: "project-reviewer (fork ag_a)", builtin: false }),
    ).toBe("project-reviewer");
    expect(aeTeamAgentName({ ...codex, name: "reviewer", harness: null, display_name: "" })).toBe(
      "reviewer",
    );
  });

  it("resolves lead aliases by id and never borrows a different id's display name", () => {
    const first = {
      ...codex,
      id: "first",
      name: "reviewer",
      display_name: "First reviewer",
      builtin: false,
    };
    const second = { ...first, id: "second", display_name: "Second reviewer" };
    expect(aeTeamLeadName(leadFor(second), [first, second])).toBe("Second reviewer");
    expect(aeTeamLeadName({ ...leadFor(second), agentId: "missing" }, [first])).toBe("reviewer");
    expect(
      aeTeamLeadName({ ...leadFor(codex), agentName: "codex-native-ui (fork ag_a)" }, []),
    ).toBe("Codex");
    expect(
      aeTeamLeadName({ agentId: "missing", agentName: null, harness: null, labels: {} }, []),
    ).toBe("Current agent");
  });
});

describe("team readiness", () => {
  it.each([undefined, null, {}])(
    "does not advertise an unverified catalog as connected with map %j",
    (configured_harnesses) => {
      const unknownHost = { ...host, configured_harnesses };
      const options = aeTeamOptions([codex, claude], unknownHost, leadFor(codex));
      for (const option of options) {
        expect(option.readiness).toMatchObject({
          state: "unavailable",
          reason: "readiness-unknown",
          selectable: false,
          explanation: { label: "Readiness unavailable" },
        });
        expect(option.recommendation).toBeNull();
      }
    },
  );

  it("does not treat a missing key in a partial map as ready", () => {
    expect(aeTeamReadiness("missing-harness", host)).toMatchObject({
      selectable: false,
      reason: "readiness-unknown",
      explanation: { label: "Readiness unavailable" },
    });
  });

  it.each([false, "needs-auth", "binary-missing", "version-too-low", "unexpected-error"])(
    "rejects explicit not-ready status %s",
    (status) => {
      expect(
        aeTeamReadiness("codex-native", {
          ...host,
          configured_harnesses: { "codex-native": status },
        }).selectable,
      ).toBe(false);
    },
  );

  it("requires verified SDK readiness too", () => {
    expect(
      aeTeamReadiness("claude-sdk", {
        ...host,
        configured_harnesses: { "claude-sdk": "needs-auth" },
      }),
    ).toMatchObject({
      selectable: false,
      state: "setup-required",
      reason: "needs-auth",
    });
  });

  it("uses canonical alias readiness but keeps an explicit alias failure authoritative", () => {
    expect(aeTeamReadiness("native-pi", host)).toMatchObject({ selectable: true, reason: "ready" });
    expect(
      aeTeamReadiness("native-pi", {
        ...host,
        configured_harnesses: { "pi-native": true, "native-pi": "needs-auth" },
      }),
    ).toMatchObject({ selectable: false, reason: "needs-auth" });
  });

  it("does not offer missing harnesses or unavailable hosts", () => {
    expect(aeTeamReadiness(null, host)).toMatchObject({
      selectable: false,
      reason: "harness-unavailable",
    });
    expect(aeTeamReadiness("codex-native", null)).toMatchObject({
      selectable: false,
      reason: "host-unavailable",
    });
    expect(aeTeamReadiness("codex-native", { ...host, status: "offline" })).toMatchObject({
      selectable: false,
      reason: "host-unavailable",
    });
  });
});

describe("team option ranking and recommendations", () => {
  it("prioritizes ready native coding and explicit custom agents over generic connected roles", () => {
    const generic = {
      ...codex,
      id: "generic",
      name: "orchestrator",
      display_name: "Orchestrator",
      harness: "claude-sdk",
    };
    const custom = {
      ...generic,
      id: "custom",
      name: "reviewer",
      display_name: "Reviewer",
      builtin: false,
    };
    const unavailable = {
      ...claude,
      id: "unavailable",
      name: "offline",
      harness: "missing-harness",
    };
    const options = aeTeamOptions([unavailable, generic, custom, codex], host);
    expect(options.map(({ agent }) => agent.id)).toEqual([
      "codex",
      "custom",
      "generic",
      "unavailable",
    ]);
    expect(options.slice(0, 3).map(({ primary }) => primary)).toEqual([true, true, false]);
  });

  it.each([
    [codex, claude],
    [claude, codex],
  ])("recommends a ready different-provider coding partner for $0.name", (lead, partner) => {
    const options = aeTeamOptions([lead, partner], host, leadFor(lead));
    expect(options[0]).toMatchObject({
      agent: { id: partner.id },
      recommendation: "Recommended: different provider for independent review.",
    });
    expect(options.filter(({ recommendation }) => recommendation)).toHaveLength(1);
  });

  it("honors authoritative wrapper metadata when the lead's transport harness differs", () => {
    const lead = {
      ...leadFor(codex),
      harness: "claude-sdk",
      labels: { "omnigent.wrapper": "codex-native-ui" },
    };
    expect(aeTeamOptions([codex, claude], host, lead)[0].agent.id).toBe("claude");
  });

  it("does not recommend unavailable, same-provider, self, or unknown-provider partners", () => {
    const pi = {
      ...codex,
      id: "pi",
      name: "pi-native-ui",
      display_name: "Pi",
      harness: "pi-native",
    };
    const alias = { ...codex, id: "work", name: "codex-work", builtin: false };
    const notReady = {
      ...host,
      configured_harnesses: { ...host.configured_harnesses, "claude-native": "needs-auth" },
    };
    expect(
      aeTeamOptions([codex, alias, claude, pi], notReady, leadFor(codex)).every(
        (option) => option.recommendation === null,
      ),
    ).toBe(true);
    expect(
      aeTeamOptions([codex, claude, pi], host, leadFor(pi)).every(
        (option) => option.recommendation === null,
      ),
    ).toBe(true);
    expect(
      aeTeamOptions([claude], host, { ...leadFor(codex), agentId: claude.id })[0].recommendation,
    ).toBeNull();
  });
});
