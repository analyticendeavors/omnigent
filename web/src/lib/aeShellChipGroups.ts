// Groups the waiting row's background shells so identical wait loops read as
// one chip with a count. Conservative on purpose: when in doubt, do not merge.

import type { BackgroundTaskInfo } from "@/lib/types";

export interface AeShellChipGroup {
  key: string;
  /** What a merged chip shows: the normalised text shared by every member. */
  label: string;
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
const SLEEP_BODY = /^sleep \d+(?:\.\d+)?$/;

const TIMEOUT_BASH_PREFIX = /^timeout\s+\d+\s+bash\s+-c\s+'/;

/**
 * First index at or after `from` where `needle` starts outside any quotes, or -1.
 * A backslash escapes the next character outside single quotes. With `endAtQuote`,
 * an unquoted `'` closes the scanned script and ends the search.
 */
function indexOutsideQuotes(text: string, needle: string, from: number, endAtQuote: boolean) {
  let quote: "'" | '"' | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (c === "\\") {
      i += 1;
    } else if (quote === '"') {
      if (c === '"') quote = null;
    } else if (text.startsWith(needle, i)) {
      return i;
    } else if (c === "'") {
      if (endAtQuote) return -1;
      quote = c;
    } else if (c === '"') {
      quote = c;
    }
  }
  return -1;
}

/**
 * The whitespace-collapsed text a chip shows. A wait loop (`until`, `while`,
 * `timeout N bash -c 'while`) whose body is only `sleep <n>` is cut at its
 * first `; do `, so loops that differ only in what follows the wait still
 * match. Any other body keeps the full text: when in doubt, do not merge.
 */
export function aeShellGroupText(task: BackgroundTaskInfo): string {
  const text = aeShellLabel(task).replace(/\s+/g, " ");
  if (!task.description?.trim() && WAIT_LOOP_START.test(text)) {
    const prefix = TIMEOUT_BASH_PREFIX.exec(text)?.[0].length;
    const start = prefix ?? 0;
    const cut = indexOutsideQuotes(text, "; do ", start, prefix !== undefined);
    if (cut > 0) {
      const body = cut + 5;
      const end = indexOutsideQuotes(text, "; done", body, prefix !== undefined);
      if (end >= 0 && SLEEP_BODY.test(text.slice(body, end).trim())) return text.slice(0, cut);
    }
  }
  return text;
}

/** Group key: description and command text never share a namespace. */
export function aeShellGroupKey(task: BackgroundTaskInfo): string {
  return `${task.description?.trim() ? "d" : "c"}:${aeShellGroupText(task)}`;
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
      groups.set(key, { key, label: aeShellGroupText(task), tasks: [task], count: 1 });
    }
  }
  return [...groups.values()];
}
