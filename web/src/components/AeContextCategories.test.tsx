import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AeCategoryBar, AeContextCategories } from "./AeContextCategories";
import { contextCountdown, type ContextUsage } from "./aeContextUsage";

const data: ContextUsage = {
  available: true,
  totalTokens: 100000,
  maxTokens: 200000,
  autoCompactThreshold: 167000,
  isAutoCompactEnabled: true,
  observedAt: "2026-10-15T20:00:00Z",
  complete: false,
  categories: [
    { name: "Messages", tokens: 100000, kind: "used" },
    { name: "MCP tools (deferred)", tokens: 50000, kind: "deferred" },
    { name: "Free space", tokens: 67000, kind: "free" },
    { name: "Autocompact buffer", tokens: 33000, kind: "buffer" },
  ],
  details: { "Memory files": [{ name: "/some/long/path/CLAUDE.md", tokens: 100 }] },
};

describe("context categories", () => {
  it("shows deferred tools without adding them to the used bar", () => {
    render(
      <>
        <AeCategoryBar data={data} />
        <AeContextCategories data={data} />
      </>,
    );
    expect(screen.getByText("MCP tools (deferred)")).toBeInTheDocument();
    expect(screen.getByText(/excluded from used space/)).toBeInTheDocument();
    expect(screen.getByRole("img").children).toHaveLength(2);
    expect(screen.getByRole("img").children[0]).toHaveStyle({ width: "50%" });
    expect(screen.getByText(/Some MCP servers/)).toBeInTheDocument();
    expect(screen.getByText("/some/long/path/CLAUDE.md")).toBeInTheDocument();
  });
  it("uses the returned threshold on smaller windows and honors disabled compaction", () => {
    expect(contextCountdown(data, 100000)).toBe("About 67k until auto-compact");
    expect(contextCountdown({ ...data, isAutoCompactEnabled: false }, 100000)).toBe(
      "Auto-compact is off",
    );
  });
  it("shows an unavailable reading without inventing categories", () => {
    render(<AeContextCategories data={{ ...data, available: false, reason: "Runner offline" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Runner offline");
    expect(screen.queryByText("Messages")).not.toBeInTheDocument();
  });
});
