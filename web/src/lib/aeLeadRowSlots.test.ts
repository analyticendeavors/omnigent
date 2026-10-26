import { describe, expect, it } from "vitest";
import { AE_TIME_COLUMN } from "@/lib/aeFamilyBadge";
import {
  AE_LEAD_ACTIONS_OVERLAY,
  AE_LEAD_CHEVRON_SLOT,
  AE_LEAD_FADE_ACTIVE,
  AE_LEAD_FADE_PLAIN,
  AE_LEAD_FADE_TRIGGERS,
  AE_LEAD_SPINNER_RIGHT,
  AE_LEAD_SPINNER_SLOT,
  AE_LEAD_TIME_SLOT,
  aeLeadRowGeometry,
} from "@/lib/aeLeadRowSlots";

const classes = (cls: string) => cls.split(/\s+/);

describe("lead row slots", () => {
  it("puts the chevron in a 20px slot 4px from the edge", () => {
    expect(AE_LEAD_CHEVRON_SLOT).toContain("size-5");
    expect(classes(AE_LEAD_CHEVRON_SLOT)).toContain("right-1");
  });

  it("gives the time the shared 34px column and the spinner 16px, with offsets from one place", () => {
    expect(AE_LEAD_TIME_SLOT).toContain("w-[34px]");
    expect(AE_LEAD_TIME_SLOT).toContain(AE_TIME_COLUMN);
    expect(AE_LEAD_SPINNER_SLOT).toContain("w-4");
    // chevron 4 + 20, gap 4 -> time at 28; time 34, gap 4 -> spinner at 66.
    expect(aeLeadRowGeometry({ shared: false, wide: null, spinner: false }).markerRight).toBe(28);
    expect(AE_LEAD_SPINNER_RIGHT).toBe(66);
  });

  describe("geometry", () => {
    const g = aeLeadRowGeometry;
    it("narrow marker, not shared: the stack ends at the spinner slot", () => {
      expect(g({ shared: false, wide: null, spinner: false })).toEqual({
        markerRight: 28,
        sharedRight: null,
        reserve: 90,
      });
    });
    it("narrow marker, shared: the icon sits left of the spinner slot", () => {
      expect(g({ shared: true, wide: null, spinner: false })).toEqual({
        markerRight: 28,
        sharedRight: 86,
        reserve: 118,
      });
    });
    it.each([
      ["pill", 132],
      ["scheduled", 96],
      ["badge", 82],
    ] as const)("wide %s marker, not shared, no spinner", (wide, left) => {
      const r = g({ shared: false, wide, spinner: false });
      expect(r.markerRight).toBe(28);
      expect(r.reserve).toBe(Math.max(82, left) + 8);
    });
    it("wide pill, shared: the icon clears the pill", () => {
      expect(g({ shared: true, wide: "pill", spinner: false })).toEqual({
        markerRight: 28,
        sharedRight: 136,
        reserve: 168,
      });
    });
    it("wide scheduled time, shared", () => {
      expect(g({ shared: true, wide: "scheduled", spinner: false })).toEqual({
        markerRight: 28,
        sharedRight: 100,
        reserve: 132,
      });
    });
    it("wide marker with the spinner showing starts left of the spinner, never over it", () => {
      const r = g({ shared: false, wide: "pill", spinner: true });
      // spinner occupies 66..82; the pill's right edge sits 4px past it.
      expect(r.markerRight).toBe(AE_LEAD_SPINNER_RIGHT + 16 + 4);
      expect(r.markerRight).toBeGreaterThanOrEqual(82);
      expect(r.reserve).toBe(86 + 104 + 8);
      const shared = g({ shared: true, wide: "scheduled", spinner: true });
      expect(shared.markerRight).toBe(86);
      expect(shared.sharedRight).toBe(86 + 68 + 4);
      expect(shared.reserve).toBe(shared.sharedRight! + 24 + 8);
    });
    it("a narrow marker with the spinner showing keeps the time slot", () => {
      expect(g({ shared: false, wide: null, spinner: true }).markerRight).toBe(28);
    });
  });

  describe("actions overlay", () => {
    it("takes no pointer events, exists only at md and up, and stays clear of the chevron", () => {
      const c = classes(AE_LEAD_ACTIONS_OVERLAY);
      expect(c).toContain("pointer-events-none");
      expect(c).toContain("hidden");
      expect(c).toContain("md:flex");
      expect(c).toContain("right-[28px]");
      expect(c).not.toContain("right-1");
    });
    it("fades in on hover, focus inside the actions (not the chevron) and an open menu", () => {
      expect(AE_LEAD_FADE_TRIGGERS).toContain("md:group-hover:bg-[");
      expect(AE_LEAD_FADE_TRIGGERS).toContain(
        "md:group-has-[:focus-visible:not([data-testid=ae-family-fold])]:bg-[",
      );
      expect(AE_LEAD_FADE_TRIGGERS).toContain("md:group-has-[[aria-expanded=true]]:bg-[");
    });
    it("takes the row's colour in light and dark, and the active colour on the open row", () => {
      expect(AE_LEAD_FADE_PLAIN).toContain("[--ae-fade-color:var(--muted)]");
      expect(AE_LEAD_FADE_PLAIN).toContain("dark:[--ae-fade-color:color-mix");
      expect(AE_LEAD_FADE_ACTIVE).toContain("[--ae-fade-color:var(--sidebar-active)]");
      expect(AE_LEAD_FADE_ACTIVE).toContain("dark:[--ae-fade-color:var(--sidebar-active)]");
    });
  });
});
