import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AeChoiceField } from "@/lib/aeChoiceButtons";
import { AeChoiceButtons } from "./AeChoiceButtons";

const long =
  "Fix it now: one builder on omnigent-ae changes the scheduler so a check-in reuses your orchestrator chat";

const field: AeChoiceField = {
  name: "q",
  title: "Which fix?",
  description: "",
  needsReject: false,
  choices: [
    { value: "a", label: long, fullLabel: "Fix it now" },
    { value: "b", label: "Park it", fullLabel: "Park it" },
  ],
};

describe("AeChoiceButtons on a phone", () => {
  it("lets a long label wrap and shrink instead of running past the card", () => {
    render(<AeChoiceButtons field={field} onChoose={vi.fn()} onReject={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Fix it now" });
    // jsdom has no layout: these classes are what keep the button inside the column.
    expect(button.className).toContain("whitespace-normal");
    expect(button.className).toContain("max-w-full");
    expect(button.className).toContain("min-w-0");
    expect(button.className).toContain("h-auto");
    expect(button.className).not.toContain("whitespace-nowrap");
    expect(button.parentElement?.className).toContain("min-w-0");
  });
});
