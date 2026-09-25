import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ComposerContextRing } from "@/components/composer/ComposerContextRing";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AE_CONTEXT_CRITICAL_PCT,
  AE_CONTEXT_WARNING_PCT,
  aeContextRingClass,
  contextTone,
} from "./aeContextTone";

afterEach(cleanup);

/** The used arc: the second circle, the one with a dash array. */
function usedArc(tokensUsed: number) {
  render(
    <TooltipProvider>
      <ComposerContextRing contextWindow={1000} tokensUsed={tokensUsed} />
    </TooltipProvider>,
  );
  const ring = screen.getByTestId("composer-context-ring");
  const arc = ring.querySelector("circle[stroke-dasharray]");
  if (!arc) throw new Error("the ring drew no used arc");
  return { ring, arc };
}

describe("contextTone", () => {
  it("warns from 60% and turns critical from 80%", () => {
    expect(AE_CONTEXT_WARNING_PCT).toBe(60);
    expect(AE_CONTEXT_CRITICAL_PCT).toBe(80);
    expect(contextTone(0)).toBe("normal");
    expect(contextTone(59)).toBe("normal");
    expect(contextTone(60)).toBe("warning");
    expect(contextTone(79)).toBe("warning");
    expect(contextTone(80)).toBe("critical");
    expect(contextTone(100)).toBe("critical");
    expect(contextTone(140)).toBe("critical");
  });

  it("decides on the rounded percentage the ring and the popover print", () => {
    expect(contextTone(59.4)).toBe("normal");
    expect(contextTone(59.6)).toBe("warning");
    expect(contextTone(79.6)).toBe("critical");
  });

  it("maps tones to the theme's warning and destructive text colours", () => {
    expect(aeContextRingClass(50)).toBeUndefined();
    expect(aeContextRingClass(65)).toBe("text-warning");
    expect(aeContextRingClass(85)).toBe("text-destructive");
  });
});

describe("ComposerContextRing with the AE tone", () => {
  it("leaves the arc grey at 50%", () => {
    const { ring, arc } = usedArc(500);
    expect(arc.getAttribute("class")).toBeNull();
    expect(ring).toHaveClass("text-muted-foreground");
  });

  it("colours the arc with the warning token at 65%", () => {
    const { ring, arc } = usedArc(650);
    expect(arc).toHaveClass("text-warning");
    expect(arc).toHaveAttribute("stroke", "currentColor");
    // The track and the button stay muted; only the arc carries the tone.
    expect(ring).toHaveClass("text-muted-foreground");
    expect(screen.getByLabelText("65% of context used")).toBeInTheDocument();
  });

  it("colours the arc with the destructive token at 85%", () => {
    const { arc } = usedArc(850);
    expect(arc).toHaveClass("text-destructive");
    expect(arc).not.toHaveClass("text-warning");
  });
});
