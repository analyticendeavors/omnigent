// The Effort row's value when a Claude session has no pick. At each launch the
// runner labels the session with the level Claude Code takes from its settings
// (omnigent/runner/ae_launch_effort.py), "none" when no file names one. The
// menu shows that level with "(default)" and checks it, or "Claude default"
// when there is none, so the effort is visible before a change (Reid,
// 2026-10-20). The label comes from the `["conversations"]` cache the sidebar
// keeps warm, as the session chip's status does, so it costs no request.

import { type QueryClient, QueryClientContext } from "@tanstack/react-query";
import { useCallback, useContext, useSyncExternalStore } from "react";
import type { Conversation } from "@/hooks/useConversations";
import { formatStatusEffortLabel } from "@/lib/composerModelLabel";
import type { ConversationsInfiniteData } from "@/lib/sessionListCache";

export const AE_EFFORT_DEFAULT_LABEL = "ae.claude_effort_default";
const NO_LEVEL = "none";

/** The recorded default level of a cached session, e.g. `"high"`; null when none. */
export function readAeEffortDefault(queryClient: QueryClient, id: string): string | null {
  for (const [, data] of queryClient.getQueriesData<ConversationsInfiniteData>({
    queryKey: ["conversations"],
  })) {
    for (const page of data?.pages ?? []) {
      const row = page.data.find((conversation: Conversation) => conversation.id === id);
      if (row) {
        const level = row.labels?.[AE_EFFORT_DEFAULT_LABEL];
        return level && level !== NO_LEVEL ? level : null;
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
