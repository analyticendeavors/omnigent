import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AeCategoryBar,
  AeCategoryLegend,
  AeContextCategoryRows,
  categoryLegend,
  formatCategoryTokens,
} from "./AeContextCategories";
import { contextCountdown } from "./aeContextUsage";
import { SNAPSHOT } from "./aeRailTestFixtures";

describe("context categories", () => {
  it("draws used categories largest first with the buffer at the end, never deferred or free", () => {
    render(<AeCategoryBar data={SNAPSHOT} />);
    const segments = Array.from(
      screen.getByTestId("ae-category-bar").querySelectorAll<HTMLElement>("[data-category]"),
    );
    expect(segments.map((s) => s.dataset.category)).toEqual([
      "Messages",
      "MCP tools",
      "System tools",
      "Memory files",
      "System prompt",
      "Skills",
      "MCP server instructions",
      "Autocompact buffer",
    ]);
    expect(segments[0]).toHaveStyle({ width: "39.97%" });
    expect(segments.at(-1)).toHaveClass("ml-auto");
  });

  it("keys the bar with the top three categories plus Other, each as a share of the window", () => {
    expect(categoryLegend(SNAPSHOT).map((r) => [r.name, Math.round(r.pct)])).toEqual([
      ["Messages", 40],
      ["MCP tools", 3],
      ["System tools", 2],
      ["Other", 5],
    ]);
    render(<AeCategoryLegend data={SNAPSHOT} />);
    const legend = screen.getByRole("list", { name: "Context window color legend" });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Messages40%", "MCP tools3%", "System tools2%", "Other5%"]);
  });

  it("lists rows by size, buffer and free space last, deferred tools muted with a dash", () => {
    render(<AeContextCategoryRows data={SNAPSHOT} />);
    const fold = screen.getByRole("button", { name: /^Categories\s*10$/ });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Context categories" })).toBeNull();
    fireEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "true");
    const rows = within(screen.getByRole("list", { name: "Context categories" })).getAllByTestId(
      "ae-category-row",
    );
    expect(rows.map((row) => row.textContent)).toEqual([
      "Messages399.7k40.0%",
      "MCP tools25.9k2.6%",
      "System tools23.5k2.4%",
      "Memory files19.4k1.9%",
      "System prompt17.5k1.8%",
      "Skills5.7k0.6%",
      "MCP server instructions4k0.4%",
      "Autocompact buffer33k3.3%",
      "Free space471.4k47.1%",
    ]);
    const deferred = screen.getByRole("list", { name: "Deferred tools" });
    expect(within(deferred).getByTestId("ae-category-row").textContent).toBe(
      "MCP tools (deferred)168.3k-",
    );
    // Folded, nothing but the toggle shows.
    fireEvent.click(fold);
    expect(screen.queryByRole("list", { name: "Context categories" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Deferred tools" })).toBeNull();
  });

  it("opens a list from its category name or its own toggle, and hides empty lists", () => {
    render(<AeContextCategoryRows data={SNAPSHOT} />);
    fireEvent.click(screen.getByRole("button", { name: /^Categories\s*10$/ }));
    expect(screen.queryByRole("button", { name: /Custom agents/ })).toBeNull();
    const toggle = screen.getByRole("button", { name: /^MCP tools\s*2$/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "MCP tools" }));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("list", { name: "MCP tools" }).textContent).toContain(
      "mcp__ae__park_fork1.1k",
    );
    fireEvent.click(toggle);
    expect(screen.queryByRole("list", { name: "MCP tools" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Memory files\s*1$/ }));
    expect(screen.getByText("/some/long/path/CLAUDE.md")).toBeInTheDocument();
    // System prompt has no list, so its name is plain text.
    expect(screen.queryByRole("button", { name: "System prompt" })).toBeNull();
  });

  it("formats tokens the popover's way and counts down with Claude's threshold", () => {
    expect(formatCategoryTokens(950)).toBe("950");
    expect(formatCategoryTokens(399_700)).toBe("399.7k");
    expect(formatCategoryTokens(1_000_000)).toBe("1M");
    expect(contextCountdown(SNAPSHOT, 495_200)).toBe("About 472k until auto-compact");
    expect(contextCountdown({ ...SNAPSHOT, isAutoCompactEnabled: false }, 1)).toBe(
      "Auto-compact is off",
    );
    expect(contextCountdown(SNAPSHOT, 970_000)).toBe("Auto-compact is due");
  });
});
