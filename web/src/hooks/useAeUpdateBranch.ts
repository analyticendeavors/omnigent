// Update branch from the action dock and the PR card (AePrCards.tsx): one
// mutation and its cache entries, so a click in either place shows as
// "Updating" in both; the card, or the dock's own query, polls the new head.
// omnigent-ae, 2026-10-22.

import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  AE_BRANCH_UPDATE_MS,
  type AeBranchUpdate,
  aeBranchUpdatePending,
} from "@/lib/aeActionDock";
import { type AePrCard, AePrError, updateAePrBranch } from "@/lib/aePrs";

/**
 * The Update branch call for one pull request, which the card can hold before
 * its own query has answered: it takes the card at `mutate`.
 */
export function useAeUpdateBranchMutation(repo: string, number: number) {
  const queryClient = useQueryClient();
  const queryKey = ["ae-pr", repo, number] as const;
  const updateKey = ["ae-pr-branch-update", repo, number] as const;
  return useMutation({
    mutationKey: updateKey,
    mutationFn: (card: AePrCard) => updateAePrBranch(card),
    onSuccess: async (result) => {
      queryClient.setQueryData(updateKey, { sha: result.head_sha, started: Date.now() });
      await queryClient.cancelQueries({ queryKey, exact: true });
      await queryClient.invalidateQueries({ queryKey, exact: true });
      await queryClient.invalidateQueries({ queryKey: ["ae-pr-compliance", repo, number] });
    },
    onError: async (error) => {
      if (error instanceof AePrError && error.card) {
        await queryClient.cancelQueries({ queryKey, exact: true });
        queryClient.setQueryData(queryKey, error.card);
      }
    },
  });
}

/** `waiting` is true from the click until the head moves, or a minute passes. */
export function useAeUpdateBranch(card: AePrCard) {
  const updateKey = ["ae-pr-branch-update", card.repo, card.number] as const;
  const busy = useIsMutating({ mutationKey: updateKey }) > 0;
  const { data: accepted } = useQuery<AeBranchUpdate>({
    queryKey: updateKey,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    staleTime: Infinity,
  });
  const mutation = useAeUpdateBranchMutation(card.repo, card.number);
  const pending = aeBranchUpdatePending(accepted, card.head_sha, Date.now());
  // Nothing else re-renders when the window lapses on an unmoved head; this frees the button.
  const [, setLapsed] = useState(0);
  useEffect(() => {
    if (!pending || !accepted) return;
    const timer = window.setTimeout(
      () => setLapsed((n) => n + 1),
      accepted.started + AE_BRANCH_UPDATE_MS - Date.now() + 50,
    );
    return () => window.clearTimeout(timer);
  }, [pending, accepted]);
  // `mutate` is bound to this card and keeps its options; the spread keeps the
  // result a union, so `isError` still narrows `error`.
  return {
    ...mutation,
    mutate: (options?: Parameters<typeof mutation.mutate>[1]) => mutation.mutate(card, options),
    busy,
    waiting: busy || pending,
  };
}
