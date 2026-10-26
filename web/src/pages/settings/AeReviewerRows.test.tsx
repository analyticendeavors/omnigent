import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailableAgent } from "@/hooks/useAvailableAgents";
import { AE_CODEX_AGENT_ID, type AeReviewerSetting } from "@/lib/aeReviewers";
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

function Harness({
  initial,
  options = defaultOptions,
  hostStatus = "online",
  onSave,
}: {
  initial: AeReviewerSetting;
  options?: AeTeamOption[];
  hostStatus?: string;
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
    expect(screen.getByText("3 of 3. Remove one to add another.")).toBeInTheDocument();
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
    const picker = screen.getByRole("combobox", { name: "Reviewer model" });
    expect(screen.getByRole("option", { name: "Gemini CLI (needs setup)" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Auto (the lead picks)" })).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: "codex:gpt-6-astra" } });
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
    const second = screen.getAllByRole("combobox", { name: /^Reviewer 2 model/ })[0];
    expect(second.querySelector('option[value="__auto"]')).toBeNull();
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
    expect(screen.getByRole("combobox", { name: /^Reviewer 2 model/ })).toHaveValue(
      "codex:gpt-6-sol",
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
  const second = () => screen.getByRole("combobox", { name: /^Reviewer 2 model/ });
  const barOf = () =>
    within(screen.getByRole("radiogroup", { name: "Reviewer 2 effort" })).getAllByRole("radio");

  it("lists the three latest Codex models by the host's names, with no versions or notes", () => {
    render(<Harness initial={codexSlot("gpt-6-sol", "high")} onSave={vi.fn()} />);
    const group = second().querySelector<HTMLElement>(
      'optgroup[label="Run through Codex, as a child session"]',
    );
    expect(Array.from(group?.querySelectorAll("option") ?? []).map((o) => o.textContent)).toEqual([
      "GPT-6-Astra",
      "GPT-6-Sol",
      "GPT-6-Luna",
    ]);
    expect(
      second().querySelector('optgroup[label="Run through Claude, as a subagent"]'),
    ).not.toBeNull();
    expect(second()).toHaveValue("codex:gpt-6-sol");
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
    expect(second()).toHaveValue("codex:gpt-5.6-sol");
    expect(within(second()).getByRole("option", { name: "GPT-5.6-Sol" })).toBeInTheDocument();
    // The default model's own default effort is the one filled.
    expect(barOf().filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
    expect(barOf()[0]).toHaveAttribute("aria-checked", "true");
  });

  it("shows the name of an older saved model, and says Codex until the list loads", () => {
    const { unmount } = render(
      <Harness initial={codexSlot("gpt-5.6-terra", "max")} onSave={vi.fn()} />,
    );
    expect(second()).toHaveValue("codex:gpt-5.6-terra");
    expect(within(second()).getByRole("option", { name: "GPT-5.6-Terra" })).toBeInTheDocument();
    unmount();
    catalog.pending = true;
    render(<Harness initial={codexSlot(null, null)} onSave={vi.fn()} />);
    expect(second()).toHaveValue("codex:");
    expect(
      within(second()).getByRole("option", { name: "Codex, default model" }),
    ).toBeInTheDocument();
    expect(within(second()).getByRole("option", { name: "Loading Codex models" })).toBeDisabled();
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
    fireEvent.change(second(), { target: { value: "codex:gpt-6-luna" } });
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
    fireEvent.change(second(), { target: { value: "codex:gpt-6-luna" } });
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
    const select = screen.getByRole("combobox", { name: "Reviewer model" });
    expect(
      select.querySelector('optgroup[label="Run through Codex, as a child session"]'),
    ).toBeNull();
    expect(within(select).getByRole("option", { name: "Codex (needs setup)" })).toBeDisabled();
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
      screen.getByRole("combobox", { name: "Reviewer 2 model, GPT-6-Sol, runs through Codex" }),
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
      expect(second()).toHaveValue("codex:gpt-6-sol");
      expect((second() as HTMLSelectElement).selectedOptions[0]).toBeDefined();
      unmount();
    }
    // Ready but with no list: still its own option, never Auto or the first Claude model.
    catalog.pending = true;
    render(<Harness initial={codexSlot("gpt-6-sol", "high")} onSave={vi.fn()} />);
    expect(second()).toHaveValue("codex:gpt-6-sol");
    expect((second() as HTMLSelectElement).selectedOptions[0]).toHaveTextContent("gpt-6-sol");
  });

  it("lists models that do not parse after the latest three", () => {
    catalog.rows = [...HOST_MODELS, codexModel("Experimental")];
    render(<Harness initial={codexSlot("gpt-6-sol", "high")} onSave={vi.fn()} />);
    const group = second().querySelector<HTMLElement>(
      'optgroup[label="Run through Codex, as a child session"]',
    );
    expect(Array.from(group?.querySelectorAll("option") ?? []).map((o) => o.textContent)).toEqual([
      "GPT-6-Astra",
      "GPT-6-Sol",
      "GPT-6-Luna",
      "Experimental",
    ]);
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
});
