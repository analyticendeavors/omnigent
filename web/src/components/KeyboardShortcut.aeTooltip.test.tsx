// 2026-10-14: the shortcut tooltip takes the shared popover surface in both
// themes; its forced slate box stayed near-black in light mode.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
    // Upstream's near-black tooltip forces dark key chips (neutral-*); ours must not.
    expect(surface?.outerHTML).not.toContain("neutral-");
  });

  it("draws its keys in the Kbd variant that reads on the popover surface", () => {
    renderOpenTooltip();
    const keys = Array.from(
      screen.getByRole("tooltip").querySelectorAll<HTMLElement>('[data-slot="kbd"]'),
    );
    expect(keys.map((key) => key.textContent)).toEqual(["Ctrl", "↵"]);
    for (const key of keys) {
      expect(key).toHaveClass("bg-muted", "text-muted-foreground");
      expect(key.className).not.toMatch(/slate-|neutral-/);
    }
  });

  it("draws the plus between key groups in a colour that reads on the popover surface", () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Split</TooltipTrigger>
          <TooltipContent shortcut={[["Ctrl", "K"], ["S"]]}>Split</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const keys = document.querySelector<HTMLElement>(
      '[data-slot="tooltip-content"] [data-slot="shortcut-keys"]',
    );
    expect(keys).toHaveTextContent("+");
    expect(keys?.outerHTML).not.toContain("text-white");
  });
});
