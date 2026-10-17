// The Agents pane's list, laid out like Claude Desktop's Background tasks
// pane (2026-10-15): Running on top with a live timer and a Stop square,
// Finished folded into one line with a count and a Clear button, a Task /
// Model / Time header over each section, and the session's Plan below.

import { useEffect, useState, type ReactNode } from "react";
import { showToast } from "@/components/ui/toast";
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import {
  AE_ICON_CHEVRON_DOWN,
  AE_ICON_CHEVRON_RIGHT,
  AE_ICON_PLAN,
  AE_ICON_RESTORE,
  AE_ICON_STOP,
  AE_ICON_TRASH,
} from "@/lib/aeAgentsIcons";
import { interrupt } from "@/lib/sessionsApi";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";
import { TodoPanel } from "./TodoPanel";
import {
  agentModelLabel,
  canStopChild,
  childElapsedSeconds,
  clearCutoff,
  childLastLine,
  formatElapsed,
  isChildFinished,
  splitAgentSections,
} from "./aeAgentsPaneModel";

const ICON_BUTTON =
  "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:size-10";

// Widths shared by the column header and every row, so they line up as a table.
export const MODEL_COLUMN = "w-16 shrink-0 truncate text-right";
export const TIME_COLUMN = "w-14 shrink-0 whitespace-nowrap text-right tabular-nums";
// A bare status dot sits in this fixed slot right after Time; a running row keeps
// one more slot at its right end for the Stop square.
export const ACTION_COLUMN = "flex w-4 shrink-0 items-center justify-end";
export const STOP_COLUMN = "w-8 shrink-0 pointer-coarse:w-10";

const FINISHED_OPEN_KEY = "ae.agentsPane.finishedOpen";
const clearedKey = (rootSessionId: string) => `ae.agentsPane.clearedAt.${rootSessionId}`;

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Blocked storage: the choice lasts until the pane remounts.
  }
}

/** Current time in ms, ticking every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-1 pr-2.5 pl-2.5 text-xs font-medium text-muted-foreground pointer-coarse:h-10">
      {children}
    </div>
  );
}

function ColumnHeader({ withStop }: { withStop: boolean }) {
  return (
    <li
      aria-hidden="true"
      className="flex items-center gap-1 pr-2.5 pl-6 text-[10px] uppercase tracking-wide text-muted-foreground/70"
    >
      <span className="min-w-0 flex-1">Task</span>
      <span className={MODEL_COLUMN}>Model</span>
      <span className={TIME_COLUMN}>Time</span>
      <span className={ACTION_COLUMN} />
      {withStop && <span className={STOP_COLUMN} />}
    </li>
  );
}

interface AeAgentsSectionsProps {
  rootSessionId: string;
  agents: ChildSessionInfo[];
  renderRow: (child: ChildSessionInfo) => ReactNode;
}

/**
 * The root's children as Running and Finished sections. Keyed by the root,
 * so moving to another session reads that session's Clear, not the last one's.
 *
 * A finished agent's own agents nest under it, so they fold with it even
 * while they run. Claude Code's subagents never nest, so this is rare.
 *
 * @param renderRow - Draws one top-level child row (upstream's `SubagentRow`,
 *   which nests that child's own agents under it).
 */
export function AeAgentsSections(props: AeAgentsSectionsProps) {
  return <AgentsSectionsForRoot key={props.rootSessionId} {...props} />;
}

function AgentsSectionsForRoot({ rootSessionId, agents, renderRow }: AeAgentsSectionsProps) {
  const [clearedAt, setClearedAt] = useState<number | null>(() => {
    const stored = Number(readStorage(clearedKey(rootSessionId)));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });
  const [finishedOpen, setFinishedOpen] = useState(() => readStorage(FINISHED_OPEN_KEY) === "1");
  const { running, finished, clearedCount } = splitAgentSections(agents, clearedAt);
  const cutoff = clearCutoff(finished, clearedAt);

  if (agents.length === 0) return null;

  const toggleFinished = () => {
    setFinishedOpen((open) => {
      writeStorage(FINISHED_OPEN_KEY, open ? "0" : "1");
      return !open;
    });
  };
  const clearFinished = () => {
    if (cutoff === null) return;
    writeStorage(clearedKey(rootSessionId), String(cutoff));
    setClearedAt(cutoff);
  };
  const restoreCleared = () => {
    writeStorage(clearedKey(rootSessionId), null);
    setClearedAt(null);
  };

  return (
    <>
      {running.length > 0 && (
        <li data-testid="agents-running-section">
          <SectionHeader>
            <span>Running</span>
            <span className="tabular-nums">{running.length}</span>
          </SectionHeader>
        </li>
      )}
      {running.length > 0 && <ColumnHeader withStop />}
      {running.map(renderRow)}
      {(finished.length > 0 || clearedCount > 0) && (
        <li data-testid="agents-finished-section" className="mt-1 border-t border-border/60">
          <SectionHeader>
            <button
              type="button"
              onClick={toggleFinished}
              aria-expanded={finishedOpen}
              data-testid="agents-finished-toggle"
              className="-ml-1 flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10"
            >
              <AeTablerSvg
                node={finishedOpen ? AE_ICON_CHEVRON_DOWN : AE_ICON_CHEVRON_RIGHT}
                className="size-3.5 shrink-0"
              />
              <span>Finished</span>
              <span className="tabular-nums">{finished.length}</span>
            </button>
            {clearedCount > 0 && (
              <button
                type="button"
                onClick={restoreCleared}
                className={ICON_BUTTON}
                aria-label={`Show ${clearedCount} cleared`}
                title={`Show ${clearedCount} cleared`}
                data-testid="agents-restore-cleared"
              >
                <AeTablerSvg node={AE_ICON_RESTORE} className="size-4" />
              </button>
            )}
            {finished.length > 0 && cutoff !== null && (
              <button
                type="button"
                onClick={clearFinished}
                className={ICON_BUTTON}
                aria-label="Clear finished agents from this list"
                title="Clear finished"
                data-testid="agents-clear-finished"
              >
                <AeTablerSvg node={AE_ICON_TRASH} className="size-4" />
              </button>
            )}
          </SectionHeader>
        </li>
      )}
      {finishedOpen && finished.length > 0 && <ColumnHeader withStop={false} />}
      {finishedOpen && finished.map(renderRow)}
    </>
  );
}

/**
 * A child row's Model and Time columns and its status dot, then on a running
 * row the slot the Stop square sits over (empty when it cannot be stopped).
 * A status that shows a word ("Failed", "Needs response") goes left of Model
 * instead, so its width never pushes the columns out of line.
 *
 * @param statusHasWord - True when `status` renders a word beside its dot.
 */
export function AeAgentRowMeta({
  child,
  status,
  statusHasWord = false,
}: {
  child: ChildSessionInfo;
  status: ReactNode;
  statusHasWord?: boolean;
}) {
  const finished = isChildFinished(child);
  const now = useNow(!finished);
  // The model the agent ran on, else the one routing picked; blank when neither is known.
  const model = child.model ?? child.routed_model ?? null;
  const routed = child.routed_model != null && model === child.routed_model;
  return (
    <>
      {statusHasWord && status}
      <span
        className={cn(MODEL_COLUMN, "text-[11px] text-muted-foreground")}
        data-testid={model ? (routed ? "subagent-routed-model" : "subagent-model") : undefined}
        title={model ? (routed ? `Smart routing picked ${model}` : model) : undefined}
      >
        {model ? agentModelLabel(model) : null}
      </span>
      <span
        className={cn(TIME_COLUMN, "text-xs text-muted-foreground")}
        data-testid="subagent-elapsed"
      >
        {formatElapsed(childElapsedSeconds(child, now))}
      </span>
      <span className={ACTION_COLUMN}>{statusHasWord ? null : status}</span>
      {!finished && <span aria-hidden="true" className={STOP_COLUMN} />}
    </>
  );
}

/**
 * The Stop square for a row OmniGent can stop. Rendered beside the row's
 * link rather than inside it, over the action slot of the first line.
 */
export function AeAgentStopButton({ child }: { child: ChildSessionInfo }) {
  const [stopping, setStopping] = useState(false);
  if (!canStopChild(child)) return null;
  const stop = async () => {
    setStopping(true);
    try {
      await interrupt(child.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      showToast(
        `Could not stop ${child.tool ?? "this agent"} (${reason}). Open it and stop it from its chat.`,
      );
    } finally {
      // The row folds once the server reports the stop; until then Stop can be pressed again.
      setStopping(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void stop()}
      disabled={stopping}
      className={cn(
        ICON_BUTTON,
        "absolute top-[18px] right-2.5 z-10 -translate-y-1/2 disabled:opacity-50",
      )}
      aria-label={`Stop ${child.tool ?? "agent"}`}
      title="Stop"
      data-testid="subagent-stop"
    >
      <AeTablerSvg node={AE_ICON_STOP} className="size-3.5" />
    </button>
  );
}

/** A child row's second line: its last line, or "No output yet" while it runs. */
export function AeAgentLastLine({
  child,
  className,
}: {
  child: ChildSessionInfo;
  className: string;
}) {
  const line = childLastLine(child);
  if (!line && isChildFinished(child)) return null;
  return (
    <p className={cn("truncate text-sm text-muted-foreground", className)}>
      {line ?? <span className="italic">No output yet</span>}
    </p>
  );
}

/**
 * The open chat's task list (Claude Code's TodoWrite items), folded under the
 * agents. It follows the chat in view, so a subagent's chat shows its own list.
 */
export function AePlanSection() {
  const todos = useChatStore((s) => s.todos);
  const [open, setOpen] = useState(true);
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div
      data-testid="agents-plan-section"
      className="flex max-h-[45%] shrink-0 flex-col border-t border-border bg-card"
    >
      <SectionHeader>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="agents-plan-toggle"
          className="-ml-1 flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10"
        >
          <AeTablerSvg
            node={open ? AE_ICON_CHEVRON_DOWN : AE_ICON_CHEVRON_RIGHT}
            className="size-3.5 shrink-0"
          />
          <AeTablerSvg node={AE_ICON_PLAN} className="size-3.5 shrink-0" />
          <span>Plan</span>
          <span className="ml-auto tabular-nums">
            {done}/{todos.length}
          </span>
        </button>
      </SectionHeader>
      {open && (
        <div className="min-h-0 overflow-y-auto">
          <TodoPanel frameless />
        </div>
      )}
    </div>
  );
}
