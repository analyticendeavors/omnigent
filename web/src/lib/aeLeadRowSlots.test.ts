import { describe, expect, it } from "vitest";
import { AE_TIME_COLUMN } from "@/lib/aeFamilyBadge";
import {
  AE_LEAD_ACTIONS_OVERLAY,
  AE_LEAD_CHEVRON_SLOT,
  AE_LEAD_FADE_ACTIVE,
  AE_LEAD_FADE_PLAIN,
  AE_LEAD_FADE_TRIGGERS,
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

  it("gives the time the shared 34px column and a beside-spinner 16px", () => {
    expect(AE_LEAD_TIME_SLOT).toContain("w-[34px]");
    expect(AE_LEAD_TIME_SLOT).toContain(AE_TIME_COLUMN);
    expect(AE_LEAD_SPINNER_SLOT).toContain("w-4");
    // chevron 4 + 20, gap 4 -> time at 28.
    const idle = aeLeadRowGeometry({ shared: false, wide: null, marker: false, spinner: false });
    expect(idle.markerRight).toBe(28);
  });

  describe("geometry", () => {
    const g = aeLeadRowGeometry;
    const none = { marker: false, spinner: false };
    it("idle, not shared: the title runs to the time slot, with no spinner room held", () => {
      // time 28..62, then the 8px title gap (the spinner used to hold 66..82, reserve 90).
      expect(g({ shared: false, wide: null, ...none })).toEqual({
        markerRight: 28,
        spinnerRight: null,
        spinnerInTime: false,
        sharedRight: null,
        reserve: 70,
      });
    });
    it("idle, shared: the icon sits left of the time slot", () => {
      expect(g({ shared: true, wide: null, ...none })).toEqual({
        markerRight: 28,
        spinnerRight: null,
        spinnerInTime: false,
        sharedRight: 66,
        reserve: 98,
      });
    });
    it.each([
      ["pill", 132],
      ["scheduled", 96],
      ["badge", 72],
    ] as const)("wide %s marker, not shared, no spinner", (wide, left) => {
      const r = g({ shared: false, wide, marker: true, spinner: false });
      expect(r.markerRight).toBe(28);
      expect(r.reserve).toBe(left + 8);
    });
    it("wide pill, shared: the icon clears the pill", () => {
      expect(g({ shared: true, wide: "pill", marker: true, spinner: false })).toEqual({
        markerRight: 28,
        spinnerRight: null,
        spinnerInTime: false,
        sharedRight: 136,
        reserve: 168,
      });
    });
    it("a spinner with nothing else in the time slot takes the time's place", () => {
      const r = g({ shared: false, wide: null, marker: false, spinner: true });
      expect(r.spinnerInTime).toBe(true);
      expect(r.spinnerRight).toBe(28);
      // Nothing shifts when thinking starts: the reserve is the idle row's.
      expect(r.reserve).toBe(g({ shared: false, wide: null, ...none }).reserve);
    });
    it("a spinner beside a narrow marker sits left of the time slot", () => {
      const r = g({ shared: false, wide: null, marker: true, spinner: true });
      expect(r.spinnerInTime).toBe(false);
      expect(r.spinnerRight).toBe(66);
      expect(r.reserve).toBe(66 + 16 + 8);
    });
    it("a spinner beside a wide marker starts left of it, never over it", () => {
      const r = g({ shared: false, wide: "pill", marker: true, spinner: true });
      expect(r.markerRight).toBe(28);
      expect(r.spinnerRight).toBe(28 + 104 + 4);
      expect(r.reserve).toBe(136 + 16 + 8);
      const shared = g({ shared: true, wide: "scheduled", marker: true, spinner: true });
      expect(shared.spinnerRight).toBe(28 + 68 + 4);
      expect(shared.sharedRight).toBe(100 + 16 + 4);
      expect(shared.reserve).toBe(shared.sharedRight! + 24 + 8);
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
