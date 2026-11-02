import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AePersona } from "@/lib/aePersonas";
import type { AeRolePreset, AeRolesState } from "@/lib/aeRoles";
import { AePersonasSection } from "./AePersonasSection";
import type { AeRoleDraft } from "./AeRolesEditor";

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

const general: AePersona = {
  id: "general",
  name: "General",
  purpose: "Plain correctness review",
  model: "claude-sonnet-5-5",
  effort: "medium",
  when: "always",
  instructions: "Review the diff.",
};
const security: AePersona = {
  id: "security",
  name: "Security",
  purpose: "Security only",
  model: "claude-opus-5-5",
  effort: "high",
  when: "risky",
  trigger: "auth",
  instructions: "Attack paths only.",
};
const docs: AePersona = {
  id: "docs",
  name: "Docs",
  purpose: "Docs match the change",
  when: "always",
  instructions: "Read the docs.\nFlag stale claims.",
};

const sonnet = { mode: "fixed" as const, model: "claude-sonnet-5-5", effort: "medium" as const };
const preset = (title: string, reviewers: AeRolePreset["roles"]["reviewer"]): AeRolePreset =>
  ({
    id: title.toLowerCase(),
    title,
    icon: "scale",
    color: "teal",
    description: "",
    when_to_use: "",
    pinned: false,
    roles: {
      lead: { mode: "session" },
      planner: sonnet,
      reviewer: reviewers,
      builder: sonnet,
      helper: sonnet,
    },
    rules: { raise_or_lower: "tell", lead_steps_down: true, auto_raises: 1 },
  }) as AeRolePreset;

function stateOf(patch: Partial<AeRolesState> = {}): AeRolesState {
  return {
    revision: 2,
    default_preset: "balanced",
    apply_start_on: true,
    presets: [],
    starters: [],
    builtin_personas: [general, security],
    personas: [docs],
    ...patch,
  };
}

function renderSection(
  state: AeRolesState,
  onSave = vi.fn().mockResolvedValue(true),
  drafts?: Record<string, AeRoleDraft>,
) {
  render(<AePersonasSection state={state} busy={false} drafts={drafts} onSave={onSave} />);
  return onSave;
}

describe("AePersonasSection", () => {
  it("lists the built-in personas first, read-only with Duplicate, then the user's own", () => {
    renderSection(stateOf());
    const rows = within(screen.getByRole("list", { name: "Personas" })).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "ae-persona-general",
      "ae-persona-security",
      "ae-persona-docs",
    ]);
    const builtin = within(rows[0]);
    expect(builtin.getByText("Built-in")).toBeInTheDocument();
    expect(builtin.getByRole("button", { name: "Duplicate General" })).toBeEnabled();
    expect(builtin.queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(builtin.queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(within(rows[1]).getByText(/only if the diff is risky/)).toBeInTheDocument();
    const mine = within(rows[2]);
    expect(mine.queryByText("Built-in")).toBeNull();
    for (const name of ["Edit Docs", "Duplicate Docs", "Delete Docs"]) {
      expect(mine.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByTestId("ae-hint-personas")).toBeInTheDocument();
  });

  it("adds a persona: explains what is missing, counts the instructions, saves the shape", async () => {
    const onSave = renderSection(stateOf({ personas: undefined }));
    fireEvent.click(screen.getByRole("button", { name: "Add persona" }));
    const form = within(screen.getByTestId("ae-persona-form"));
    const submit = form.getByRole("button", { name: "Add persona" });
    expect(submit).toBeDisabled();
    expect(screen.queryByTestId("ae-persona-problems")).toBeNull();
    fireEvent.change(form.getByLabelText(/^Name/), { target: { value: "Database" } });
    expect(screen.getByTestId("ae-persona-problems")).toHaveTextContent("Say what it is for.");
    fireEvent.change(form.getByLabelText(/^Purpose/), { target: { value: "Check migrations" } });
    fireEvent.change(form.getByLabelText(/^Instructions/), {
      target: { value: "Check each migration.\nName the rollback." },
    });
    expect(screen.getByTestId("ae-persona-count")).toHaveTextContent("40 / 1000");
    fireEvent.change(form.getByLabelText(/^Runs/), { target: { value: "risky" } });
    fireEvent.change(form.getByLabelText(/^Risky means/), { target: { value: "schema changes" } });
    fireEvent.change(form.getByLabelText(/^Model/), { target: { value: "claude-opus-5-5" } });
    fireEvent.change(form.getByLabelText(/^Effort/), { target: { value: "high" } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      {
        personas: [
          {
            id: "database",
            name: "Database",
            purpose: "Check migrations",
            model: "claude-opus-5-5",
            effort: "high",
            when: "risky",
            trigger: "schema changes",
            instructions: "Check each migration.\nName the rollback.",
          },
        ],
      },
      "Added Database.",
    );
    await waitFor(() => expect(screen.queryByTestId("ae-persona-form")).toBeNull());
  });

  it("leaves the model, effort and trigger out when they are not set", async () => {
    const onSave = renderSection(stateOf({ personas: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Add persona" }));
    const form = within(screen.getByTestId("ae-persona-form"));
    expect(form.queryByLabelText(/^Risky means/)).toBeNull();
    fireEvent.change(form.getByLabelText(/^Name/), { target: { value: "Plain" } });
    fireEvent.change(form.getByLabelText(/^Purpose/), { target: { value: "p" } });
    fireEvent.change(form.getByLabelText(/^Instructions/), { target: { value: "do it" } });
    fireEvent.click(form.getByRole("button", { name: "Add persona" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].personas).toEqual([
      { id: "plain", name: "Plain", purpose: "p", when: "always", instructions: "do it" },
    ]);
  });

  it("flags instructions over the limit and will not save them", () => {
    renderSection(stateOf());
    fireEvent.click(screen.getByRole("button", { name: "Add persona" }));
    const form = within(screen.getByTestId("ae-persona-form"));
    fireEvent.change(form.getByLabelText(/^Name/), { target: { value: "Long" } });
    fireEvent.change(form.getByLabelText(/^Purpose/), { target: { value: "p" } });
    fireEvent.change(form.getByLabelText(/^Instructions/), { target: { value: "x".repeat(1001) } });
    expect(screen.getByTestId("ae-persona-count")).toHaveTextContent("1001 / 1000");
    expect(screen.getByTestId("ae-persona-problems")).toHaveTextContent("1000");
    expect(form.getByRole("button", { name: "Add persona" })).toBeDisabled();
  });

  it("gives every form field a hint", () => {
    renderSection(stateOf());
    fireEvent.click(screen.getByRole("button", { name: "Add persona" }));
    fireEvent.change(within(screen.getByTestId("ae-persona-form")).getByLabelText(/^Runs/), {
      target: { value: "risky" },
    });
    for (const id of ["name", "purpose", "model", "effort", "when", "trigger", "instructions"]) {
      expect(screen.getByTestId(`ae-hint-persona.${id}`), id).toBeInTheDocument();
    }
  });

  it("duplicates a built-in persona into a new one with its own id, saved only on Add", async () => {
    const onSave = renderSection(stateOf());
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Security" }));
    const form = within(screen.getByTestId("ae-persona-form"));
    expect(form.getByLabelText(/^Name/)).toHaveValue("Security copy");
    expect(form.getByLabelText(/^Instructions/)).toHaveValue("Attack paths only.");
    expect(form.getByLabelText(/^Runs/)).toHaveValue("risky");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(form.getByRole("button", { name: "Add persona" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = (onSave.mock.calls[0][0] as { personas: AePersona[] }).personas;
    expect(saved.map((p) => p.id)).toEqual(["docs", "security-copy"]);
  });

  it("edits a persona in place and keeps its id", async () => {
    const onSave = renderSection(stateOf());
    fireEvent.click(screen.getByRole("button", { name: "Edit Docs" }));
    const form = within(screen.getByTestId("ae-persona-form"));
    expect(form.getByLabelText(/^Instructions/)).toHaveValue("Read the docs.\nFlag stale claims.");
    fireEvent.change(form.getByLabelText(/^Name/), { target: { value: "Documentation" } });
    fireEvent.click(form.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].personas).toEqual([{ ...docs, name: "Documentation" }]);
    expect(onSave.mock.calls[0][1]).toBe("Saved Documentation.");
  });

  it("keeps the form open when the save fails", async () => {
    renderSection(stateOf(), vi.fn().mockResolvedValue(false));
    fireEvent.click(screen.getByRole("button", { name: "Edit Docs" }));
    fireEvent.click(
      within(screen.getByTestId("ae-persona-form")).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => expect(screen.getByTestId("ae-persona-form")).toBeInTheDocument());
  });

  it("asks before deleting a persona a preset uses, and names those presets", async () => {
    const used = {
      mode: "multi" as const,
      reviewers: [sonnet, { mode: "fixed" as const, persona: "docs" }],
    };
    const onSave = renderSection(
      stateOf({
        presets: [preset("Balanced", used), preset("Quick", sonnet), preset("Deep", used)],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete Docs" }));
    const dialog = within(screen.getByTestId("ae-persona-delete"));
    expect(dialog.getByText("Delete Docs?")).toBeInTheDocument();
    expect(dialog.getByText(/Balanced, Deep use it/)).toBeInTheDocument();
    // The text is true: they stay as plain reviewers, not "keeping their model" they never had.
    expect(dialog.getByText(/plain reviewers on the model and effort they show now/)).toBeVisible();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ personas: [], retire: docs }, "Deleted Docs."),
    );
  });

  it("counts a preset whose unsaved draft uses the persona, though the saved one does not", () => {
    const draft = {
      roles: preset("Quick", {
        mode: "multi",
        reviewers: [sonnet, { mode: "fixed", persona: "docs" }],
      }).roles,
      rules: preset("Quick", sonnet).rules,
    };
    renderSection(
      stateOf({ presets: [preset("Quick", sonnet)] }),
      vi.fn().mockResolvedValue(true),
      { quick: draft },
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete Docs" }));
    const dialog = within(screen.getByTestId("ae-persona-delete"));
    expect(dialog.getByText(/Quick uses it \(unsaved edits included\)/)).toBeInTheDocument();
  });

  it("announces the form's problems in a live region that is always on the page", () => {
    renderSection(stateOf());
    fireEvent.click(screen.getByRole("button", { name: "Add persona" }));
    const region = within(screen.getByTestId("ae-persona-form")).getByRole("alert");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "x" } });
    expect(region).toHaveTextContent("Say what it is for.");
  });

  it("says which character it refuses, and lets instructions keep a tab", () => {
    renderSection(stateOf());
    fireEvent.click(screen.getByRole("button", { name: "Add persona" }));
    const form = within(screen.getByTestId("ae-persona-form"));
    fireEvent.change(form.getByLabelText(/^Name/), { target: { value: "a\u202eb" } });
    fireEvent.change(form.getByLabelText(/^Purpose/), { target: { value: "p" } });
    fireEvent.change(form.getByLabelText(/^Instructions/), {
      target: { value: "Check:\n\t- one" },
    });
    expect(screen.getByTestId("ae-persona-problems")).toHaveTextContent(
      "The name cannot contain an invisible or direction-changing character (U+202E). Remove it.",
    );
    fireEvent.change(form.getByLabelText(/^Name/), { target: { value: "ab" } });
    expect(screen.queryByTestId("ae-persona-problems")).toBeNull();
  });

  it("cancels a delete without saving, and says when no preset uses the persona", () => {
    const onSave = renderSection(stateOf());
    fireEvent.click(screen.getByRole("button", { name: "Delete Docs" }));
    const dialog = within(screen.getByTestId("ae-persona-delete"));
    expect(dialog.getByText("No preset uses it.")).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("stops at 20 personas of your own", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...docs, id: `p${i}`, name: `P${i}` }));
    renderSection(stateOf({ personas: many }));
    const add = screen.getByRole("button", { name: "Add persona" });
    expect(add).toBeDisabled();
    // The reason is on the page, not only in a tooltip, and the disabled buttons point at it.
    const note = screen.getByTestId("ae-personas-full");
    expect(note).toHaveTextContent("20 personas");
    expect(add).toHaveAttribute("aria-describedby", note.id);
    const duplicate = screen.getByRole("button", { name: "Duplicate General" });
    expect(duplicate).toBeDisabled();
    expect(duplicate).toHaveAttribute("aria-describedby", note.id);
  });
});
