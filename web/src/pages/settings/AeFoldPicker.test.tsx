import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { type AeFoldGroup, AeFoldPicker } from "./AeFoldPicker";

const opt = (label: string, extra = {}) => ({ value: label.toLowerCase(), label, ...extra });
const CLAUDE = "Run through Claude, as a subagent";
const groups: AeFoldGroup[] = [
  {
    id: "claude",
    label: CLAUDE,
    options: [opt("Fable 5.1"), opt("Opus 5.5", { note: "used by Reviewer 1" }), opt("Haiku 5.5")],
    older: [opt("Opus 5"), opt("Sonnet 4.6")],
  },
  {
    id: "agents",
    label: "Other agents",
    options: [opt("Antigravity", { disabled: true, note: "needs setup" })],
    older: [],
  },
];

function Harness({
  initial = "fable 5.1",
  list = groups,
  onPick,
}: {
  initial?: string;
  list?: AeFoldGroup[];
  onPick?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <AeFoldPicker
      value={value}
      ariaLabel="Reviewer 2 model"
      groups={list}
      headingHint={<button type="button">hint</button>}
      onPick={(v) => {
        setValue(v);
        onPick?.(v);
      }}
    />
  );
}
const trigger = () => screen.getByRole("button", { name: /^Reviewer 2 model/ });
const tabbable = () =>
  screen.getAllByRole("treeitem").filter((el) => el.getAttribute("tabindex") === "0");

describe("AeFoldPicker", () => {
  it("is a plain button that names the current model and a dialog it controls", () => {
    render(<Harness />);
    expect(trigger()).toHaveAccessibleName("Reviewer 2 model, Fable 5.1");
    expect(trigger()).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).not.toHaveAttribute("aria-controls");
    fireEvent.click(trigger());
    const dialog = screen.getByRole("dialog", { name: "Reviewer 2 model choices" });
    expect(trigger()).toHaveAttribute("aria-controls", dialog.id);
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("renames the trigger after a pick", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.click(screen.getByRole("treeitem", { name: "Haiku 5.5" }));
    expect(trigger()).toHaveAccessibleName("Reviewer 2 model, Haiku 5.5");
    expect(trigger()).toHaveFocus();
  });

  it("uses tree roles, labelled groups and levels", () => {
    render(<Harness initial="sonnet 4.6" />);
    fireEvent.click(trigger());
    expect(screen.getByRole("tree")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: CLAUDE })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Other agents" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "Fable 5.1" })).toHaveAttribute("aria-level", "1");
    const fold = screen.getByRole("treeitem", { name: "Older models, expanded, 2" });
    expect(fold).toHaveAttribute("aria-level", "1");
    expect(fold).toHaveAttribute("aria-expanded", "true");
    const nested = document.getElementById(fold.getAttribute("aria-controls") ?? "");
    expect(nested).toHaveAttribute("role", "group");
    expect(
      within(nested as HTMLElement).getByRole("treeitem", { name: "Sonnet 4.6" }),
    ).toHaveAttribute("aria-level", "2");
    expect(screen.getByRole("treeitem", { name: "Sonnet 4.6" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("starts with the fold closed and aria-controls pointing at its group", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const fold = screen.getByRole("treeitem", { name: "Older models, collapsed, 2" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(fold.getAttribute("aria-controls") ?? "")).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "Opus 5" })).toBeNull();
    expect(screen.getByRole("treeitem", { name: /Opus 5.5/ })).toHaveTextContent(
      "used by Reviewer 1",
    );
  });

  it("opens the fold on its own when the catalog arrives with the current model inside it", () => {
    const loading: AeFoldGroup[] = [{ ...groups[0], older: [] }];
    const { rerender } = render(
      <AeFoldPicker
        value="opus 5"
        ariaLabel="Reviewer 2 model"
        groups={loading}
        onPick={vi.fn()}
      />,
    );
    expect(trigger()).toHaveTextContent("Unavailable model");
    expect(trigger()).toHaveAttribute("title", "opus 5");
    fireEvent.click(trigger());
    rerender(
      <AeFoldPicker value="opus 5" ariaLabel="Reviewer 2 model" groups={groups} onPick={vi.fn()} />,
    );
    expect(screen.getByRole("treeitem", { name: /^Older models, expanded/ })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "Opus 5" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("does not pick a disabled row, and picks an enabled one with a click", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("treeitem", { name: /Antigravity/ }));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("treeitem", { name: /Opus 5.5/ }));
    expect(onPick).toHaveBeenCalledWith("opus 5.5");
  });

  it("keeps one tabbable item and moves real focus with the arrows", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("treeitem", { name: "Fable 5.1" })).toHaveFocus();
    expect(tabbable()).toHaveLength(1);
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    const fold = screen.getByRole("treeitem", { name: /^Older models/ });
    expect(fold).toHaveFocus();
    expect(tabbable()).toEqual([fold]);
    await user.keyboard("{ArrowRight}");
    expect(fold).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowDown}");
    const older = screen.getByRole("treeitem", { name: "Opus 5" });
    expect(older).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(fold).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(fold).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{End}");
    expect(screen.getByRole("treeitem", { name: /Antigravity/ })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("treeitem", { name: "Fable 5.1" })).toHaveFocus();
    await user.keyboard("o");
    expect(screen.getByRole("treeitem", { name: /Opus 5.5/ })).toHaveFocus();
  });

  it("toggles a fold with Space and Enter, and picks with Enter", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    trigger().focus();
    await user.keyboard("{Enter}{ArrowDown}{ArrowDown}{ArrowDown}");
    await user.keyboard(" ");
    expect(screen.getByRole("treeitem", { name: /^Older models, expanded/ })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("treeitem", { name: /^Older models, collapsed/ })).toBeInTheDocument();
    await user.keyboard("{ArrowUp}{Enter}");
    expect(onPick).toHaveBeenCalledWith("haiku 5.5");
    expect(trigger()).toHaveFocus();
  });

  it("skips disabled rows in type-ahead and closed folds' models", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{Enter}a");
    expect(screen.getByRole("treeitem", { name: /Antigravity/ })).not.toHaveFocus();
    await user.keyboard("s");
    expect(screen.getByRole("treeitem", { name: "Fable 5.1" })).toHaveFocus();
  });

  it("closes on Escape and on Tab, returning focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{Enter}{Escape}");
    expect(screen.queryByRole("tree")).toBeNull();
    expect(trigger()).toHaveFocus();
    await user.keyboard("{Enter}{Tab}");
    expect(screen.queryByRole("tree")).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it.each(["{ArrowDown}", "{ArrowUp}", "{Enter}", " "])(
    "opens the closed trigger with %j, on the selected item",
    async (key) => {
      const user = userEvent.setup();
      render(<Harness initial="haiku 5.5" />);
      trigger().focus();
      await user.keyboard(key);
      expect(screen.getByRole("treeitem", { name: "Haiku 5.5" })).toHaveFocus();
    },
  );

  it("keeps two rows with one value from both reading as selected", () => {
    const dupes: AeFoldGroup[] = [
      {
        id: "a",
        label: "A",
        options: [opt("Same one"), opt("Same two", { value: "same one" })],
        older: [],
      },
    ];
    render(<Harness initial="same one" list={dupes} />);
    fireEvent.click(trigger());
    expect(screen.getAllByRole("treeitem", { selected: true })).toHaveLength(1);
  });

  it("shows Unavailable model for a value no row has, with the stored id as the title", () => {
    render(<Harness initial="codex:" />);
    expect(trigger()).toHaveTextContent("Unavailable model");
    expect(trigger()).toHaveAttribute("title", "codex:");
  });

  it("keeps Tab and Shift+Tab inside the popover's rules when no fold shows the hint", async () => {
    const user = userEvent.setup();
    const noFolds: AeFoldGroup[] = [{ ...groups[0], older: [] }];
    render(<Harness list={noFolds} />);
    trigger().focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("ae-fold-hint")).toBeNull();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.queryByRole("tree")).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it("sends Shift+Tab from the hint to the trigger and Tab into the tree", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{Enter}{Shift>}{Tab}{/Shift}");
    const hint = screen.getByRole("button", { name: "hint" });
    expect(hint).toHaveFocus();
    // Tab from the hint is taken over (the portaled popover has no page tab order); where focus lands is checked in the browser run.
    expect(fireEvent.keyDown(hint, { key: "Tab" })).toBe(false);
    await waitFor(() => expect(screen.getByRole("treeitem", { name: "Fable 5.1" })).toHaveFocus());
    hint.focus();
    hint.focus();
    fireEvent.keyDown(hint, { key: "Tab", shiftKey: true });
    expect(screen.queryByRole("tree")).toBeNull();
    expect(trigger()).toHaveFocus();
  });
});
