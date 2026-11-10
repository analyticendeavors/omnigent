// The ids the box's new-model watch saw answer on the plan (omnigent-ae, 2026-11-10):
// `GET /v1/ae/model-watch` feeds the Claude model pickers' known list, so a new model such
// as Fable 5.2 shows up without a release. Mounted once, in the app shell. A failed fetch
// leaves the built-in list in place; the pickers never wait on it.

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { aeSetWatchedModels } from "@/lib/aeClaudeModels";
import { authenticatedFetch } from "@/lib/identity";

export const AE_MODEL_WATCH_QUERY_KEY = ["ae", "model-watch"] as const;
const STALE_MS = 60 * 60 * 1000;

/** The served ids in the route's answer, or null when it is not the expected shape. */
export function aeParseModelWatch(value: unknown): string[] | null {
  const ids = (value as { served_ids?: unknown } | null)?.served_ids;
  if (!Array.isArray(ids)) return null;
  return ids.filter((id): id is string => typeof id === "string");
}

async function fetchServedIds(): Promise<string[]> {
  const res = await authenticatedFetch("/v1/ae/model-watch", { method: "GET" });
  if (!res.ok) throw new Error(`GET /v1/ae/model-watch answered ${res.status}`);
  const ids = aeParseModelWatch(await res.json());
  if (!ids) throw new Error("GET /v1/ae/model-watch answered without served_ids");
  return ids;
}

export function useAeModelWatch(): void {
  const query = useQuery({
    queryKey: AE_MODEL_WATCH_QUERY_KEY,
    queryFn: fetchServedIds,
    staleTime: STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const ids = query.data;
  useEffect(() => {
    if (ids) aeSetWatchedModels(ids);
  }, [ids]);
}
