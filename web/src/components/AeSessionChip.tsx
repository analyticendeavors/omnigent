// The session header's slots chip (omnigent-ae, 2026-09-24): the session's
// own `ae.status` icon and the slot count, "n/3", red at the limit; a tap
// opens the Dashboard. Reid asked for the slot count on every session and on
// the phone, where the sidebar (and its "Dashboard n/3" row) is a closed
// drawer, so the header was the only place a session could show it.
//
// Both numbers come from the `["conversations"]` query cache the sidebar
// already keeps warm (the row for this session, and the same count the
// sidebar row reads), so the chip costs no request. A session the cache does
// not hold shows the count alone.

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { Conversation } from "@/hooks/useConversations";
import { AE_PARKING_LOT_PATH, AE_SLOT_LIMIT, aeDisplayStatus, type AeStatus } from "@/lib/aeLabels";
import { Link } from "@/lib/routing";
import type { ConversationsInfiniteData } from "@/lib/sessionListCache";
import { cn } from "@/lib/utils";
import { AE_STATUS_ICONS, AE_STATUS_WORDS } from "./AeStatusIcon";
import { useAeSlotCount } from "./AeSlotsPill";

/** This session's displayed status from any cached `["conversations", ...]` list. */
export function readAeSessionStatus(queryClient: QueryClient, id: string): AeStatus | null {
  for (const [, data] of queryClient.getQueriesData<ConversationsInfiniteData>({
    queryKey: ["conversations"],
  })) {
    for (const page of data?.pages ?? []) {
      const row = page.data.find((conversation: Conversation) => conversation.id === id);
      if (row) return aeDisplayStatus(row);
    }
  }
  return null;
}

function useAeSessionStatus(id: string): AeStatus | null {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const read = useCallback(() => readAeSessionStatus(queryClient, id), [queryClient, id]);
  return useSyncExternalStore(subscribe, read, read);
}

export function AeSessionChip({ conversationId }: { conversationId: string }) {
  const status = useAeSessionStatus(conversationId);
  const count = useAeSlotCount();
  const full = count >= AE_SLOT_LIMIT;
  const Icon = status ? AE_STATUS_ICONS[status] : null;
  // The link's label carries the status word, so the icon is decorative (no
  // AeStatusIcon tooltip nested inside a link).
  const label = `${status ? `${AE_STATUS_WORDS[status]}; ` : ""}slots ${count} of ${AE_SLOT_LIMIT}; open the Dashboard`;
  return (
    <Link
      to={AE_PARKING_LOT_PATH}
      componentId="chat.header.ae-session-chip"
      data-testid="ae-session-chip"
      data-full={full ? "true" : "false"}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full border px-2 text-xs tabular-nums max-md:h-11 max-md:border-0 max-md:px-3",
        full
          ? "border-destructive/40 font-semibold text-destructive"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {Icon && <Icon aria-hidden="true" className="size-3.5 max-md:size-4" />}
      <span>
        {count}/{AE_SLOT_LIMIT}
      </span>
    </Link>
  );
}
