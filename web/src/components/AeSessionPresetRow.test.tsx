import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type AeRolesState, aeParseRolesState } from "@/lib/aeRoles";
import { AeSessionPresetRow } from "./AeSessionPresetRow";

const mocks = vi.hoisted(() => ({ roles: vi.fn() }));
vi.mock("@/hooks/useAeRoles", () => ({
  useAeRoles: () => ({ data: mocks.roles() }),
  useAeRolesSave: () => vi.fn(),
}));
vi.mock("@/hooks/useAeRoleModels", () => ({
  useAeRoleModels: () => ({
    models: [
      { value: "claude-opus-5-5", label: "Opus 5.5" },
      { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    ],
    ids: [],
    note: null,
  }),
}));
vi.mock("@/hooks/useHosts", () => ({
  useHostModelOptions: () => ({ data: [], isError: false, isFetching: false }),
}));

const sonnet = { mode: "fixed", model: "claude-sonnet-5-5", effort: "medium" };
const security = {
  id: "security",
  name: "Security",
  purpose: "Security only",
  model: "claude-opus-5-5",
  effort: "high",
  when: "risky",
  trigger: "auth",
  instructions: "Report attack paths.",
};
const docs = {
  id: "docs",
  name: "Docs",
  purpose: "Docs match",
  when: "always",
  instructions: "Read the docs.",
};

function state(): AeRolesState {
  const balanced = {
    id: "balanced",
    title: "Balanced",
    icon: "scale",
    color: "teal",
    description: "",
    when_to_use: "",
    pinned: true,
    roles: {
      lead: { mode: "session" },
      planner: sonnet,
      reviewer: { mode: "multi", reviewers: [sonnet, { mode: "fixed", persona: "security" }] },
      builder: sonnet,
      helper: sonnet,
    },
    rules: { raise_or_lower: "tell", lead_steps_down: true, auto_raises: 1 },
  };
  const parsed = aeParseRolesState({
    revision: 1,
    default_preset: "balanced",
    apply_start_on: true,
    presets: [balanced],
    starters: [],
    builtin_personas: [security],
    personas: [docs],
  });
  if (!parsed) throw new Error("test state did not parse");
  return parsed;
}

describe("AeSessionPresetRow", () => {
  it("shows a persona-only reviewer on the persona's model, with the persona list, when customizing", () => {
    mocks.roles.mockReturnValue(state());
    render(
      <AeSessionPresetRow
        value={null}
        onChange={vi.fn()}
        reviewerAgents={{ options: [], host: null, loaded: true }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /customize/i }));
    const persona = screen.getByRole("button", { name: /^Reviewer 2 persona/ });
    expect(persona).toHaveAccessibleName("Reviewer 2 persona, Security");
    expect(screen.queryByTestId("ae-reviewer-persona-missing-2")).toBeNull();
    fireEvent.click(persona);
    const names = within(screen.getByRole("tree", { name: "Reviewer 2 persona list" }))
      .getAllByRole("treeitem")
      .map((o) => o.textContent);
    expect(names).toEqual(["No persona", "Security", "Docs"]);
    // The slot reads as Opus on the persona's model, not "The lead chooses".
    expect(screen.queryByText("The lead chooses")).toBeNull();
    expect(screen.getByTestId("ae-reviewer-slot-2")).toHaveTextContent(/Opus/);
  });
});
