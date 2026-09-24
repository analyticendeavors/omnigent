// The "Dashboard n/3" row in the sidebar's primary navigation (the "Slots
// n/3" pill until 2026-09-24, when omnigent-ae merged its Parking Lot and Your
// move pages into one Dashboard and this row became the one nav entry for it,
// docs/design/dashboard-review.md in omnigent-ae): how many sessions
// hold a slot (`ae.status=working`, top-level, not archived), read from the
// `["conversations"]` query cache the sidebar already keeps warm, so it costs
// no request and repaints with every list delta. Red at the limit. Links to
// the Parking Lot page (an extension, Phase 3 of omnigent-ae; the route is
// fixed so the link ships before the page).
//
// The count follows the rows the browser has loaded. The server's slot cap
// (`ae_omni_policies.slot_cap`, and `GET /v1/ae/capacity`) is the authority;
// this pill is the glanceable copy of it.

import { LayoutDashboardIcon } from "lucide-react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, useCallback, useEffect, useSyncExternalStore } from "react";
import {
  AE_DASHBOARD_PREFIX,
  AE_PARKING_LOT_PATH,
  AE_SLOT_LIMIT,
  countAeSlots,
} from "@/lib/aeLabels";
import { syncAeAppBadge } from "@/lib/aeAppBadge";
import { useLocation } from "@/lib/routing";
import type { ConversationsInfiniteData } from "@/lib/sessionListCache";
import { cn } from "@/lib/utils";
import { PrimaryNavLink } from "@/shell/PrimaryNavLink";

/** Slots held across every cached `["conversations", ...]` list, deduped by id. */
export function readAeSlotCount(queryClient: QueryClient): number {
  const rows = queryClient
    .getQueriesData<ConversationsInfiniteData>({ queryKey: ["conversations"] })
    .flatMap(([, data]) => data?.pages.flatMap((page) => page.data) ?? []);
  return countAeSlots(rows);
}

/** Subscribes to the query cache; the snapshot is a number, so React skips unchanged counts. */
export function useAeSlotCount(): number {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const read = useCallback(() => readAeSlotCount(queryClient), [queryClient]);
  return useSyncExternalStore(subscribe, read, read);
}

export interface AeSlotsPillProps {
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

export function AeSlotsPill({ onNavigate }: AeSlotsPillProps) {
  const count = useAeSlotCount();
  const full = count >= AE_SLOT_LIMIT;
  const { pathname } = useLocation();
  // The sidebar is mounted on every page (open or not), so this row keeps the
  // installed app's icon badge in step with the count.
  useEffect(() => syncAeAppBadge(count), [count]);
  return (
    <PrimaryNavLink
      to={AE_PARKING_LOT_PATH}
      label="Dashboard"
      icon={LayoutDashboardIcon}
      active={pathname.startsWith(AE_DASHBOARD_PREFIX)}
      onClick={onNavigate}
      componentId="sidebar.ae-slots"
      testId="ae-slots-pill"
      trailing={
        // The space keeps the link's accessible name reading "Dashboard n/3";
        // a bare text node in the flex row takes no room.
        <>
          {" "}
          <span
            data-testid="ae-slots-count"
            data-full={full ? "true" : "false"}
            className={cn(
              "ml-auto rounded-full px-1.5 text-xs tabular-nums",
              full ? "bg-destructive/15 font-semibold text-destructive" : "text-muted-foreground",
            )}
          >
            {count}/{AE_SLOT_LIMIT}
          </span>
        </>
      }
    />
  );
}
