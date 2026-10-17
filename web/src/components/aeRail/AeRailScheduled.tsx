// The rail's Scheduled section: the scheduled tasks aimed at this session
// (the check-in that names it, and any it created), each with Pause or
// Resume, over a line that says what is still running before it is closed.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SCHEDULED_TASKS_KEY, useUpdateScheduledTask } from "@/hooks/useScheduledTasks";
import { useChildSessions } from "@/hooks/useChildSessions";
import { useActiveRootSessionId } from "@/hooks/useSession";
import {
  beforeClosingLine,
  createdScheduleIds,
  isAeCheckin,
  scheduleTitle,
  scheduleWhen,
  schedulesForSession,
} from "@/lib/aeRailScheduled";
import { type AeRailSectionProps, useAeRailSectionActive } from "@/lib/aeSessionRail";
import { listScheduledTasks, type ScheduledTask } from "@/lib/scheduledTasksApi";
import { splitAgentSections } from "@/shell/aeAgentsPaneModel";
import { AeRailSection } from "./AeRailSection";
import { useAeRailLoadedBlocks } from "./aeRailSessionData";
import { AeRailIcon, AeRailMuted } from "./aeRailUi";

/** The section's own list, apart from the Tasks page's polled one (see useScheduledTasks). */
export const AE_RAIL_SCHEDULED_KEY = ["ae-rail", "scheduled-tasks"] as const;
const NO_IDS: ReadonlySet<string> = new Set();

export function AeRailScheduled({ sessionId }: AeRailSectionProps) {
  const active = useAeRailSectionActive("scheduled");
  const loaded = useAeRailLoadedBlocks(sessionId);
  const query = useQuery<ScheduledTask[]>({
    queryKey: AE_RAIL_SCHEDULED_KEY,
    queryFn: listScheduledTasks,
    enabled: active,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
  const created = loaded ? createdScheduleIds(loaded.blocks) : NO_IDS;
  const rows = query.data ? schedulesForSession(query.data, sessionId, created) : [];
  const activeCount = rows.filter((task) => task.state === "active").length;
  return (
    <AeRailSection id="scheduled" summary={activeCount > 0 ? `${activeCount} active` : undefined}>
      <AeScheduledBody
        sessionId={sessionId}
        active={active}
        rows={rows}
        activeCount={activeCount}
        loading={query.isPending && query.fetchStatus !== "idle"}
        error={query.error}
      />
    </AeRailSection>
  );
}

function AeScheduledBody({
  sessionId,
  active,
  rows,
  activeCount,
  loading,
  error,
}: {
  sessionId: string;
  active: boolean;
  rows: ScheduledTask[];
  activeCount: number;
  loading: boolean;
  error: Error | null;
}) {
  const root = useActiveRootSessionId(sessionId) ?? sessionId;
  const { children } = useChildSessions(active ? root : null);
  const running = splitAgentSections(children, null).running.length;
  const now = new Date();
  return (
    <div className="text-sm">
      {error && rows.length === 0 ? (
        <AeRailMuted className="text-destructive">
          Could not read the scheduled tasks: {error.message}. It retries when this section opens or
          the tab regains focus.
        </AeRailMuted>
      ) : loading && rows.length === 0 ? (
        <AeRailMuted>Reading the scheduled tasks…</AeRailMuted>
      ) : rows.length === 0 ? (
        <AeRailMuted>Nothing scheduled for this session.</AeRailMuted>
      ) : (
        rows.map((task) => <AeScheduleRow key={task.id} task={task} now={now} />)
      )}
      {(rows.length > 0 || running > 0) && (
        <div className="mt-2 flex items-start gap-1.5 border-t border-border pt-2 text-xs text-muted-foreground">
          <AeRailIcon name="info" className="mt-px size-3.5" />
          <span>{beforeClosingLine(activeCount, running)}</span>
        </div>
      )}
    </div>
  );
}

function AeScheduleRow({ task, now }: { task: ScheduledTask; now: Date }) {
  const update = useUpdateScheduledTask();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const paused = task.state === "paused";
  const action = paused ? "Resume" : "Pause";
  const toggle = () => {
    setError(null);
    update.mutate(
      { id: task.id, input: { state: paused ? "active" : "paused" } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: AE_RAIL_SCHEDULED_KEY });
          void queryClient.invalidateQueries({ queryKey: SCHEDULED_TASKS_KEY });
        },
        onError: (err) =>
          setError(
            `Could not ${action.toLowerCase()} it: ${err.message}. ` +
              `Try again, or change it on the Scheduled Tasks page.`,
          ),
      },
    );
  };
  return (
    <div data-testid="ae-schedule-row" className="py-1">
      <div className="flex items-start gap-2">
        <AeRailIcon
          name={isAeCheckin(task) ? "alarm" : "clock"}
          className="mt-0.5 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate" title={task.prompt}>
            {scheduleTitle(task)}
          </div>
          <div className="truncate text-xs text-muted-foreground">{scheduleWhen(task, now)}</div>
        </div>
        <button
          type="button"
          onClick={toggle}
          disabled={update.isPending}
          aria-label={`${action} ${scheduleTitle(task)}`}
          className="flex min-h-7 shrink-0 items-center gap-1 self-center rounded-md border border-border bg-muted px-2 text-xs hover:bg-muted/70 disabled:cursor-wait disabled:opacity-60"
        >
          <AeRailIcon name={paused ? "play" : "pause"} className="size-3.5" />
          {action}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 ml-6 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
