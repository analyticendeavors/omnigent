// Groups the waiting row's background shells so identical wait loops read as
// one chip with a count. Conservative on purpose: when in doubt, do not merge.

import type { BackgroundTaskInfo } from "@/lib/types";

export interface AeShellChipGroup {
  key: string;
  tasks: BackgroundTaskInfo[];
  count: number;
}

/** Shell groups shown before the "+N more" toggle. */
export const AE_SHELL_GROUPS_VISIBLE = 3;

/** The text a shell chip shows: description, else command, else a fixed label. */
export function aeShellLabel(task: BackgroundTaskInfo): string {
  return task.description?.trim() || task.command?.trim() || "Background shell";
}

const WAIT_LOOP_START = /^(?:until |while |timeout\s+\d+\s+bash\s+-c\s+'while)/;

/**
 * Whitespace-collapsed label; a wait loop (`until`, `while`, `timeout N bash -c
 * 'while`) compares on its condition, the text before the first `; do `, so
 * loops that differ only in what follows the wait still match.
 */
export function aeShellGroupKey(task: BackgroundTaskInfo): string {
  const text = aeShellLabel(task).replace(/\s+/g, " ");
  if (!task.description?.trim() && WAIT_LOOP_START.test(text)) {
    const cut = text.indexOf("; do ");
    if (cut > 0) return text.slice(0, cut);
  }
  return text;
}

/** Groups in first-seen order. */
export function aeGroupShells(shells: BackgroundTaskInfo[]): AeShellChipGroup[] {
  const groups = new Map<string, AeShellChipGroup>();
  for (const task of shells) {
    const key = aeShellGroupKey(task);
    const group = groups.get(key);
    if (group) {
      group.tasks.push(task);
      group.count += 1;
    } else {
      groups.set(key, { key, tasks: [task], count: 1 });
    }
  }
  return [...groups.values()];
}
