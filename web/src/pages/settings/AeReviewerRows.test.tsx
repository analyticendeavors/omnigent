import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AvailableAgent } from "@/hooks/useAvailableAgents";
import { AE_CODEX_AGENT_ID, type AeReviewerSetting } from "@/lib/aeReviewers";
import type { AeRoleRules } from "@/lib/aeRoles";
import type { AeTeamOption } from "@/lib/aeTeamOptions";
import { AeReviewerRowsView, AeReviewSettings } from "./AeReviewerRows";

vi.mock("@/hooks/useAeReviewerAgents", () => ({
  useAeReviewerAgents: () => ({ options: [], host: null, loaded: false }),
}));
vi.mock("@/hooks/useHosts", () => ({
  useHostModelOptions: () => ({ data: [], isError: false, isFetching: false }),
}));

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
const host = { host_id: "h1", status: "online" } as never;
const defaultOptions = [ready(codex), setup(gemini)];

function Harness({
  initial,
  options = defaultOptions,
  onSave,
}: {
  initial: AeReviewerSetting;
  options?: AeTeamOption[];
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
        agents={{ options, host, loaded: true }}
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
          model: null,
          effort: null,
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
          model: null,
          effort: null,
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
    fireEvent.change(picker, { target: { value: "agent:codex-id" } });
    expect(onSave).toHaveBeenLastCalledWith({
      mode: "multi",
      reviewers: [
        {
          mode: "agent",
          agent: "codex-id",
          agent_name: "Codex",
          name: "Codex",
          model: null,
          effort: null,
        },
      ],
    });
    expect(screen.getByRole("combobox", { name: "Reviewer 1 effort" })).toHaveValue("");
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
    const second = screen.getByRole("combobox", { name: "Reviewer 2 model" });
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

  it("starts a new agent slot on its default effort and offers only the harness's efforts", () => {
    const geminiReady = ready(gemini);
    render(
      <Harness
        initial={{
          mode: "multi",
          reviewers: [
            sonnet,
            { mode: "agent", agent: "gemini-id", name: "Gemini CLI", model: null, effort: null },
          ],
        }}
        options={[ready(codex), geminiReady]}
        onSave={vi.fn()}
      />,
    );
    const effort = screen.getByRole("combobox", { name: "Reviewer 2 effort" });
    expect(effort).toHaveValue("");
    const values = Array.from(effort.querySelectorAll("option")).map((o) => o.value);
    expect(values).toEqual(["", "low", "medium", "high"]);
  });

  it("keeps a stored effort listed even when it is the harness's top level", () => {
    const onSave = vi.fn();
    render(
      <Harness
        initial={{
          mode: "multi",
          reviewers: [
            sonnet,
            { mode: "agent", agent: "codex-id", name: "Codex", model: null, effort: "max" },
          ],
        }}
        options={[ready(codex)]}
        onSave={onSave}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Reviewer 2 effort" })).toHaveValue("max");
    expect(screen.getAllByRole("option", { name: "Max" }).length).toBeGreaterThan(0);
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
              model: null,
              effort: null,
            },
          ],
        }}
        options={[{ ...ready(live), name: "Codex" }]}
        onSave={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("ae-reviewer-tag-2")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Reviewer 2 model" })).toHaveValue(
      "agent:live-codex-id",
    );
  });
});
