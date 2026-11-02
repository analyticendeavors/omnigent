import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailableAgent } from "@/hooks/useAvailableAgents";
import { AE_CODEX_AGENT_ID, type AeReviewerSetting } from "@/lib/aeReviewers";
import type { AePersonaEntry } from "@/lib/aePersonas";
import { AE_SETTING_HINTS } from "@/lib/aeSettingHints";
import type { AeRoleRules } from "@/lib/aeRoles";
import type { AeTeamOption } from "@/lib/aeTeamOptions";
import { AeReviewerRowsView, AeReviewSettings } from "./AeReviewerRows";

vi.mock("@/hooks/useAeReviewerAgents", () => ({
  useAeReviewerAgents: () => ({ options: [], host: null, loaded: false }),
}));
const catalog = vi.hoisted(() => ({ rows: [] as unknown[], pending: false, error: false }));
vi.mock("@/hooks/useHosts", () => ({
  useHostModelOptions: () => ({
    data: catalog.pending || catalog.error ? undefined : catalog.rows,
    isError: catalog.error,
    isFetching: false,
  }),
}));

/** Opens a picker and returns its list. */
const openList = (trigger: HTMLElement) => {
  fireEvent.click(trigger);
  return screen.getByRole("tree");
};
/** Picks the option with this name in an open list. */
const pickOption = (list: HTMLElement, name: string) =>
  fireEvent.click(within(list).getByRole("treeitem", { name }));

const efforts = (...names: string[]) => names.map((reasoningEffort) => ({ reasoningEffort }));
const FIVE = efforts("low", "medium", "high", "xhigh", "max");
const SIX = efforts("low", "medium", "high", "xhigh", "max", "ultra");
const codexModel = (displayName: string, supported = FIVE, extra = {}) => ({
  id: displayName.toLowerCase(),
  model: displayName.toLowerCase(),
  displayName,
  supportedReasoningEfforts: supported,
  defaultReasoningEffort: "medium",
  ...extra,
});
// The host's real list: three GPT-6 models and three older GPT-5.6 ones.
const HOST_MODELS = [
  codexModel("GPT-6-Astra", SIX),
  codexModel("GPT-6-Sol", SIX),
  codexModel("GPT-6-Luna"),
  codexModel("GPT-5.6-Sol", SIX, { isDefault: true, defaultReasoningEffort: "low" }),
  codexModel("GPT-5.6-Terra", SIX),
  codexModel("GPT-5.6-Luna"),
];

const models = [
  { value: "claude-opus-5-5", label: "Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
];
const agent = (id: string, name: string, harness: string): AvailableAgent =>
  ({ id, name, display_name: name, description: null, harness, skills: [] }) as AvailableAgent;
const ready = (a: AvailableAgent): AeTeamOption => ({
  agent: a,
  name: a.display_name,
  readiness: { state: "available", reason: "ready", selectable: true } as AeTeamOption["readiness"],
  recommendation: "Recommended: different provider for independent review.",
  primary: true,
});
const setup = (a: AvailableAgent): AeTeamOption => ({
  agent: a,
  name: a.display_name,
  readiness: {
    state: "setup-required",
    reason: "needs-auth",
    selectable: false,
  } as AeTeamOption["readiness"],
  recommendation: null,
  primary: true,
});
const codex = agent("codex-id", "Codex", "codex-native");
const gemini = agent("gemini-id", "Gemini CLI", "gemini");
const defaultOptions = [ready(codex), setup(gemini)];

const NONE: AePersonaEntry[] = [];

function Harness({
  initial,
  options = defaultOptions,
  hostStatus = "online",
  personas = NONE,
  onSave,
}: {
  initial: AeReviewerSetting;
  options?: AeTeamOption[];
  hostStatus?: string;
  personas?: AePersonaEntry[];
  onSave: (value: AeReviewerSetting) => void;
}) {
  const [value, setValue] = useState(initial);
  const [rules, setRules] = useState<AeRoleRules>({
    raise_or_lower: "tell",
    lead_steps_down: true,
    auto_raises: 1,
  });
  return (
    <>
      <AeReviewerRowsView
        setting={value}
        models={models}
        disabled={false}
        personas={personas}
        agents={{ options, host: { host_id: "h1", status: hostStatus } as never, loaded: true }}
        onChange={(next) => {
          setValue(next);
          onSave(next);
        }}
      />
      <AeReviewSettings
        reviewer={value}
        rules={rules}
        disabled={false}
        onChange={(r) => setRules({ ...rules, ...r })}
      />
    </>
  );
}

beforeEach(() => {
  catalog.rows = HOST_MODELS;
  catalog.pending = false;
  catalog.error = false;
});

const sonnet = { mode: "fixed" as const, model: "claude-sonnet-5-5", effort: "medium" as const };

describe("AeReviewerRows", () => {
  it("gives the reviewer rows and both review rules a hint icon", () => {
    const rules: AeRoleRules = { raise_or_lower: "tell", lead_steps_down: true, auto_raises: 1 };
    render(
      <>
        <AeReviewerRowsView
          setting={{ mode: "multi", reviewers: [sonnet, sonnet] }}
          models={[]}
          onChange={() => {}}
          disabled={false}
          agents={{ options: [], host: null, loaded: true }}
        />
        <AeReviewSettings
          reviewer={{ mode: "multi", reviewers: [sonnet, sonnet] }}
          rules={rules}
          disabled={false}
          onChange={() => {}}
        />
      </>,
    );
    for (const id of ["roles.reviewer", "rules.review_merge", "rules.reviewer_unavailable"]) {
      expect(screen.getByTestId(`ae-hint-${id}`), id).toBeInTheDocument();
    }
  });

  it("renders an old single reviewer as one row and keeps its shape on an effort edit", () => {
    const onSave = vi.fn();
    render(<Harness initial={sonnet} onSave={onSave} />);
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove Reviewer/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("ae-review-settings")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "High" }));
    expect(onSave).toHaveBeenLastCalledWith({ ...sonnet, effort: "high" });
  });

  it("adds up to three reviewers, then the add link gives way to the hint", () => {
    const onSave = vi.fn();
    render(<Harness initial={sonnet} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /Add reviewer/ }));
    expect(onSave).toHaveBeenLastCalledWith({
      mode: "multi",
      reviewers: [
        sonnet,
        {
          mode: "agent",
          agent: "codex-id",
          agent_name: "Codex",
          name: "Codex",
          model: "gpt-6-sol",
          effort: "medium",
        },
      ],
    });
    expect(screen.getByText("Reviewers")).toBeInTheDocument();
    expect(screen.getByTestId("ae-review-settings")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add reviewer/ }));
    expect(screen.queryByRole("button", { name: /Add reviewer/ })).not.toBeInTheDocument();
    expect(screen.getByText("3 of 3 reviewers. Remove one to add another.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Remove Reviewer/ })).toHaveLength(3);
  });

  it("adds Codex by its built-in id when no agent is recommended (Settings has no lead)", () => {
    const onSave = vi.fn();
    const builtin = agent(AE_CODEX_AGENT_ID, "Codex", "codex-native");
    const options = [
      { ...ready(agent("cc", "Claude Code", "claude-native")), recommendation: null },
    ];
    options.push({ ...ready(builtin), recommendation: null });
    render(<Harness initial={sonnet} options={options} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /Add reviewer/ }));
    expect(onSave).toHaveBeenLastCalledWith({
      mode: "multi",
      reviewers: [
        sonnet,
        {
          mode: "agent",
          agent: AE_CODEX_AGENT_ID,
          agent_name: "Codex",
          name: "Codex",
          model: "gpt-6-sol",
          effort: "medium",
        },
      ],
    });
  });

  it("removes a reviewer back to the plain single setting", () => {
    const onSave = vi.fn();
    render(
      <Harness
        initial={{
          mode: "multi",
          reviewers: [
            sonnet,
            { mode: "agent", agent: "codex-id", name: "Codex", model: null, effort: null },
          ],
        }}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove Reviewer 2" }));
    expect(onSave).toHaveBeenLastCalledWith(sonnet);
    expect(screen.queryByTestId("ae-review-settings")).not.toBeInTheDocument();
  });

  it("lists agents in the slot picker, greys those needing setup, and picks one", () => {
    const onSave = vi.fn();
    render(<Harness initial={sonnet} onSave={onSave} />);
    const list = openList(screen.getByRole("button", { name: /^Reviewer model/ }));
    expect(within(list).getByRole("treeitem", { name: /^Gemini CLI/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(list).getByRole("treeitem", { name: /^Gemini CLI/ })).toHaveTextContent(
      "needs setup",
    );
    expect(
      within(list).getByRole("treeitem", { name: "Auto (the lead picks)" }),
    ).toBeInTheDocument();
    pickOption(list, "GPT-6-Astra");
    expect(onSave).toHaveBeenLastCalledWith({
      mode: "multi",
      reviewers: [
        {
          mode: "agent",
          agent: "codex-id",
          agent_name: "Codex",
          name: "Codex",
          model: "gpt-6-astra",
          effort: "medium",
        },
      ],
    });
    expect(screen.queryByRole("combobox", { name: "Reviewer 1 effort" })).not.toBeInTheDocument();
  });

  it("offers Auto only on slot 1 and tags an agent that needs setup", () => {
    render(
      <Harness
        initial={{
          mode: "multi",
          reviewers: [
            sonnet,
            { mode: "agent", agent: "gemini-id", name: "Gemini CLI", model: null, effort: null },
          ],
        }}
        onSave={vi.fn()}
      />,
    );
    const second = screen.getAllByRole("button", { name: /^Reviewer 2 model/ })[0];
    expect(within(openList(second)).queryByRole("treeitem", { name: /Auto/ })).toBeNull();
    expect(screen.getByTestId("ae-reviewer-tag-2")).toHaveTextContent("Needs setup");
    expect(screen.getByRole("link", { name: "Set up" })).toHaveAttribute(
      "href",
      "/settings/harnesses/gemini",
    );
  });

  it("says an agent reviewer does not run when Helpers is own subagents only", () => {
    const codexSlot = {
      mode: "agent" as const,
      agent: "codex-id",
      name: "Codex",
      model: null,
      effort: null,
    };
    const own: AeRoleRules = {
      raise_or_lower: "tell",
      lead_steps_down: true,
      auto_raises: 1,
      helpers: "own",
    };
    const { rerender } = render(
      <AeReviewSettings
        reviewer={{ mode: "multi", reviewers: [codexSlot] }}
        rules={own}
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("ae-review-own-note")).toHaveTextContent(
      "Helpers is set to own subagents only, so Codex does not run.",
    );
    expect(screen.queryByTestId("ae-review-settings")).not.toBeInTheDocument();
    rerender(
      <AeReviewSettings
        reviewer={{ mode: "multi", reviewers: [sonnet, codexSlot] }}
        rules={{ ...own, helpers: "any" }}
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByTestId("ae-review-own-note")).not.toBeInTheDocument();
    expect(screen.getByTestId("ae-review-settings")).toBeInTheDocument();
  });

  it("keeps the model and effort dropdowns for an agent that is not Codex", () => {
    render(
      <Harness
        initial={{
          mode: "multi",
          reviewers: [
            sonnet,
            { mode: "agent", agent: "gemini-id", name: "Gemini CLI", model: null, effort: null },
          ],
        }}
        options={[ready(codex), ready(gemini)]}
        onSave={vi.fn()}
      />,
    );
    const effort = screen.getByRole("combobox", { name: "Reviewer 2 effort" });
    expect(effort).toHaveValue("");
    expect(Array.from(effort.querySelectorAll("option")).map((o) => o.value)).toEqual([
      "",
      "low",
      "medium",
      "high",
    ]);
    expect(screen.getByText("Agent default model")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Reviewer 2 effort" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("ae-reviewer-tool-2")).not.toBeInTheDocument();
  });

  it("finds a stored Codex slot by registered name when the id differs", () => {
    const live = agent("live-codex-id", "codex-native-ui", "codex-native");
    render(
      <Harness
        initial={{
          mode: "multi",
          reviewers: [
            sonnet,
            {
              mode: "agent",
              agent: "random-seeded-id",
              agent_name: "codex-native-ui",
              name: "Codex",
              model: "gpt-6-sol",
              effort: "high",
            },
          ],
        }}
        options={[{ ...ready(live), name: "Codex" }]}
        onSave={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("ae-reviewer-tag-2")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Reviewer 2 model/ })).toHaveTextContent(
      "GPT-6-Sol",
    );
  });
});

describe("Codex reviewers in the one dropdown", () => {
  const codexSlot = (model: string | null, effort: string | null) => ({
    mode: "multi" as const,
    reviewers: [
      sonnet,
      { mode: "agent" as const, agent: "codex-id", name: "Codex", model, effort } as never,
    ],
  });
  const second = () => screen.getByRole("button", { name: /^Reviewer 2 model/ });
  const barOf = () =>
    within(screen.getByRole("radiogroup", { name: "Reviewer 2 effort" })).getAllByRole("radio");

  it("lists the three latest Codex models by the host's names, with no versions or notes", () => {
    render(<Harness initial={codexSlot("gpt-6-sol", "high")} onSave={vi.fn()} />);
    expect(second()).toHaveTextContent("GPT-6-Sol");
    const list = openList(second());
    const codexNames = within(list)
      .getAllByRole("treeitem")
      .map((o) => o.textContent)
      .filter((t) => t?.startsWith("GPT-6"));
    expect(codexNames).toEqual(["GPT-6-Astra", "GPT-6-Sol", "GPT-6-Luna"]);
    expect(within(list).getByText("Run through Claude, as a subagent")).toBeInTheDocument();
    expect(
      within(list).getByRole("treeitem", { name: /^Older models, collapsed/ }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("ae-reviewer-tool-2")).toHaveTextContent("Codex");
    expect(screen.queryByTestId("ae-reviewer-tool-1")).not.toBeInTheDocument();
  });

  it("shows the bar with the steps the model offers, up to the levels a preset can store", () => {
    const { unmount } = render(
      <Harness initial={codexSlot("gpt-6-luna", "low")} onSave={vi.fn()} />,
    );
    expect(barOf().map((r) => r.getAttribute("aria-label"))).toEqual([
      "Low",
      "Medium",
      "High",
      "Extra",
      "Max",
    ]);
    unmount();
    catalog.rows = [codexModel("GPT-6-Luna", efforts("low", "medium", "high"))];
    render(<Harness initial={codexSlot("gpt-6-luna", "low")} onSave={vi.fn()} />);
    expect(barOf()).toHaveLength(3);
  });

  it("shows the host's default model by name for a slot saved without one", () => {
    render(<Harness initial={codexSlot(null, null)} onSave={vi.fn()} />);
    expect(second()).toHaveTextContent("GPT-5.6-Sol");
    // The default model is an older one, so the Codex fold opens on it.
    const list = openList(second());
    expect(within(list).getByRole("treeitem", { name: "GPT-5.6-Sol" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The default model's own default effort is the one filled.
    expect(barOf().filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
    expect(barOf()[0]).toHaveAttribute("aria-checked", "true");
  });

  it("shows the name of an older saved model, and says Codex until the list loads", () => {
    const { unmount } = render(
      <Harness initial={codexSlot("gpt-5.6-terra", "max")} onSave={vi.fn()} />,
    );
    expect(second()).toHaveTextContent("GPT-5.6-Terra");
    expect(
      within(openList(second())).getByRole("treeitem", { name: "GPT-5.6-Terra" }),
    ).toBeInTheDocument();
    unmount();
    catalog.pending = true;
    render(<Harness initial={codexSlot(null, null)} onSave={vi.fn()} />);
    expect(second()).toHaveTextContent("Codex, default model");
    const list = openList(second());
    expect(
      within(list).getByRole("treeitem", { name: "Codex, default model" }),
    ).toBeInTheDocument();
    expect(within(list).getByRole("treeitem", { name: "Loading Codex models" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.queryByText("GPT-6-Sol")).not.toBeInTheDocument();
  });

  it("shows a stored effort the model no longer offers as an extra step marked unavailable", () => {
    const onSave = vi.fn();
    catalog.rows = [codexModel("GPT-6-Luna", efforts("low", "medium", "high"))];
    render(<Harness initial={codexSlot("gpt-6-luna", "max")} onSave={onSave} />);
    const on = barOf().filter((r) => r.getAttribute("aria-checked") === "true");
    expect(on.map((r) => r.getAttribute("aria-label"))).toEqual(["Max (unavailable)"]);
    expect(barOf()).toHaveLength(4);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("moves a Claude row to a Codex model and keeps the effort when the model offers it", () => {
    const onSave = vi.fn();
    render(<Harness initial={{ mode: "multi", reviewers: [sonnet, sonnet] }} onSave={onSave} />);
    pickOption(openList(second()), "GPT-6-Luna");
    expect(onSave).toHaveBeenLastCalledWith({
      mode: "multi",
      reviewers: [
        sonnet,
        {
          mode: "agent",
          agent: "codex-id",
          agent_name: "Codex",
          name: "Codex",
          model: "gpt-6-luna",
          effort: "medium",
        },
      ],
    });
  });

  it("changes the model and the effort through the same two controls", () => {
    const onSave = vi.fn();
    render(<Harness initial={codexSlot("gpt-6-sol", "max")} onSave={onSave} />);
    pickOption(openList(second()), "GPT-6-Luna");
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reviewers: [sonnet, expect.objectContaining({ model: "gpt-6-luna", effort: "max" })],
      }),
    );
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Reviewer 2 effort" })).getByRole("radio", {
        name: "Low",
      }),
    );
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reviewers: [sonnet, expect.objectContaining({ model: "gpt-6-luna", effort: "low" })],
      }),
    );
  });

  it("opens a new Codex reviewer on Sol of the newest generation at its default effort", () => {
    const onSave = vi.fn();
    render(<Harness initial={sonnet} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /Add reviewer/ }));
    expect(onSave).toHaveBeenLastCalledWith({
      mode: "multi",
      reviewers: [
        sonnet,
        expect.objectContaining({ mode: "agent", model: "gpt-6-sol", effort: "medium" }),
      ],
    });
  });

  it("keeps the Codex group out when Codex is not ready, and greys it under Other agents", () => {
    render(<Harness initial={sonnet} options={[setup(codex)]} onSave={vi.fn()} />);
    const list = openList(screen.getByRole("button", { name: /^Reviewer model/ }));
    expect(within(list).queryByText("Run through Codex, as a child session")).toBeNull();
    expect(within(list).getByRole("treeitem", { name: /^Codex/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(list).getByRole("treeitem", { name: /^Codex/ })).toHaveTextContent("needs setup");
  });

  it("shows six steps for a model that offers ultra, and five for one that does not", () => {
    const { unmount } = render(
      <Harness initial={codexSlot("gpt-6-sol", "ultra")} onSave={vi.fn()} />,
    );
    expect(barOf().map((r) => r.getAttribute("aria-label"))).toEqual([
      "Low",
      "Medium",
      "High",
      "Extra",
      "Max",
      "Ultra",
    ]);
    expect(barOf()[5]).toHaveAttribute("aria-checked", "true");
    unmount();
    render(<Harness initial={codexSlot("gpt-6-luna", "high")} onSave={vi.fn()} />);
    expect(barOf()).toHaveLength(5);
  });

  it("starts a new Codex reviewer on ultra when that is the model's default", () => {
    catalog.rows = [codexModel("GPT-6-Sol", SIX, { defaultReasoningEffort: "ultra" })];
    const onSave = vi.fn();
    render(<Harness initial={sonnet} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /Add reviewer/ }));
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reviewers: [sonnet, expect.objectContaining({ model: "gpt-6-sol", effort: "ultra" })],
      }),
    );
  });

  it("names the tool in the dropdown's label for a Codex row", () => {
    render(<Harness initial={codexSlot("gpt-6-sol", "high")} onSave={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Reviewer 2 model, GPT-6-Sol, runs through Codex" }),
    ).toBeInTheDocument();
  });

  it("keeps the saved option when the host is offline, the list is loading or it failed", () => {
    for (const arrange of [
      () => undefined,
      () => {
        catalog.pending = true;
      },
      () => {
        catalog.error = true;
      },
    ]) {
      catalog.rows = HOST_MODELS;
      catalog.pending = false;
      catalog.error = false;
      arrange();
      const { unmount } = render(
        <Harness initial={codexSlot("gpt-6-sol", "high")} hostStatus="offline" onSave={vi.fn()} />,
      );
      expect(second()).toHaveTextContent(/gpt-6-sol/i);
      unmount();
    }
    // Ready but with no list: still its own option, never Auto or the first Claude model.
    catalog.pending = true;
    render(<Harness initial={codexSlot("gpt-6-sol", "high")} onSave={vi.fn()} />);
    expect(second()).toHaveTextContent("gpt-6-sol");
    expect(within(openList(second())).getByRole("treeitem", { selected: true })).toHaveTextContent(
      "gpt-6-sol",
    );
  });

  it("renames the trigger after a pick, and sorts a stored Claude model the catalog lacks", () => {
    render(
      <Harness
        initial={{
          mode: "multi",
          reviewers: [sonnet, { mode: "fixed", model: "claude-opus-4-1", effort: "low" }],
        }}
        onSave={vi.fn()}
      />,
    );
    expect(second()).toHaveAccessibleName("Reviewer 2 model, Opus 4.1");
    const list = openList(second());
    // Older than the newest Opus, so it sits in the fold, which opens for it.
    expect(
      within(list).getByRole("treeitem", { name: /^Older models, expanded/ }),
    ).toBeInTheDocument();
    expect(within(list).getByRole("treeitem", { name: "Opus 4.1" })).toHaveAttribute(
      "aria-level",
      "2",
    );
    pickOption(list, "Opus 5.5");
    expect(second()).toHaveAccessibleName("Reviewer 2 model, Opus 5.5");
  });

  it("explains the Older models fold with a hint in the open list", () => {
    render(<Harness initial={codexSlot("gpt-6-sol", "high")} onSave={vi.fn()} />);
    const list = openList(second());
    expect(screen.getByTestId("ae-hint-reviewer.older")).toBeInTheDocument();
    expect(within(list).queryByTestId("ae-hint-reviewer.older")).toBeNull();
  });

  it("keeps models that do not parse reachable in the Older models fold", () => {
    catalog.rows = [...HOST_MODELS, codexModel("Experimental")];
    render(<Harness initial={codexSlot("gpt-6-sol", "high")} onSave={vi.fn()} />);
    const list = openList(second());
    expect(within(list).queryByRole("treeitem", { name: "Experimental" })).toBeNull();
    fireEvent.click(within(list).getByRole("treeitem", { name: /^Older models, collapsed/ }));
    expect(within(list).getByRole("treeitem", { name: "Experimental" })).toBeInTheDocument();
  });

  it("disables Add reviewer with a reason until the Codex list arrives, and saves no empty pick", () => {
    catalog.pending = true;
    const onSave = vi.fn();
    render(<Harness initial={sonnet} onSave={onSave} />);
    const add = screen.getByRole("button", { name: /Add reviewer/ });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute("title", "Waiting for the Codex model list");
    fireEvent.click(add);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("says why Add reviewer is disabled when the Codex host is offline", () => {
    catalog.rows = [];
    render(<Harness initial={sonnet} hostStatus="offline" onSave={vi.fn()} />);
    const add = screen.getByRole("button", { name: /Add reviewer/ });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute("title", "Codex host is offline");
    expect(add).toHaveTextContent("codex host is offline");
  });

  describe("the persona select", () => {
    const PERSONAS: AePersonaEntry[] = [
      {
        id: "general",
        name: "General",
        purpose: "Correctness",
        model: "claude-sonnet-5-5",
        effort: "medium",
        when: "always",
        instructions: "Review.",
        builtin: true,
      },
      {
        id: "security",
        name: "Security",
        purpose: "Security only",
        model: "claude-opus-5-5",
        effort: "high",
        when: "risky",
        instructions: "Attack paths.",
        builtin: true,
      },
      {
        id: "docs",
        name: "Docs",
        purpose: "Docs match",
        when: "always",
        instructions: "Read the docs.",
        builtin: false,
      },
    ];
    const persona = { mode: "fixed" as const, persona: "security" };
    const two = { mode: "multi" as const, reviewers: [sonnet, sonnet] };

    // The persona picker is the same popover tree as the model picker.
    const picker = (n: number) =>
      screen.getByRole("button", { name: new RegExp(`^Reviewer ${n} persona`) });
    const open = (n: number) => {
      fireEvent.click(picker(n));
      return screen.getByRole("tree", { name: `Reviewer ${n} persona list` });
    };
    const choose = (n: number, name: string) =>
      fireEvent.click(within(open(n)).getByRole("treeitem", { name: new RegExp(`^${name}`) }));

    it("is the model picker's popover on every Claude slot, with a hint, and absent on an Auto slot", () => {
      render(<Harness initial={two} personas={PERSONAS} onSave={vi.fn()} />);
      expect(picker(1)).toHaveAttribute("aria-haspopup", "dialog");
      expect(picker(2)).toHaveAttribute("aria-haspopup", "dialog");
      expect(picker(1)).not.toBeInstanceOf(HTMLSelectElement);
      // One tip beside the Reviewers label, not one per slot.
      expect(screen.getAllByTestId("ae-hint-roles.reviewer")).toHaveLength(1);
      expect(screen.queryByTestId("ae-hint-reviewer.persona")).toBeNull();
      expect(screen.queryByText(/risky personas are off here/)).toBeNull();
    });

    it("lists none, the built-in personas and then the user's own", () => {
      render(<Harness initial={two} personas={PERSONAS} onSave={vi.fn()} />);
      const tree = open(2);
      expect(
        within(tree)
          .getAllByRole("treeitem")
          .map((i) => i.textContent),
      ).toEqual(["No persona", "General", "Security", "Docs"]);
      expect(within(tree).getByRole("group", { name: "Built-in" })).toBeInTheDocument();
      expect(within(tree).getByRole("group", { name: "Yours" })).toBeInTheDocument();
    });

    it("turns off the risky personas on reviewer 1 and says why, but not on reviewer 2", () => {
      render(<Harness initial={two} personas={PERSONAS} onSave={vi.fn()} />);
      const first = within(open(1));
      const risky = first.getByRole("treeitem", { name: /Security/ });
      expect(risky).toHaveAttribute("aria-disabled", "true");
      expect(risky).toHaveTextContent("Securityruns only if risky");
      expect(first.getByRole("treeitem", { name: "General" })).not.toHaveAttribute("aria-disabled");
      fireEvent.keyDown(screen.getByRole("tree"), { key: "Escape" });
      expect(within(open(2)).getByRole("treeitem", { name: "Security" })).not.toHaveAttribute(
        "aria-disabled",
      );
    });

    it("puts the 'always runs' reason in the tip beside the Reviewers label", () => {
      render(<Harness initial={two} personas={PERSONAS} onSave={vi.fn()} />);
      expect(AE_SETTING_HINTS["roles.reviewer"].hint).toMatch(/Reviewer 1 always runs/);
      expect(screen.getAllByRole("button", { name: "About Reviewer" })).toHaveLength(1);
    });

    it("keeps Remove last in the DOM, so Tab goes persona, model, effort, Remove", () => {
      render(<Harness initial={two} personas={PERSONAS} onSave={vi.fn()} />);
      const slot = screen.getByTestId("ae-reviewer-slot-2");
      const stops = Array.from(
        slot.querySelectorAll<HTMLElement>("button, [role=radio], a[href]"),
      ).map((el) => el.getAttribute("aria-label") ?? el.textContent);
      expect(stops[0]).toMatch(/^Reviewer 2 persona/);
      expect(stops[1]).toMatch(/^Reviewer 2 model/);
      expect(stops[stops.length - 1]).toBe("Remove Reviewer 2");
    });

    it("gives a truncatable persona name a tooltip", () => {
      render(
        <Harness
          initial={{ mode: "multi", reviewers: [sonnet, { ...sonnet, persona: "gone-away" }] }}
          personas={PERSONAS}
          onSave={vi.fn()}
        />,
      );
      expect(picker(2)).toHaveAttribute("title", "gone-away (not found)");
    });

    it("shows a when chip on every reviewer: always, or risky diffs", () => {
      render(
        <Harness
          initial={{ mode: "multi", reviewers: [sonnet, persona] }}
          personas={PERSONAS}
          onSave={vi.fn()}
        />,
      );
      expect(screen.getByTestId("ae-reviewer-when-1")).toHaveTextContent("always");
      expect(screen.getByTestId("ae-reviewer-when-2")).toHaveTextContent("risky diffs");
    });

    it("says 'from persona' only when the persona supplies the model", () => {
      render(
        <Harness
          initial={{ mode: "multi", reviewers: [sonnet, persona] }}
          personas={PERSONAS}
          onSave={vi.fn()}
        />,
      );
      expect(screen.getAllByText("Model and effort from the persona")).toHaveLength(1);
    });

    it("writes the persona onto the slot and keeps its model as an override", () => {
      const onSave = vi.fn();
      render(<Harness initial={two} personas={PERSONAS} onSave={onSave} />);
      choose(2, "Security");
      expect(onSave).toHaveBeenLastCalledWith({
        mode: "multi",
        reviewers: [sonnet, { ...sonnet, persona: "security" }],
      });
    });

    it("shows a persona-only slot on the persona's model and writes a model pick as an override", () => {
      const onSave = vi.fn();
      render(
        <Harness
          initial={{ mode: "multi", reviewers: [sonnet, persona] }}
          personas={PERSONAS}
          onSave={onSave}
        />,
      );
      expect(picker(2)).toHaveAccessibleName("Reviewer 2 persona, Security");
      expect(screen.getByRole("button", { name: /^Reviewer 2 model/ })).toHaveTextContent(
        "Opus 5.5",
      );
      fireEvent.click(
        within(screen.getByRole("radiogroup", { name: "Reviewer 2 effort" })).getByRole("radio", {
          name: "Low",
        }),
      );
      expect(onSave).toHaveBeenLastCalledWith({
        mode: "multi",
        reviewers: [
          sonnet,
          { mode: "fixed", persona: "security", model: "claude-opus-5-5", effort: "low" },
        ],
      });
    });

    it("drops the persona on None and keeps the model it was showing", () => {
      const onSave = vi.fn();
      render(
        <Harness
          initial={{ mode: "multi", reviewers: [sonnet, persona] }}
          personas={PERSONAS}
          onSave={onSave}
        />,
      );
      choose(2, "No persona");
      expect(onSave).toHaveBeenLastCalledWith({
        mode: "multi",
        reviewers: [sonnet, { mode: "fixed", model: "claude-opus-5-5", effort: "high" }],
      });
    });

    it("says so when the named persona is gone, and keeps it until changed", () => {
      render(
        <Harness
          initial={{ mode: "multi", reviewers: [sonnet, { ...sonnet, persona: "gone-away" }] }}
          personas={PERSONAS}
          onSave={vi.fn()}
        />,
      );
      expect(picker(2)).toHaveAccessibleName("Reviewer 2 persona, gone-away (not found)");
      const note = screen.getByTestId("ae-reviewer-persona-missing-2");
      expect(note).toHaveTextContent("plain review");
      // The note is tied to its picker, so a screen reader reads it with the control.
      expect(picker(2)).toHaveAttribute("aria-describedby", note.id);
      expect(picker(1)).not.toHaveAttribute("aria-describedby");
      // The note comes right after its picker in the page order, and before the model.
      const after = (a: Element, b: Element) =>
        Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      expect(after(picker(2), note)).toBe(true);
      expect(after(note, screen.getByRole("button", { name: /^Reviewer 2 model/ }))).toBe(true);
    });

    it("removing reviewer 1 drops a risky persona that moves up into its place, and says so", () => {
      const onSave = vi.fn();
      render(
        <Harness
          initial={{ mode: "multi", reviewers: [sonnet, persona] }}
          personas={PERSONAS}
          onSave={onSave}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Remove Reviewer 1" }));
      // Reviewer 2 (Security, only if risky) is now reviewer 1, which always runs: it keeps the
      // model and effort it showed (the persona's) and loses the persona.
      expect(onSave).toHaveBeenLastCalledWith({
        mode: "fixed",
        model: "claude-opus-5-5",
        effort: "high",
      });
      expect(screen.getByTestId("ae-reviewer-promoted-note")).toHaveTextContent(
        "Security runs only when the diff is risky, and reviewer 1 always runs",
      );
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("keeps a promoted reviewer's own model, and says nothing for a persona that always runs", () => {
      const onSave = vi.fn();
      const own = { ...sonnet, persona: "security" };
      const { unmount } = render(
        <Harness
          initial={{ mode: "multi", reviewers: [sonnet, own] }}
          personas={PERSONAS}
          onSave={onSave}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Remove Reviewer 1" }));
      expect(onSave).toHaveBeenLastCalledWith(sonnet);
      unmount();
      render(
        <Harness
          initial={{ mode: "multi", reviewers: [sonnet, { ...sonnet, persona: "general" }] }}
          personas={PERSONAS}
          onSave={onSave}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Remove Reviewer 1" }));
      expect(onSave).toHaveBeenLastCalledWith({
        mode: "multi",
        reviewers: [{ ...sonnet, persona: "general" }],
      });
      expect(screen.queryByTestId("ae-reviewer-promoted-note")).toBeNull();
    });

    it("keeps a lone persona slot in the multi shape", () => {
      const onSave = vi.fn();
      render(<Harness initial={sonnet} personas={PERSONAS} onSave={onSave} />);
      choose(1, "General");
      expect(onSave).toHaveBeenLastCalledWith({
        mode: "multi",
        reviewers: [{ ...sonnet, persona: "general" }],
      });
    });
  });
});
