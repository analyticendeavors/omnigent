// The waiting row's shell chips: identical wait loops merge into one chip with a
// count, and more than three groups fold behind a "+N more" toggle.

import { useEffect, useId, useState, type ReactElement } from "react";
import { AE_SHELL_GROUPS_VISIBLE, aeGroupShells, aeShellLabel } from "@/lib/aeShellChipGroups";
import type { BackgroundTaskInfo } from "@/lib/types";

export function AeShellCountBadge({ count }: { count: number }) {
  return (
    <span
      data-testid="ae-activity-shell-count"
      className="shrink-0 rounded bg-muted px-1 text-[0.65rem] font-medium tabular-nums text-muted-foreground"
    >
      ×{count}
    </span>
  );
}

/** Every member command of a merged group, scrollable. */
export function AeShellGroupMembers({ tasks }: { tasks: BackgroundTaskInfo[] }) {
  return (
    <ul
      data-testid="ae-activity-shell-members"
      className="mt-1 flex max-h-48 flex-col gap-1 overflow-y-auto border-t border-border pt-1"
    >
      {tasks.map((t, i) => (
        <li
          key={t.id ?? `member-${i}`}
          className="whitespace-pre-wrap font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]"
        >
          {t.command?.trim() || aeShellLabel(t)}
          {t.status && <span className="ml-1.5 font-sans">({t.status})</span>}
        </li>
      ))}
    </ul>
  );
}

export function AeShellChips({
  shells,
  renderChip,
}: {
  shells: BackgroundTaskInfo[];
  renderChip: (
    first: BackgroundTaskInfo,
    group: BackgroundTaskInfo[],
    label: string | undefined,
  ) => ReactElement;
}) {
  const [expandedRaw, setExpanded] = useState(false);
  const listId = useId();
  const groups = aeGroupShells(shells);
  const hidden = Math.max(0, groups.length - AE_SHELL_GROUPS_VISIBLE);
  // Expansion only means something while groups are hidden; clear it when none are.
  const expanded = expandedRaw && hidden > 0;
  useEffect(() => {
    if (expandedRaw && hidden === 0) setExpanded(false);
  }, [expandedRaw, hidden]);
  const shown = expanded ? groups : groups.slice(0, AE_SHELL_GROUPS_VISIBLE);
  return (
    <>
      <div id={listId} className="contents">
        {shown.map((g) => (
          <span key={g.key} className="contents">
            {renderChip(g.tasks[0], g.tasks, g.count > 1 ? g.label : undefined)}
          </span>
        ))}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          data-testid="ae-activity-shell-more"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
        >
          {expanded ? "Show less" : `+${hidden} more`}
        </button>
      )}
    </>
  );
}
