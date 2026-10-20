// The newest step of each running Claude Code subagent, for the rail's Agents
// section. A subagent's work lands as tool calls, so its newest message is only
// its prompt; its newest tool call, usually self-described, says what it does now.

import { useQueries } from "@tanstack/react-query";
import { fetchSessionItemsPage } from "@/lib/sessionsApi";

/** Faster than the section's own poll: this is the line someone waits on. */
const STEP_POLL_MS = 15_000;

/** Running subagents whose step the section fetches per poll. */
const MAX_STEP_FETCHES = 6;

/** Newest items scanned for a tool call; parallel calls stack their outputs on top. */
const SCAN_ITEMS = 20;

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Claude Code's own tools, by what their main argument means. */
const READ_TOOLS = new Set(["Read"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);

/**
 * One line for a raw `function_call` item: the call's own description when it
 * carries one, else a verb for Claude Code's common tools, else the tool's name.
 * `null` for any other item.
 */
export function subagentStepNote(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const { type, name, arguments: raw } = item as Record<string, unknown>;
  if (type !== "function_call" || typeof name !== "string") return null;
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    // Arguments that are not JSON still leave the tool's name.
  }
  const description = stringArg(args, "description");
  if (description) return description;
  const path = stringArg(args, "file_path") ?? stringArg(args, "notebook_path");
  if (path && READ_TOOLS.has(name)) return `Reading ${fileName(path)}`;
  if (path && EDIT_TOOLS.has(name)) return `Editing ${fileName(path)}`;
  const pattern = stringArg(args, "pattern");
  if (pattern && SEARCH_TOOLS.has(name)) return `Searching for ${pattern}`;
  const url = stringArg(args, "url");
  if (url && name === "WebFetch") return `Fetching ${url}`;
  const query = stringArg(args, "query");
  if (query && name === "WebSearch") return `Searching the web for ${query}`;
  if (name === "SubagentHandback") return "Reporting back";
  return `Using ${name}`;
}

/** The newest step of one subagent, or `null` when it has none or the read failed. */
export async function fetchSubagentStep(sessionId: string): Promise<string | null> {
  try {
    const { items } = await fetchSessionItemsPage(sessionId, { limit: SCAN_ITEMS });
    // The page is chronological, so the newest item is last.
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const note = subagentStepNote(items[i]);
      if (note) return note;
    }
    return null;
  } catch {
    return null;
  }
}

/** Each running subagent's newest step by session id, each polled on its own while `active`. */
export function useAeSubagentSteps(active: boolean, ids: string[]): Record<string, string> {
  const shown = ids.slice(0, MAX_STEP_FETCHES);
  const results = useQueries({
    queries: shown.map((id) => ({
      queryKey: ["ae-rail-subagent-step", id],
      queryFn: () => fetchSubagentStep(id),
      enabled: active,
      refetchInterval: active ? STEP_POLL_MS : (false as const),
    })),
  });
  const steps: Record<string, string> = {};
  shown.forEach((id, i) => {
    const step = results[i]?.data;
    if (step) steps[id] = step;
  });
  return steps;
}
