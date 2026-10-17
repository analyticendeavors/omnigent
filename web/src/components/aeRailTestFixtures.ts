// Shared test data for the usage popover and the session rail sections.

import type { ContextUsage } from "./aeContextUsage";

/** A Claude Code snapshot: 495.2k of a 1M window, the numbers in the rail mockup. */
export const SNAPSHOT: ContextUsage = {
  available: true,
  totalTokens: 495_200,
  maxTokens: 1_000_000,
  autoCompactThreshold: 967_000,
  isAutoCompactEnabled: true,
  observedAt: "2026-10-17T12:00:00Z",
  complete: true,
  categories: [
    { name: "System prompt", tokens: 17_500, kind: "used" },
    { name: "System tools", tokens: 23_500, kind: "used" },
    { name: "MCP server instructions", tokens: 4_000, kind: "used" },
    { name: "MCP tools", tokens: 25_900, kind: "used" },
    { name: "MCP tools (deferred)", tokens: 168_300, kind: "deferred" },
    { name: "Memory files", tokens: 19_400, kind: "used" },
    { name: "Skills", tokens: 5_700, kind: "used" },
    { name: "Messages", tokens: 399_700, kind: "used" },
    { name: "Free space", tokens: 471_400, kind: "free" },
    { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
  ],
  details: {
    "Memory files": [{ name: "/some/long/path/CLAUDE.md", tokens: 11_200 }],
    "MCP tools": [
      { name: "mcp__ae__park_fork", tokens: 1_100 },
      { name: "mcp__ae__omni_capacity", tokens: 600 },
    ],
    "Custom agents": [],
    Skills: [{ name: "dual-review", tokens: 200 }],
  },
};
