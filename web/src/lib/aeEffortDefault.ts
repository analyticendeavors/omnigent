// The Effort row's value when a Claude session has no pick: the level Claude
// Code takes from its settings, which the runner records per model in a session
// label (omnigent/runner/ae_launch_effort.py). Read from the sidebar's
// `["conversations"]` cache, so it costs no request.

import { type QueryClient, QueryClientContext } from "@tanstack/react-query";
import { useCallback, useContext, useSyncExternalStore } from "react";
import type { Conversation } from "@/hooks/useConversations";
import { comparableModelId } from "@/lib/codexNativeModels";
import { formatStatusEffortLabel } from "@/lib/composerModelLabel";
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

/** The Effort row's suffix for a Claude session with no pick, else `""`. */
export function aeEffortDefaultSuffix(
  pickerKind: string | null | undefined,
  routingOn: boolean,
  recorded: string | null,
): string {
  if (pickerKind !== "claude" || routingOn) return "";
  const label = formatStatusEffortLabel(recorded);
  return label ? `: ${label} (default)` : ": Claude default";
}
