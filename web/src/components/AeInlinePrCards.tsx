// A PR receipt under an assistant message that names a pull request the
// session tracks: one row with the state, number, title and a status word
// (AePrCardView's "inline" variant), opening in place onto the checks, Update
// branch and the review folds. It never carries Merge: the action dock owns
// every live action, so the thread and the dock never show two Merge buttons
// (2026-10-21). omnigent-ae patch P12, 2026-09-25.
// Merged and closed ones fold into one row under the open cards (2026-10-20,
// AeMergedPrFold.tsx), except one merged from a card on this page.

import { useMutationState, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { AE_PR_POLL_MS, AePrCardView } from "@/components/AePrCards";
import { type AeFoldedPr, AeMergedPrFold } from "@/components/AeMergedPrFold";
import { fetchPullRequestInfo } from "@/hooks/usePullRequests";
import { type AePrCard, aePrUrlsIn, fetchAePrCard, parseAePrUrl } from "@/lib/aePrs";
import { useParams } from "@/lib/routing";

function Cards({ urls, sessionId }: { urls: string[]; sessionId?: string }) {
  // Read the session's tracked list from the panel's and composer's own
  // query; never fetch it from here (one message, one card, no extra calls).
  const info = useQuery({
    queryKey: ["github-info", sessionId],
    queryFn: () => fetchPullRequestInfo(sessionId!),
    enabled: false,
  });
  const tracked = info.data?.prs;
  const shown = useMemo(() => {
    // Only the session's own PRs when the list is known; a PR merely cited
    // (someone else's, upstream's) gets no card.
    if (!tracked) return urls;
    const keep = new Set(tracked.map((pr) => pr.url.toLowerCase()));
    return urls.filter((url) => keep.has(url.toLowerCase()));
  }, [urls, tracked]);
  // The cards' own query (same key), read here to sort finished ones out. The
  // card fetches; this only polls a folded closed PR, which can be reopened.
  const queryClient = useQueryClient();
  const cards = useQueries({
    queries: shown.map((url) => {
      const { repo, number } = parseAePrUrl(url)!;
      const queryKey = ["ae-pr", repo, number] as const;
      return {
        queryKey,
        queryFn: () => fetchAePrCard(repo, number),
        enabled: queryClient.getQueryData<AePrCard>(queryKey)?.state === "closed",
        refetchInterval: AE_PR_POLL_MS,
        retry: false,
      };
    }),
  });
  // A PR merged from a card on this page keeps its card and after-merge note.
  const mergedHere = new Set(
    useMutationState({
      filters: { mutationKey: ["ae-pr-merge"], status: "success" },
      select: (mutation) => (mutation.options.mutationKey ?? []).slice(1).join("#"),
    }),
  );
  const open: string[] = [];
  const folded: AeFoldedPr[] = [];
  shown.forEach((url, i) => {
    const card = cards[i]?.data;
    const { repo, number } = parseAePrUrl(url)!;
    if (card && card.state !== "open" && !mergedHere.has(`${repo}#${number}`)) {
      folded.push({ url, repo, number, card });
    } else {
      open.push(url);
    }
  });
  if (shown.length === 0) return null;
  return (
    <div data-testid="ae-inline-prs" className="flex flex-col">
      {open.map((url) => {
        const parsed = parseAePrUrl(url)!;
        return (
          <AePrCardView
            key={url}
            url={url}
            repo={parsed.repo}
            number={parsed.number}
            sessionId={sessionId}
            tracked={tracked}
            variant="inline"
          />
        );
      })}
      <AeMergedPrFold prs={folded} sessionId={sessionId} tracked={tracked} />
    </div>
  );
}

/** Nothing unless `text` holds a github.com pull request URL. */
export function AeInlinePrCards({ text }: { text: string }) {
  const { conversationId } = useParams<{ conversationId: string }>();
  const urls = useMemo(() => aePrUrlsIn(text), [text]);
  if (urls.length === 0) return null;
  return <Cards urls={urls} sessionId={conversationId} />;
}
