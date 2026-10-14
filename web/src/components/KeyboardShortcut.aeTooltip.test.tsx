// 2026-10-14: the shortcut tooltip takes the shared popover surface in both
// themes; its forced slate box stayed near-black in light mode.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Tooltip, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { KeyboardShortcutTooltipContent } from "./KeyboardShortcut";

afterEach(cleanup);

function renderOpenTooltip() {
  render(
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger>Start session</TooltipTrigger>
        <KeyboardShortcutTooltipContent label="Start session" keys={["Ctrl", "↵"]} />
      </Tooltip>
    </TooltipProvider>,
  );
}

describe("KeyboardShortcutTooltipContent", () => {
  it("takes the popover surface with no forced slate colours or border", () => {
    renderOpenTooltip();
    const surface = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
    expect(surface).toHaveClass("bg-popover", "text-popover-foreground", "ring-1");
    expect(surface).not.toHaveClass("border");
    expect(surface?.outerHTML).not.toContain("slate-");
  });

  it("draws its keys in the Kbd variant that reads on the popover surface", () => {
    renderOpenTooltip();
    const keys = Array.from(
      screen.getByRole("tooltip").querySelectorAll<HTMLElement>('[data-slot="kbd"]'),
    );
    expect(keys.map((key) => key.textContent)).toEqual(["Ctrl", "↵"]);
    for (const key of keys) {
      expect(key).toHaveClass("border-border", "bg-muted", "text-muted-foreground");
    }
  });
});
