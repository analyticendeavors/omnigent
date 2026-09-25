// The slot limit the server enforces (omnigent-ae, 2026-09-24): `limit` from
// `GET /v1/ae/capacity`, which reports `AE_SLOT_LIMIT` from omnigent-ae's
// `config/server.env`. Reid asked for the cap to be one setting, so moving
// from three slots to four is that one line and a container recreate; every
// count in the UI (the sidebar's Dashboard row, the session chip, the Status
// submenu) reads it from here. `AE_SLOT_LIMIT` in `aeLabels` is only the
// fallback until the answer arrives, or when the route cannot answer.

import { type QueryClient, useQuery } from "@tanstack/react-query";
import { AE_SLOT_LIMIT } from "@/lib/aeLabels";
import { authenticatedFetch } from "@/lib/identity";

export const AE_SLOT_LIMIT_QUERY_KEY = ["ae", "slot-limit"] as const;

/** The limit only moves when the server restarts; ask again every five minutes. */
const STALE_MS = 5 * 60_000;

/** A whole number of one or more, else `null`. */
export function parseAeSlotLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/** `limit` from `GET /v1/ae/capacity`; throws when the route cannot answer. */
export async function fetchAeSlotLimit(): Promise<number> {
  const res = await authenticatedFetch("/v1/ae/capacity", { method: "GET" });
  if (!res.ok) throw new Error(`GET /v1/ae/capacity answered ${res.status}`);
  const answer = (await res.json()) as { limit?: unknown };
  const limit = parseAeSlotLimit(answer.limit);
  if (limit === null) throw new Error("GET /v1/ae/capacity carried no slot limit");
  return limit;
}

/** Keep a limit another capacity answer carried, so every count repaints with it. */
export function rememberAeSlotLimit(queryClient: QueryClient, value: unknown): number | null {
  const limit = parseAeSlotLimit(value);
  if (limit !== null) queryClient.setQueryData(AE_SLOT_LIMIT_QUERY_KEY, limit);
  return limit;
}

/** The last limit the server gave, or the fallback. */
export function readAeSlotLimit(queryClient: QueryClient): number {
  return queryClient.getQueryData<number>(AE_SLOT_LIMIT_QUERY_KEY) ?? AE_SLOT_LIMIT;
}

/** The server's slot limit for a count; the fallback until it answers or when it fails. */
export function useAeSlotLimit(): number {
  const { data } = useQuery({
    queryKey: AE_SLOT_LIMIT_QUERY_KEY,
    queryFn: fetchAeSlotLimit,
    staleTime: STALE_MS,
    retry: false,
  });
  return data ?? AE_SLOT_LIMIT;
}
