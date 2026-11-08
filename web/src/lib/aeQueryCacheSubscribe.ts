// A query-cache subscription that wakes only for the keys a hook reads. A bare
// `getQueryCache().subscribe(onChange)` fires for every cache event, and a
// session switch fires hundreds (each fetch adds, updates and re-notifies its
// observers), so each hook re-scanned the cache on events it could not care about.

import { type QueryClient, type QueryKey, partialMatchKey } from "@tanstack/react-query";

/** Calls `onChange` when a query under one of `keys` is added, removed or updated. */
export function subscribeToQueryKeys(
  queryClient: QueryClient,
  keys: readonly QueryKey[],
  onChange: () => void,
): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "added" && event.type !== "removed" && event.type !== "updated") return;
    const queryKey = event.query.queryKey;
    if (keys.some((key) => partialMatchKey(queryKey, key))) onChange();
  });
}
