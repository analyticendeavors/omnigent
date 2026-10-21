// The effort a Claude session runs at when it has no pick: the level Claude
// Code takes from its settings files, which the runner records per model in a
// session label (omnigent/runner/ae_launch_effort.py), else the level Claude
// Code itself falls back to for the model. The label is read from the sidebar's
// `["conversations"]` cache, so it costs no request.

import { type QueryClient, QueryClientContext } from "@tanstack/react-query";
import { useCallback, useContext, useSyncExternalStore } from "react";
import type { Conversation } from "@/hooks/useConversations";
import { aeClaudeVersion } from "@/lib/aeClaudeModels";
import { comparableModelId } from "@/lib/codexNativeModels";
import { normalizeEffortLabel } from "@/lib/composerModelLabel";
import type { ConversationsInfiniteData } from "@/lib/sessionListCache";

export const AE_EFFORT_DEFAULT_LABEL = "ae.claude_effort_default";
const NO_LEVEL = "none";
const ANY_MODEL = "*";
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** The label's raw value for a cached session; null when it has none. */
export function readAeEffortDefault(queryClient: QueryClient, id: string): string | null {
  for (const [, data] of queryClient.getQueriesData<ConversationsInfiniteData>({
    queryKey: ["conversations"],
  })) {
    for (const page of data?.pages ?? []) {
      const row = page.data.find((conversation: Conversation) => conversation.id === id);
      if (row) {
        const raw = row.labels?.[AE_EFFORT_DEFAULT_LABEL];
        return raw && raw !== NO_LEVEL ? raw : null;
      }
    }
  }
  return null;
}

/** Null without a query client (a composer rendered outside the app shell). */
export function useAeEffortDefault(id: string | null): string | null {
  const queryClient = useContext(QueryClientContext);
  const subscribe = useCallback(
    (onChange: () => void) => queryClient?.getQueryCache().subscribe(onChange) ?? (() => {}),
    [queryClient],
  );
  const read = useCallback(
    () => (id && queryClient ? readAeEffortDefault(queryClient, id) : null),
    [queryClient, id],
  );
  return useSyncExternalStore(subscribe, read, read);
}

interface ModelOption {
  id: string;
  model?: string;
  isDefault?: boolean;
}

// A plain level (the label's first format) applies to any model.
function parseLevels(raw: string): [string, string][] {
  let entries: [string, unknown][] = [[ANY_MODEL, raw]];
  if (raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      entries = parsed && typeof parsed === "object" ? Object.entries(parsed) : [];
    } catch {
      entries = [];
    }
  }
  return entries.filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && CLAUDE_EFFORTS.has(entry[1]),
  );
}

/** A model id or picker alias as a comparable wire id: `opus[1m]` -> `claude-opus-5-5`. */
function canonicalModel(id: string, options: readonly ModelOption[]): string {
  const target = comparableModelId(id);
  const option = options.find(
    (candidate) => candidate.id === id || comparableModelId(candidate.id) === target,
  );
  return comparableModelId(option?.model ?? id);
}

/**
 * The default level for the session's model, e.g. `"high"`: the model's own
 * entry, matched on comparable wire ids so aliases and `[1m]` suffixes agree on
 * either side, else the any-model entry; null when neither exists. With no
 * model reported yet, the picker's default model stands in.
 */
export function aeEffortDefaultFor(
  raw: string | null,
  model: string | null | undefined,
  options: readonly ModelOption[] = [],
): string | null {
  if (!raw) return null;
  const levels = parseLevels(raw);
  const current = model || options.find((option) => option.isDefault)?.id;
  if (current) {
    const target = canonicalModel(current, options);
    const own = levels.find(
      ([key]) => key !== ANY_MODEL && canonicalModel(key, options) === target,
    );
    if (own) return own[1];
  }
  return levels.find(([key]) => key === ANY_MODEL)?.[1] ?? null;
}

// Claude Code's own default effort per model, read from the model catalog in
// the installed Claude Code binary (2.1.306, 2026-10-20) with
// scripts/claude-effort-defaults.py in omnigent-ae; rerun it after a Claude
// Code bump and update this table. Keyed by family and "major.minor".
export const CLAUDE_CODE_DEFAULT_EFFORT: Readonly<Record<string, string>> = {
  "opus 5.5": "medium",
  "opus 5": "high",
  "opus 4.8": "high",
  "opus 4.7": "xhigh",
  "opus 4.6": "high",
  "sonnet 5.5": "medium",
  "sonnet 5": "high",
  "sonnet 4.6": "high",
  "haiku 5.5": "medium",
  "fable 5.1": "high",
  "fable 5": "high",
};

/** Claude Code's built-in default for a model id, alias or label; null when unknown. */
export function aeClaudeCodeDefaultEffort(
  model: string | null | undefined,
  options: readonly ModelOption[] = [],
): string | null {
  if (!model) return null;
  const version = aeClaudeVersion(canonicalModel(model, options)) ?? aeClaudeVersion(model);
  if (!version) return null;
  const key = `${version.family} ${version.major}${version.minor ? `.${version.minor}` : ""}`;
  return CLAUDE_CODE_DEFAULT_EFFORT[key] ?? null;
}

/** Where a Claude session's unpinned effort comes from. */
export type AeEffortSource = "settings" | "claude";

export interface AeEffortResolved {
  level: string;
  source: AeEffortSource;
}

/**
 * The effort an unpinned Claude session runs at: a settings-file level the
 * runner recorded (`settings`), else Claude Code's own default for the model
 * (`claude`); null when the model is unknown. With no model reported yet, the
 * picker's default model stands in.
 */
export function aeEffortResolved(
  raw: string | null,
  model: string | null | undefined,
  options: readonly ModelOption[] = [],
): AeEffortResolved | null {
  const settings = aeEffortDefaultFor(raw, model, options);
  if (settings) return { level: settings, source: "settings" };
  const current = model || options.find((option) => option.isDefault)?.id;
  const builtIn = aeClaudeCodeDefaultEffort(current, options);
  return builtIn ? { level: builtIn, source: "claude" } : null;
}

/** Claude Code's word for a level: Low, Medium, High, Extra (xhigh) or Max. */
export function aeClaudeEffortLabel(effort: string | null | undefined): string | null {
  if (!effort) return null;
  return effort.toLowerCase() === "xhigh" ? "Extra" : normalizeEffortLabel(effort);
}

/** The tag beside the resolved level in the Effort submenu. */
export function aeEffortSourceTag(source: AeEffortSource): string {
  return source === "settings" ? "settings" : "default";
}
