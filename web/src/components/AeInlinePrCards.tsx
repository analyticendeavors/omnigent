// A compact PR card under an assistant message that names a pull request the
// session tracks: colored CI, conflicts and review chips and the same Merge as
// the GitHub panel's card, so a PR the agent just opened can be merged where
// it was announced. omnigent-ae patch P12, 2026-09-25.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { AePrCardView } from "@/components/AePrCards";
import { fetchGithubInfo } from "@/hooks/useGithub";
import { aePrUrlsIn, parseAePrUrl } from "@/lib/aePrs";
import { useParams } from "@/lib/routing";

function Cards({ urls, sessionId }: { urls: string[]; sessionId?: string }) {
  // Read the session's tracked list from the panel's and composer's own
  // query; never fetch it from here (one message, one card, no extra calls).
  const info = useQuery({
    queryKey: ["github-info", sessionId],
    queryFn: () => fetchGithubInfo(sessionId!),
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
  if (shown.length === 0) return null;
  return (
    <div data-testid="ae-inline-prs" className="flex flex-col">
      {shown.map((url) => {
        const parsed = parseAePrUrl(url)!;
        return (
          <AePrCardView
            key={url}
            url={url}
            repo={parsed.repo}
            number={parsed.number}
            sessionId={sessionId}
            variant="inline"
          />
        );
      })}
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
