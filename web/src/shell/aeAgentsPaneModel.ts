// Pure helpers behind the Agents pane's Running and Finished sections: which
// rows are live, how long each ran, what last line to show, and
// which rows OmniGent can actually stop (2026-10-15).

import { aeModelName } from "@/components/aeSessionContext";
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import { nativeCodingAgentForSubagentWrapper, WRAPPER_LABEL_KEY } from "@/lib/nativeCodingAgents";
import { childStatus, type AgentActivity } from "./subagentStatus";

/**
 * Activities that keep a row under Running. Everything else has ended:
 * `failed` gets its own Failed section, and the rest fold into Finished
 * (done, idle, a dropped runner, a stopped task).
 */
const RUNNING_ACTIVITIES: ReadonlySet<AgentActivity> = new Set([
  "working",
  "awaiting",
  "launching",
]);

export function isChildFinished(child: ChildSessionInfo): boolean {
  return !RUNNING_ACTIVITIES.has(childStatus(child).activity);
}

/** True for a row whose run failed; never counted as finished. */
export function isChildFailed(child: ChildSessionInfo): boolean {
  return childStatus(child).activity === "failed";
}

export interface AgentSections {
  running: ChildSessionInfo[];
  /** Ended rows whose run failed (not a dropped runner), kept out of `finished`. */
  failed: ChildSessionInfo[];
  finished: ChildSessionInfo[];
  /** Finished rows hidden by the pane's Clear button. */
  clearedCount: number;
}

/**
 * Split the root's children into Running, Failed and Finished, in server
 * order, dropping ended rows last updated at or before `clearedAt`.
 *
 * @param children - The root session's child rows, in server order.
 * @param clearedAt - Epoch seconds of the last Clear, or `null` when never cleared.
 */
export function splitAgentSections(
  children: ChildSessionInfo[],
  clearedAt: number | null,
): AgentSections {
  const running: ChildSessionInfo[] = [];
  const failed: ChildSessionInfo[] = [];
  const finished: ChildSessionInfo[] = [];
  let clearedCount = 0;
  for (const child of children) {
    if (!isChildFinished(child)) {
      running.push(child);
    } else if (clearedAt !== null && (child.updated_at ?? 0) <= clearedAt) {
      clearedCount += 1;
    } else if (isChildFailed(child)) {
      failed.push(child);
    } else {
      finished.push(child);
    }
  }
  return { running, failed, finished, clearedCount };
}

/**
 * The cutoff a Clear stores: the newest finish time the server reported, so
 * the client clock never matters. `null` when no finished row carries a time
 * (an older server), and the pane then offers no Clear.
 */
export function clearCutoff(finished: ChildSessionInfo[], clearedAt: number | null): number | null {
  const latest = Math.max(0, clearedAt ?? 0, ...finished.map((c) => c.updated_at ?? 0));
  return latest > 0 ? latest : null;
}

/**
 * Seconds a child has run: until now while it runs, until its last update
 * once it finished. `null` when the server sent no timestamps.
 */
export function childElapsedSeconds(child: ChildSessionInfo, nowMs: number): number | null {
  if (child.created_at === undefined) return null;
  const end = isChildFinished(child) ? (child.updated_at ?? child.created_at) : nowMs / 1000;
  return Math.max(0, Math.floor(end - child.created_at));
}

/**
 * `42s`, `3m 05s`, `1h 07m`: the elapsed time the way Claude Desktop prints it.
 * `compact` keeps the larger unit only (`3m`, `1h`) for tight spots.
 */
export function formatElapsed(
  seconds: number | null,
  { compact = false }: { compact?: boolean } = {},
): string {
  if (seconds === null) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return compact ? `${minutes}m` : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return compact ? `${hours}h` : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** True for a mirror of a coding agent's own subagent (a Claude Code Task, say). */
export function isNativeSubagentMirror(child: ChildSessionInfo): boolean {
  return nativeCodingAgentForSubagentWrapper(child.labels?.[WRAPPER_LABEL_KEY]) !== undefined;
}

/**
 * Whether the pane offers a Stop button for this row. A coding agent's own
 * subagent runs inside the main agent's process, so OmniGent can only watch
 * it; an interrupt sent to its mirror does nothing.
 */
export function canStopChild(child: ChildSessionInfo): boolean {
  return !isChildFinished(child) && !isNativeSubagentMirror(child);
}

/**
 * A model id as the Model column prints it: "claude-sonnet-5-5" reads
 * "Sonnet 5.5", a gateway's "databricks-" prefix is dropped, and any other
 * id (a GPT model, say) prints as the harness spelled it.
 */
export function agentModelLabel(model: string): string {
  const id = model.trim().replace(/^databricks-/i, "");
  return aeModelName(id) ?? id;
}

const INJECTED_CONTEXT_PREFIX = "<system-reminder>";

/**
 * The row's last line, or `null` when there is none worth showing. A native
 * subagent's newest message is often the context block the harness injects
 * into its prompt, which is not output.
 */
export function childLastLine(child: ChildSessionInfo): string | null {
  const preview = child.last_message_preview?.trim();
  if (!preview || preview.startsWith(INJECTED_CONTEXT_PREFIX)) return null;
  return preview;
}
