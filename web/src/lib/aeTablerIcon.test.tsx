// Project icons through upstream's `ProjectRowIcon` (omnigent-ae, 2026-09-24):
// an emoji stays text, `tabler:<name>` draws the Tabler SVG in the folder's box,
// no icon and an unknown name both fall back to the folder.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AE_TABLER_PREFIX, AeProjectIconGlyph, aeTablerName, aeTablerValue } from "./aeTablerIcon";
import { ProjectRowIcon } from "@/shell/ProjectPicker";

const ROCKET_D = "M4 13a8 8 0 0 1 7 7";

// The store contract with a one-icon set; loads fail while `failing` is set.
const fake = await vi.hoisted(async () => {
  const { createFakeAeTablerIconData } = await import("@/lib/aeTablerIconData.fake");
  return createFakeAeTablerIconData({ rocket: [["path", { d: "M4 13a8 8 0 0 1 7 7" }]] });
});

vi.mock("@/lib/aeTablerIconData", () => fake.module);

beforeEach(() => fake.reset());

afterEach(cleanup);

describe("aeTablerName", () => {
  it("reads the name from a tabler value and nothing else", () => {
    expect(aeTablerName("tabler:rocket")).toBe("rocket");
    expect(aeTablerName("tabler:a-b-2")).toBe("a-b-2");
    expect(aeTablerName("🚀")).toBeNull();
    expect(aeTablerName("tabler:")).toBeNull();
    expect(aeTablerName("tabler:Rocket")).toBeNull();
    expect(aeTablerName("tabler:../x")).toBeNull();
    expect(aeTablerName(null)).toBeNull();
    expect(aeTablerValue("rocket")).toBe(`${AE_TABLER_PREFIX}rocket`);
  });
});

describe("ProjectRowIcon with Tabler icons", () => {
  it("renders an emoji as text, as before", () => {
    render(<ProjectRowIcon icon="🚀" />);
    expect(screen.getByTestId("project-icon")).toHaveTextContent("🚀");
  });

  it("renders a tabler icon as an SVG in the folder's box and color", async () => {
    render(<ProjectRowIcon icon="tabler:rocket" className="size-4 text-[16px]" />);
    const box = screen.getByTestId("project-icon");
    expect(box).toHaveAttribute("data-tabler-icon", "rocket");
    expect(box.className).toContain("size-4");
    expect(box.className).toContain("text-muted-foreground");
    const path = await vi.waitFor(() => {
      const found = box.querySelector("svg path");
      if (!found) throw new Error("svg not drawn yet");
      return found;
    });
    expect(path.getAttribute("d")).toBe(ROCKET_D);
    expect(box.querySelector("svg")?.getAttribute("stroke")).toBe("currentColor");
  });

  it("falls back to the folder when no icon is set", () => {
    const { container } = render(<ProjectRowIcon icon={null} />);
    expect(screen.queryByTestId("project-icon")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("falls back to the folder for a tabler name the set does not know", async () => {
    const { container } = render(<ProjectRowIcon icon="tabler:no-such-icon" className="size-4" />);
    await vi.waitFor(() => expect(screen.queryByTestId("project-icon")).toBeNull());
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("lucide-folder");
    expect(svg?.getAttribute("class")).toContain("size-4");
  });
});

describe("AeProjectIconGlyph", () => {
  it("renders an emoji as text and a tabler icon as a 1em SVG", async () => {
    const { container, rerender } = render(<AeProjectIconGlyph icon="🔥" />);
    expect(container.textContent).toBe("🔥");
    rerender(<AeProjectIconGlyph icon="tabler:rocket" />);
    await vi.waitFor(() => expect(container.querySelector("svg path")).not.toBeNull());
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("size-[1em]");
  });
});

describe("icon names that are Object.prototype keys", () => {
  it("draws the folder for tabler:constructor and tabler:__proto__ instead of throwing", async () => {
    const { container } = render(
      <>
        <ProjectRowIcon icon="tabler:constructor" />
        <ProjectRowIcon icon="tabler:__proto__" />
        <AeProjectIconGlyph icon="tabler:constructor" />
      </>,
    );
    await vi.waitFor(() => expect(container.querySelectorAll("svg.lucide-folder")).toHaveLength(2));
    expect(container.querySelector("[data-tabler-icon]")).toBeNull();
  });
});

describe("recovery after a failed load", () => {
  it("redraws icons that saw the failure once a later load succeeds", async () => {
    fake.store.failing = true;
    const rows = render(
      <>
        <ProjectRowIcon icon="tabler:rocket" />
        <ProjectRowIcon icon="tabler:rocket" />
      </>,
    );
    await vi.waitFor(() =>
      expect(rows.container.querySelectorAll("svg.lucide-folder")).toHaveLength(2),
    );
    // One failed load for both rows, not one each.
    expect(fake.store.loads).toBe(1);
    // A later load (the loader's own retry, or the picker's Try again) succeeds.
    fake.store.failing = false;
    await fake.module.loadAeTablerIcons();
    await vi.waitFor(() =>
      expect(rows.container.querySelectorAll('[data-tabler-icon="rocket"] svg path')).toHaveLength(
        2,
      ),
    );
    expect(rows.container.querySelector("svg.lucide-folder")).toBeNull();
    expect(fake.store.loads).toBe(2);
  });
});
