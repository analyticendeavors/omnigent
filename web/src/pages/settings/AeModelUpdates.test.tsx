import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AE_SETTING_HINTS, AE_HINT_MAX, type AeSettingHintId } from "@/lib/aeSettingHints";
import type { AeRolePreset, AeRoleTable } from "@/lib/aeRoles";
import type { AeTeamOption } from "@/lib/aeTeamOptions";
import type * as AeTablerIconModule from "@/lib/aeTablerIcon";
import { AeRolesEditor, type AeRoleDraft } from "./AeRolesEditor";

const catalog = vi.hoisted(() => ({ rows: [] as unknown[] }));
const codexAgent = vi.hoisted(
  () =>
    ({ id: "codex-id", name: "Codex", display_name: "Codex", harness: "codex-native" }) as never,
);
vi.mock("@/hooks/useAeReviewerAgents", () => ({
  useAeReviewerAgents: () => ({
    options: [
      {
        agent: codexAgent,
        name: "Codex",
        readiness: { state: "available", reason: "ready", selectable: true },
        recommendation: null,
        primary: true,
      } as unknown as AeTeamOption,
    ],
    host: { host_id: "h1", status: "online" },
    loaded: true,
  }),
}));
vi.mock("@/hooks/useHosts", () => ({
  useHostModelOptions: () => ({ data: catalog.rows, isError: false, isFetching: false }),
}));
vi.mock("@/lib/aeTablerIcon", async (importOriginal) => ({
  ...(await importOriginal<typeof AeTablerIconModule>()),
  AeProjectIconGlyph: () => null,
}));

const levels = (...names: string[]) => names.map((reasoningEffort) => ({ reasoningEffort }));
const codexModel = (
  displayName: string,
  supported = levels("low", "medium", "high", "xhigh", "max"),
) => ({
  id: displayName.toLowerCase(),
  model: displayName.toLowerCase(),
  displayName,
  supportedReasoningEfforts: supported,
  defaultReasoningEffort: "medium",
});

// Stand-ins for a future release: Opus 5.6 and Sonnet 5.6 in the catalog, 5.5 in the preset.
const MODELS = [
  "claude-opus-5-6",
  "claude-opus-5-5",
  "claude-sonnet-5-6",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
].map((value) => ({ value, label: value }));
const ROLES = {
  lead: { mode: "session" },
  planner: { mode: "fixed", model: "claude-opus-5-5", effort: "high" },
  reviewer: {
    mode: "multi",
    reviewers: [
      { mode: "fixed", model: "claude-haiku-5-5", effort: "low" },
      {
        mode: "agent",
        agent: "codex-id",
        agent_name: "Codex",
        name: "Codex",
        model: "gpt-5.6-sol",
        effort: "max",
      },
    ],
  },
  builder: { mode: "fixed", model: "claude-sonnet-5-5", effort: "medium" },
  helper: { mode: "auto" },
} as AeRoleTable;
const PRESET: AeRolePreset = {
  id: "balanced",
  title: "Balanced",
  icon: "tabler:scale",
  color: "teal",
  description: "",
  when_to_use: "",
  pinned: false,
  roles: ROLES,
  rules: { raise_or_lower: "tell", lead_steps_down: true, auto_raises: 1 },
};

let latest: AeRoleDraft;
function Editor({ roles = ROLES }: { roles?: AeRoleTable }) {
  const [draft, setDraft] = useState<AeRoleDraft>({ roles, rules: PRESET.rules });
  latest = draft;
  return (
    <AeRolesEditor
      preset={PRESET}
      draft={draft}
      isDefault={false}
      isStarter={false}
      models={MODELS}
      catalogNote={null}
      topTier={false}
      dirty={false}
      saving={false}
      canDelete
      onChange={setDraft}
      onRevert={() => {}}
      onSave={() => {}}
      onMakeDefault={() => {}}
      onEdit={() => {}}
      onDuplicate={() => {}}
      onDelete={() => {}}
    />
  );
}

beforeEach(() => {
  catalog.rows = [
    codexModel("GPT-6-Astra"),
    codexModel("GPT-6-Sol"),
    codexModel("GPT-6-Luna", levels("low", "medium", "high")),
    codexModel("GPT-5.6-Sol"),
  ];
});
afterEach(cleanup);

/** The model picker's trigger for a role row. */
const modelTrigger = (role: string) =>
  screen.getByRole("button", { name: new RegExp(`^${role} model`) });

describe("the update nudge in the preset editor", () => {
  it("shows a banner and a chip on each row with a newer model in its family", () => {
    render(<Editor />);
    expect(screen.getByTestId("ae-model-update-banner")).toHaveTextContent(
      "3 newer models for this preset: Opus 5.6, GPT-6-Sol, Sonnet 5.6",
    );
    expect(screen.getByTestId("ae-model-chip-planner")).toHaveTextContent("Opus 5.6");
    expect(screen.getByTestId("ae-model-chip-builder")).toHaveTextContent("Sonnet 5.6");
    expect(screen.getByTestId("ae-model-chip-reviewer:1")).toHaveTextContent("GPT-6-Sol");
    // Haiku has no newer model, Lead is Session and Helper is Auto.
    expect(screen.queryByTestId("ae-model-chip-reviewer:0")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ae-model-chip-lead")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ae-model-chip-helper")).not.toBeInTheDocument();
  });

  it("shows nothing when every row is on its newest model", () => {
    render(
      <Editor
        roles={{
          ...ROLES,
          planner: { mode: "fixed", model: "claude-opus-5-6", effort: "high" },
          builder: { mode: "fixed", model: "claude-sonnet-5-6", effort: "medium" },
          reviewer: { mode: "fixed", model: "claude-haiku-5-5", effort: "low" },
        }}
      />,
    );
    expect(screen.queryByTestId("ae-model-update-banner")).not.toBeInTheDocument();
    expect(screen.queryByText("Update")).not.toBeInTheDocument();
  });

  it("changes nothing until a click", () => {
    render(<Editor />);
    expect(latest.roles).toEqual(ROLES);
  });

  it("updates the model only, keeps the effort, and offers Undo in place of the chip", () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Update Planner to Opus 5.6" }));
    expect(latest.roles.planner).toEqual({
      mode: "fixed",
      model: "claude-opus-5-6",
      effort: "high",
    });
    const done = screen.getByTestId("ae-model-updated-planner");
    expect(done).toHaveTextContent("Was Opus 5.5");
    expect(screen.queryByTestId("ae-model-chip-planner")).not.toBeInTheDocument();
    expect(screen.getByTestId("ae-model-update-banner")).toHaveTextContent("2 newer models");
    fireEvent.click(within(done).getByRole("button", { name: "Undo the update of Planner" }));
    expect(latest.roles).toEqual(ROLES);
    expect(screen.getByTestId("ae-model-chip-planner")).toBeInTheDocument();
  });

  it("moves a Codex reviewer, keeping an effort the new model offers", () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Update Reviewer 2 to GPT-6-Sol" }));
    expect(latest.roles.reviewer).toMatchObject({
      reviewers: [expect.anything(), { model: "gpt-6-sol", effort: "max" }],
    });
  });

  it("says so in the chip when the new model lacks the effort and falls back to its default", () => {
    catalog.rows = [
      codexModel("GPT-6-Sol", levels("low", "medium", "high")),
      codexModel("GPT-5.6-Sol"),
    ];
    render(<Editor />);
    const chip = screen.getByTestId("ae-model-chip-reviewer:1");
    expect(chip).toHaveTextContent("GPT-6-Sol, effort Medium");
    fireEvent.click(within(chip).getByRole("button", { name: /Update Reviewer 2/ }));
    expect(latest.roles.reviewer).toMatchObject({
      reviewers: [expect.anything(), { model: "gpt-6-sol", effort: "medium" }],
    });
    expect(screen.getByTestId("ae-model-updated-reviewer:1")).toHaveTextContent(
      "Was GPT-5.6-Sol, effort now Medium",
    );
  });

  it("lists what Update all will change, applies every update, and one Undo all reverts the batch", () => {
    render(<Editor />);
    const all = screen.getByTestId("ae-model-update-all");
    expect(all).toHaveAccessibleName(
      "Update all: Opus 5.5 to Opus 5.6, GPT-5.6-Sol to GPT-6-Sol, Sonnet 5.5 to Sonnet 5.6",
    );
    fireEvent.click(all);
    expect(latest.roles.planner).toMatchObject({ model: "claude-opus-5-6", effort: "high" });
    expect(latest.roles.builder).toMatchObject({ model: "claude-sonnet-5-6" });
    expect(screen.queryByTestId("ae-model-update-all")).not.toBeInTheDocument();
    expect(screen.getByTestId("ae-model-update-batch")).toHaveTextContent(
      "Updated 3 models: Opus 5.5 to Opus 5.6, GPT-5.6-Sol to GPT-6-Sol, Sonnet 5.5 to Sonnet 5.6",
    );
    fireEvent.click(screen.getByTestId("ae-model-undo-all"));
    expect(latest.roles).toEqual(ROLES);
    expect(screen.getByTestId("ae-model-update-all")).toBeInTheDocument();
  });

  it("drops a row from the batch when its own Undo is used", () => {
    render(<Editor />);
    fireEvent.click(screen.getByTestId("ae-model-update-all"));
    fireEvent.click(screen.getByRole("button", { name: "Undo the update of Builder" }));
    expect(latest.roles.builder).toEqual(ROLES.builder);
    expect(screen.getByTestId("ae-model-update-batch")).toHaveTextContent("Updated 2 models");
  });

  it("offers Codex for a Planner but only Claude models and the session for the Lead", () => {
    render(<Editor />);
    fireEvent.click(modelTrigger("Planner"));
    const planner = within(screen.getByRole("tree"));
    expect(planner.getByText("Run through Codex, as a child session")).toBeInTheDocument();
    expect(planner.queryByText("Other agents")).not.toBeInTheDocument();
    fireEvent.click(planner.getByRole("treeitem", { name: "GPT-6-Sol" }));
    expect(latest.roles.planner).toMatchObject({
      mode: "agent",
      agent: "16a06503889b0c3034496821afd41b9e",
      agent_name: "codex-native-ui",
      name: "Codex",
      model: "gpt-6-sol",
    });
    fireEvent.click(modelTrigger("Lead"));
    const lead = within(screen.getByRole("tree"));
    expect(lead.getByRole("treeitem", { name: "Session model" })).toBeInTheDocument();
    expect(lead.getByText("Claude models")).toBeInTheDocument();
    expect(lead.queryByText("Run through Codex, as a child session")).not.toBeInTheDocument();
  });

  it("drops the Updated note when the row is changed by hand afterwards", () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Update Planner to Opus 5.6" }));
    fireEvent.click(modelTrigger("Planner"));
    fireEvent.click(screen.getAllByRole("treeitem", { name: /^Older models, collapsed/ })[0]);
    fireEvent.click(screen.getByRole("treeitem", { name: /haiku/i }));
    expect(screen.queryByTestId("ae-model-updated-planner")).not.toBeInTheDocument();
  });

  it("gives every nudge control a hint within the limit", () => {
    render(<Editor />);
    const ids = (Object.keys(AE_SETTING_HINTS) as AeSettingHintId[]).filter((id) =>
      id.startsWith("nudge."),
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(screen.queryAllByTestId(`ae-hint-${id}`).length, id).toBeGreaterThan(0);
      expect(AE_SETTING_HINTS[id].hint.length, id).toBeLessThanOrEqual(AE_HINT_MAX);
    }
  });

  it("undoes the model only: an effort changed after Update stays", () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Update Planner to Opus 5.6" }));
    const planner = screen.getByRole("radiogroup", { name: "Planner effort" });
    fireEvent.click(within(planner).getByRole("radio", { name: "Low" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo the update of Planner" }));
    expect(latest.roles.planner).toEqual({
      mode: "fixed",
      model: "claude-opus-5-5",
      effort: "low",
    });
  });

  it("undoes the effort too when Update left it as it is", () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Update Reviewer 2 to GPT-6-Sol" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo the update of Reviewer 2" }));
    expect(latest.roles.reviewer).toMatchObject({
      reviewers: [expect.anything(), { model: "gpt-5.6-sol", effort: "max" }],
    });
  });

  it("restores the old effort when the new model had moved it to its default", () => {
    catalog.rows = [
      codexModel("GPT-6-Sol", levels("low", "medium", "high")),
      codexModel("GPT-5.6-Sol"),
    ];
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Update Reviewer 2 to GPT-6-Sol" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo the update of Reviewer 2" }));
    expect(latest.roles.reviewer).toMatchObject({
      reviewers: [expect.anything(), { model: "gpt-5.6-sol", effort: "max" }],
    });
  });

  describe("with three reviewers", () => {
    const THREE = {
      ...ROLES,
      reviewer: {
        mode: "multi",
        reviewers: [
          { mode: "fixed", model: "claude-haiku-5-5", effort: "low" },
          (ROLES.reviewer as { reviewers: unknown[] }).reviewers[1],
          { mode: "fixed", model: "claude-sonnet-5-5", effort: "high" },
        ],
      },
    } as AeRoleTable;

    it("moves an Undo with its slot when an earlier reviewer is removed", () => {
      render(<Editor roles={THREE} />);
      fireEvent.click(screen.getByRole("button", { name: "Update Reviewer 2 to GPT-6-Sol" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove Reviewer 1" }));
      expect(screen.getByTestId("ae-model-updated-reviewer:0")).toHaveTextContent(
        "Was GPT-5.6-Sol",
      );
      expect(screen.queryByTestId("ae-model-updated-reviewer:1")).not.toBeInTheDocument();
      expect(screen.getByTestId("ae-model-chip-reviewer:1")).toBeInTheDocument();
    });

    it("drops the Undo when the updated reviewer is removed, and gives none to the next one", () => {
      render(<Editor roles={THREE} />);
      fireEvent.click(screen.getByRole("button", { name: "Update Reviewer 2 to GPT-6-Sol" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove Reviewer 2" }));
      expect(screen.queryByText(/^Was /)).not.toBeInTheDocument();
      // The slot that moved up into place 2 is Sonnet 5.5 and still offers its own Update.
      expect(screen.getByTestId("ae-model-chip-reviewer:1")).toHaveTextContent("Sonnet 5.6");
      expect(screen.queryByTestId("ae-model-updated-reviewer:1")).not.toBeInTheDocument();
    });
  });

  it("moves focus to the Undo button and announces the change politely", () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Update Planner to Opus 5.6" }));
    expect(screen.getByRole("button", { name: "Undo the update of Planner" })).toHaveFocus();
    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("Planner updated to Opus 5.6");
    fireEvent.click(screen.getByTestId("ae-model-update-all"));
    expect(screen.getByRole("status")).toHaveTextContent("2 models updated");
    fireEvent.click(screen.getByTestId("ae-model-undo-all"));
    expect(screen.getByRole("status")).toHaveTextContent("2 models restored");
  });

  it("gives Update and Undo a wider tap area than the chip", () => {
    render(<Editor />);
    expect(screen.getByRole("button", { name: "Update Planner to Opus 5.6" }).className).toContain(
      "after:-inset-y-1",
    );
  });

  it("puts the banner in the preset's header row, not above the roles", () => {
    render(<Editor />);
    const banner = screen.getByTestId("ae-model-update-banner");
    expect(banner.parentElement).toContainElement(
      screen.getByRole("heading", { name: "Balanced" }),
    );
    expect(
      within(screen.getByRole("group", { name: "Roles" })).queryByTestId("ae-model-update-banner"),
    ).toBeNull();
  });

  it("offers the plain id and says so when a 1M row has no 1M update", () => {
    render(
      <Editor
        roles={{
          ...ROLES,
          planner: { mode: "fixed", model: "claude-opus-5-5[1m]", effort: "high" },
        }}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: /Update Planner to Opus 5.6. 1M context variant not available/,
      }),
    ).toBeInTheDocument();
  });

  it("stores ultra for a Codex reviewer that moves to a model offering it", () => {
    catalog.rows = [
      codexModel("GPT-6-Sol", levels("low", "medium", "high", "xhigh", "max", "ultra")),
      codexModel("GPT-5.6-Sol"),
    ];
    render(
      <Editor
        roles={
          {
            ...ROLES,
            reviewer: {
              mode: "multi",
              reviewers: [
                {
                  mode: "agent",
                  agent: "codex-id",
                  agent_name: "Codex",
                  name: "Codex",
                  model: "gpt-5.6-sol",
                  effort: "ultra",
                },
              ],
            },
          } as AeRoleTable
        }
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Update Reviewer to GPT-6-Sol" }));
    expect(latest.roles.reviewer).toMatchObject({
      reviewers: [{ model: "gpt-6-sol", effort: "ultra" }],
    });
  });
});
