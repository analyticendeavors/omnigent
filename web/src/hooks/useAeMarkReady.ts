// Marks a draft pull request ready for review. The inline card and the action
// dock share it, so either button updates both. omnigent-ae, 2026-10-21.

import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { type AePrCard, AePrError, markAePrReady } from "@/lib/aePrs";

/** `busy` is true while any button marks this pull request ready, so none sends it twice. */
export function useAeMarkReady(card: AePrCard) {
  const queryClient = useQueryClient();
  const queryKey = ["ae-pr", card.repo, card.number] as const;
  const mutationKey = ["ae-pr-ready", card.repo, card.number] as const;
  const busy = useIsMutating({ mutationKey }) > 0;
  const mutation = useMutation({
    mutationKey,
    mutationFn: () => markAePrReady(card),
    onSuccess: async (fresh) => {
      await queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.setQueryData(queryKey, fresh);
    },
    onError: async (error) => {
      if (error instanceof AePrError && error.card) {
        await queryClient.cancelQueries({ queryKey, exact: true });
        queryClient.setQueryData(queryKey, error.card);
      }
    },
  });
  return { ...mutation, busy };
}
