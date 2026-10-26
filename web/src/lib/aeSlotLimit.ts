// The slot limit the server enforces (omnigent-ae, 2026-09-24): `limit` from
// `GET /v1/ae/capacity`, the server's effective limit (since 2026-10-22 the
// lowest enabled slot cap policy's `limit` on Settings > Global Policies, else
// `AE_SLOT_LIMIT` from omnigent-ae's `config/server.env`). Every count in the
// UI (the sidebar's Dashboard row, the session chip, the Status submenu) reads
// it from here. `AE_SLOT_LIMIT` in `aeLabels` is only the
// fallback until the answer arrives, or when the route cannot answer.

import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { AE_SLOT_LIMIT } from "@/lib/aeLabels";
import { authenticatedFetch } from "@/lib/identity";

export const AE_SLOT_LIMIT_QUERY_KEY = ["ae", "slot-limit"] as const;
export const AE_HELPERS_COUNT_QUERY_KEY = ["ae", "helpers-count"] as const;

/**
 * A policy save can move the limit at any time: this tab asks again at once
 * (refreshAeSlotLimit); another tab or device within a minute.
 */
const STALE_MS = 60_000;

/** A whole number of one or more, else `null`. */
export function parseAeSlotLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/** The two settings one `GET /v1/ae/capacity` answer carries, from one policy snapshot. */
export interface AeSlotRules {
  limit: number;
  helpersCount: boolean;
}

let inFlightRules: Promise<AeSlotRules> | null = null;

/**
 * `limit` and `helpers_count` from one `GET /v1/ae/capacity`; throws when the route
 * cannot answer. Callers asking at the same moment share the one request, so the
 * two never come from different policy snapshots.
 */
export function fetchAeSlotRules(): Promise<AeSlotRules> {
  if (inFlightRules) return inFlightRules;
  const request = (async () => {
    const res = await authenticatedFetch("/v1/ae/capacity", { method: "GET" });
    if (!res.ok) throw new Error(`GET /v1/ae/capacity answered ${res.status}`);
    const answer = (await res.json()) as { limit?: unknown; helpers_count?: unknown };
    const limit = parseAeSlotLimit(answer.limit);
    if (limit === null) throw new Error("GET /v1/ae/capacity carried no slot limit");
    return { limit, helpersCount: answer.helpers_count === true };
  })();
  inFlightRules = request;
  const clear = () => {
    if (inFlightRules === request) inFlightRules = null;
  };
  request.then(clear, clear);
  return request;
}

/** `limit` from `GET /v1/ae/capacity`; throws when the route cannot answer. */
export async function fetchAeSlotLimit(): Promise<number> {
  return (await fetchAeSlotRules()).limit;
}

/** Keep a limit another capacity answer carried, so every count repaints with it. */
export function rememberAeSlotLimit(queryClient: QueryClient, value: unknown): number | null {
  const limit = parseAeSlotLimit(value);
  if (limit !== null) queryClient.setQueryData(AE_SLOT_LIMIT_QUERY_KEY, limit);
  return limit;
}

/**
 * Ask for the limit again now: a global policy save may have changed the slot
 * cap's `limit`, and the counts would otherwise wait out the five minutes.
 */
export function refreshAeSlotLimit(queryClient: QueryClient): Promise<void> {
  // A request already in flight began before the save and would hand back the
  // pre-save limit and helpers setting; drop it so the refetch asks again.
  inFlightRules = null;
  void queryClient.invalidateQueries({ queryKey: AE_HELPERS_COUNT_QUERY_KEY });
  return queryClient.invalidateQueries({ queryKey: AE_SLOT_LIMIT_QUERY_KEY });
}

/** `helpers_count` from `GET /v1/ae/capacity`: whether working helpers hold slots. */
export async function fetchAeHelpersCount(): Promise<boolean> {
  return (await fetchAeSlotRules()).helpersCount;
}

/** Keep the setting another capacity answer carried. */
export function rememberAeHelpersCount(queryClient: QueryClient, value: unknown): boolean {
  const on = value === true;
  queryClient.setQueryData(AE_HELPERS_COUNT_QUERY_KEY, on);
  return on;
}

/** The last "helpers count" answer, or off. */
export function readAeHelpersCount(queryClient: QueryClient): boolean {
  return queryClient.getQueryData<boolean>(AE_HELPERS_COUNT_QUERY_KEY) ?? false;
}

/** Whether helper sessions count toward the limit (Settings, default off). */
export function useAeHelpersCount(): boolean {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: AE_HELPERS_COUNT_QUERY_KEY,
    queryFn: async () => {
      // Both settings come from the one answer, so the pill never mixes two snapshots.
      const rules = await fetchAeSlotRules();
      queryClient.setQueryData(AE_SLOT_LIMIT_QUERY_KEY, rules.limit);
      return rules.helpersCount;
    },
    staleTime: STALE_MS,
    retry: false,
  });
  return data ?? false;
}

/** The last limit the server gave, or the fallback. */
export function readAeSlotLimit(queryClient: QueryClient): number {
  return queryClient.getQueryData<number>(AE_SLOT_LIMIT_QUERY_KEY) ?? AE_SLOT_LIMIT;
}

/** The server's slot limit for a count; the fallback until it answers or when it fails. */
export function useAeSlotLimit(): number {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: AE_SLOT_LIMIT_QUERY_KEY,
    queryFn: async () => {
      const rules = await fetchAeSlotRules();
      queryClient.setQueryData(AE_HELPERS_COUNT_QUERY_KEY, rules.helpersCount);
      return rules.limit;
    },
    staleTime: STALE_MS,
    retry: false,
  });
  return data ?? AE_SLOT_LIMIT;
}
