import { describe, expect, it } from "vitest";
import { aeCodexName } from "./aeCodexModels";
import {
  type AeModelCatalogs,
  aeApplyUpdate,
  aeModelUpdates,
  aeNewerClaudeModel,
  aeNewerClaudeUpdate,
  AE_NO_CONTEXT_NOTE,
  aeNewerCodexModel,
  aeRowAt,
  aeWithRow,
} from "./aeModelUpdates";
import type { AeReviewerSlot } from "./aeReviewers";
import type { AeRoleTable } from "./aeRoles";
import type { NativeModelOption } from "./types";

const levels = (...names: string[]) => names.map((reasoningEffort) => ({ reasoningEffort }));
const FIVE = levels("low", "medium", "high", "xhigh", "max");
const codexRow = (displayName: string, supported = FIVE, def = "medium") =>
  ({
    id: displayName.toLowerCase(),
    model: displayName.toLowerCase(),
    displayName,
    supportedReasoningEfforts: supported,
    defaultReasoningEffort: def,
  }) as NativeModelOption;

const CODEX = [
  codexRow("GPT-6-Sol", FIVE, "high"),
  codexRow("GPT-6-Luna", levels("low", "medium", "high")),
  codexRow("GPT-5.6-Sol"),
  codexRow("GPT-5.6-Terra"),
];
const CATALOGS: AeModelCatalogs = {
  claude: [
    "claude-opus-5-6",
    "claude-opus-5-5",
    "claude-sonnet-5-6",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-1",
    "claude-fable-5",
  ],
  codex: CODEX,
};
const codexSlot = (model: string | null, effort: string | null): AeReviewerSlot =>
  ({
    mode: "agent",
    agent: "a1",
    agent_name: "codex-native-ui",
    name: "Codex",
    model,
    effort,
  }) as AeReviewerSlot;

const ROLES = {
  lead: { mode: "session" },
  planner: { mode: "fixed", model: "claude-opus-5-5", effort: "high" },
  reviewer: { mode: "fixed", model: "claude-sonnet-5-5", effort: "medium" },
  builder: { mode: "fixed", model: "claude-sonnet-5-5", effort: "medium" },
  helper: { mode: "auto" },
} as AeRoleTable;

describe("aeNewerClaudeModel", () => {
  it("finds a new Opus when the catalog lists one", () => {
    expect(aeNewerClaudeModel("claude-opus-5-5", CATALOGS.claude)).toBe("claude-opus-5-6");
  });

  it("shows no chip for the same version or a newer stored one", () => {
    expect(aeNewerClaudeModel("claude-opus-5-6", CATALOGS.claude)).toBeNull();
    expect(aeNewerClaudeModel("claude-opus-5-7", CATALOGS.claude)).toBeNull();
    expect(aeNewerClaudeModel("claude-haiku-5-5", CATALOGS.claude)).toBeNull();
  });

  it("treats a bare major as minor 0", () => {
    expect(aeNewerClaudeModel("claude-fable-5", CATALOGS.claude)).toBe("claude-fable-5-1");
    expect(aeNewerClaudeModel("claude-fable-5-1", CATALOGS.claude)).toBeNull();
  });

  it("moves only inside the family", () => {
    expect(aeNewerClaudeModel("claude-haiku-5-5", ["claude-opus-6", "claude-sonnet-6"])).toBeNull();
  });

  it("ignores ids it cannot read, in the row and in the catalog", () => {
    expect(aeNewerClaudeModel("my-gateway-model", CATALOGS.claude)).toBeNull();
    expect(aeNewerClaudeModel("claude-opus-5-5", ["garbage", "claude-opus", ""])).toBeNull();
  });

  it("carries a context suffix only to an id the catalog lists with it", () => {
    expect(
      aeNewerClaudeModel("claude-opus-5-5[1m]", [...CATALOGS.claude, "claude-opus-5-6[1m]"]),
    ).toBe("claude-opus-5-6[1m]");
    expect(aeNewerClaudeUpdate("claude-opus-5-5[1m]", CATALOGS.claude)).toEqual({
      model: "claude-opus-5-6",
      noContext: true,
    });
  });

  it("skips the row when the catalog lists the newer model only in a variant the row lacks", () => {
    expect(
      aeNewerClaudeUpdate("claude-opus-5-5", ["claude-opus-5-5", "claude-opus-5-6[1m]"]),
    ).toBeNull();
    expect(aeNewerClaudeUpdate("claude-opus-5-5[1m]", ["claude-opus-5-6[200k]"])).toBeNull();
  });

  it("says in the update's note that the 1M variant is missing", () => {
    const roles = {
      ...ROLES,
      planner: { mode: "fixed", model: "claude-opus-5-5[1m]", effort: "high" },
    } as AeRoleTable;
    const planner = aeModelUpdates(roles, CATALOGS).find((u) => u.key === "planner");
    expect(planner).toMatchObject({ toModel: "claude-opus-5-6", note: AE_NO_CONTEXT_NOTE });
    expect(aeModelUpdates(ROLES, CATALOGS)[0].note).toBeNull();
  });

  it("still finds the update when the stored model is not in the catalog", () => {
    expect(aeNewerClaudeModel("claude-opus-4-8", CATALOGS.claude)).toBe("claude-opus-5-6");
    expect(aeNewerClaudeModel("claude-opus-5-5", [])).toBeNull();
  });
});

describe("aeNewerCodexModel", () => {
  it("moves a family to its newest generation", () => {
    expect(aeNewerCodexModel("gpt-5.6-sol", CODEX)?.displayName).toBe("GPT-6-Sol");
  });

  it("shows nothing on the newest, in another family, or for the host default", () => {
    expect(aeNewerCodexModel("gpt-6-sol", CODEX)).toBeNull();
    expect(aeNewerCodexModel("gpt-5.6-terra", CODEX)).toBeNull();
    expect(aeNewerCodexModel(null, CODEX)).toBeNull();
  });

  it("ignores a stored model the host does not list", () => {
    expect(aeNewerCodexModel("gpt-4-sol", CODEX)).toBeNull();
    expect(aeNewerCodexModel("gpt-5.6-sol", [])).toBeNull();
  });

  it("ignores catalog names it cannot parse", () => {
    expect(aeNewerCodexModel("gpt-5.6-sol", [...CODEX.slice(2), codexRow("Mystery")])).toBeNull();
    expect(aeCodexName("Mystery")).toBeNull();
  });
});

describe("aeModelUpdates", () => {
  it("lists a chip for each row on an older model, skipping Session and Auto", () => {
    const updates = aeModelUpdates(ROLES, CATALOGS);
    expect(updates.map((u) => [u.key, u.fromLabel, u.toLabel])).toEqual([
      ["planner", "Opus 5.5", "Opus 5.6"],
      ["reviewer:0", "Sonnet 5.5", "Sonnet 5.6"],
      ["builder", "Sonnet 5.5", "Sonnet 5.6"],
    ]);
  });

  it("lists nothing when every row is on its newest", () => {
    const roles = {
      ...ROLES,
      planner: { mode: "fixed", model: "claude-opus-5-6", effort: "high" },
      reviewer: { mode: "fixed", model: "claude-sonnet-5-6", effort: "high" },
      builder: { mode: "fixed", model: "claude-sonnet-5-6", effort: "high" },
    } as AeRoleTable;
    expect(aeModelUpdates(roles, CATALOGS)).toEqual([]);
  });

  it("covers a Fable row", () => {
    const roles = {
      ...ROLES,
      planner: { mode: "fixed", model: "claude-fable-5", effort: "max" },
    } as AeRoleTable;
    const planner = aeModelUpdates(roles, CATALOGS).find((u) => u.key === "planner");
    expect([planner?.fromLabel, planner?.toLabel]).toEqual(["Fable 5", "Fable 5.1"]);
  });

  it("ignores unparseable stored ids", () => {
    const roles = {
      ...ROLES,
      planner: { mode: "fixed", model: "custom-model", effort: "high" },
    } as AeRoleTable;
    expect(aeModelUpdates(roles, CATALOGS).some((u) => u.key === "planner")).toBe(false);
  });

  it("finds a Codex reviewer slot and keeps an effort the new model offers", () => {
    const roles = {
      ...ROLES,
      reviewer: {
        mode: "multi",
        reviewers: [
          { mode: "fixed", model: "claude-sonnet-5-6", effort: "medium" },
          codexSlot("gpt-5.6-sol", "xhigh"),
        ],
      },
    } as AeRoleTable;
    const update = aeModelUpdates(roles, CATALOGS).find((u) => u.key === "reviewer:1");
    expect(update).toMatchObject({
      fromLabel: "GPT-5.6-Sol",
      toLabel: "GPT-6-Sol",
      toModel: "gpt-6-sol",
      effort: "xhigh",
      effortFallback: null,
    });
  });

  it("falls back to the new model's default when it lacks the effort, and says so", () => {
    const catalogs = {
      ...CATALOGS,
      codex: [
        codexRow("GPT-6-Luna", levels("low", "medium", "high"), "medium"),
        codexRow("GPT-5.6-Luna"),
      ],
    };
    const roles = {
      ...ROLES,
      reviewer: { mode: "multi", reviewers: [codexSlot("gpt-5.6-luna", "max")] },
    } as AeRoleTable;
    const update = aeModelUpdates(roles, catalogs).find((u) => u.key === "reviewer:0");
    expect(update).toMatchObject({ key: "reviewer:0", effort: "medium", effortFallback: "medium" });
  });

  it("leaves a Codex slot on the host default effort alone", () => {
    const roles = {
      ...ROLES,
      reviewer: { mode: "multi", reviewers: [codexSlot("gpt-5.6-sol", null)] },
    } as AeRoleTable;
    expect(aeModelUpdates(roles, CATALOGS).find((u) => u.key === "reviewer:0")).toMatchObject({
      effort: null,
      effortFallback: null,
    });
  });

  it("gives no chip to a Codex slot on the host default model, or one the host does not list", () => {
    const roles = {
      ...ROLES,
      reviewer: {
        mode: "multi",
        reviewers: [codexSlot(null, "high"), codexSlot("gpt-3-sol", "low")],
      },
    } as AeRoleTable;
    expect(
      aeModelUpdates(roles, { ...CATALOGS, claude: [] }).some((u) => u.role === "reviewer"),
    ).toBe(false);
  });

  it("gives no Codex chip while the host list is still loading", () => {
    const roles = {
      ...ROLES,
      reviewer: { mode: "multi", reviewers: [codexSlot("gpt-5.6-sol", "high")] },
    } as AeRoleTable;
    expect(aeModelUpdates(roles, { claude: [], codex: [] })).toEqual([]);
  });
});

describe("aeApplyUpdate", () => {
  it("changes the model and keeps the effort", () => {
    const [planner] = aeModelUpdates(ROLES, CATALOGS);
    const next = aeApplyUpdate(ROLES, planner);
    expect(next.planner).toEqual({ mode: "fixed", model: "claude-opus-5-6", effort: "high" });
    expect(next.builder).toBe(ROLES.builder);
  });

  it("changes one reviewer slot and no other", () => {
    const roles = {
      ...ROLES,
      reviewer: {
        mode: "multi",
        reviewers: [
          { mode: "fixed", model: "claude-sonnet-5-5", effort: "low" },
          codexSlot("gpt-5.6-sol", "medium"),
        ],
      },
    } as AeRoleTable;
    const update = aeModelUpdates(roles, CATALOGS).find((u) => u.key === "reviewer:1");
    if (!update) throw new Error("no update");
    const next = aeApplyUpdate(roles, update);
    expect(aeRowAt(next, "reviewer:1")).toMatchObject({ model: "gpt-6-sol", effort: "medium" });
    expect(aeRowAt(next, "reviewer:0")).toEqual(aeRowAt(roles, "reviewer:0"));
  });

  it("leaves a row that changed since the update was found", () => {
    const [planner] = aeModelUpdates(ROLES, CATALOGS);
    const edited = aeWithRow(ROLES, "planner", {
      mode: "fixed",
      model: "claude-haiku-5-5",
      effort: "low",
    });
    expect(aeApplyUpdate(edited, planner)).toBe(edited);
  });

  it("restores the old row with aeWithRow", () => {
    const [planner] = aeModelUpdates(ROLES, CATALOGS);
    const before = aeRowAt(ROLES, "planner");
    if (!before) throw new Error("no row");
    const back = aeWithRow(aeApplyUpdate(ROLES, planner), "planner", before);
    expect(back).toEqual(ROLES);
  });
});
