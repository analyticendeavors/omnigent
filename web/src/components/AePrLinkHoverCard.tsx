// A small preview of a pull request when the pointer rests on a chat link to
// it: the state (open, draft, merged, closed), the repo and number, the title,
// who opened it, the size of the change and, while it is open, its checks.
// Reid, 2026-10-20: when a session reports finished work he wants a glance at
// each pull request before opening it. The data is the merge card's
// (`/v1/ae/prs`, lib/aePrs.ts) and shares its query cache, so a link whose
// card is already on screen opens with no fetch; the fetch starts only when a
// preview opens. Touch screens have no hover, so a tap still just follows the
// link.

import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  AE_ICON_MERGE,
  AE_ICON_PR_CLOSED,
  AE_ICON_PR_DRAFT,
  AE_ICON_PR_OPEN,
} from "@/lib/aePrIcons";
import {
  AE_PR_NOT_CONFIGURED,
  type AePrCard,
  AePrError,
  aeCiText,
  fetchAePrCard,
  parseAePrUrl,
} from "@/lib/aePrs";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import { cn } from "@/lib/utils";

// The merge card's colors (AePrCards.tsx), kept here so chat markdown does not import the card.
const STATES = {
  open: { node: AE_ICON_PR_OPEN, tone: "text-emerald-600 dark:text-emerald-400", word: "Open" },
  draft: { node: AE_ICON_PR_DRAFT, tone: "text-muted-foreground", word: "Draft" },
  merged: { node: AE_ICON_MERGE, tone: "text-purple-700 dark:text-purple-400", word: "Merged" },
  closed: { node: AE_ICON_PR_CLOSED, tone: "text-destructive", word: "Closed" },
  unknown: { node: AE_ICON_PR_OPEN, tone: "text-muted-foreground", word: "Pull request" },
};

function stateOf(card: AePrCard | undefined): keyof typeof STATES {
  if (card?.state === "open" && card.draft) return "draft";
  return card && card.state in STATES ? card.state : "unknown";
}

function failureText(error: unknown): string {
  if (!(error instanceof AePrError))
    return "No preview: GitHub did not answer. The link still opens it.";
  if (error.code === AE_PR_NOT_CONFIGURED) return "No preview: the server has no GitHub token.";
  if (error.status === 404)
    return "No preview: GitHub has no such pull request, or the token cannot see it.";
  if (error.status === 401 || error.status === 403)
    return "No preview: GitHub refused the server's token.";
  return "No preview: GitHub did not answer. The link still opens it.";
}

/** The link's pull request; a query or fragment (a comment anchor) is ignored. */
function pullRequestOf(href: string | undefined) {
  if (!href) return null;
  try {
    const url = new URL(href);
    return parseAePrUrl(`${url.origin}${url.pathname}`);
  } catch {
    return null;
  }
}

function AePrPreview({ repo, number }: { repo: string; number: number }) {
  const query = useQuery({
    queryKey: ["ae-pr", repo, number] as const,
    queryFn: () => fetchAePrCard(repo, number),
    // The merge card's poll interval (AE_PR_POLL_MS): its link's hover refetches nothing.
    staleTime: 30_000,
    retry: false,
  });
  const card = query.data;
  const shown = stateOf(card);
  const state = STATES[shown];
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="ae-pr-hover" data-pr-state={shown}>
      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-medium",
            state.tone,
          )}
        >
          <AeTablerSvg node={state.node} className="size-3.5" />
          {state.word}
        </span>
        <span className="min-w-0 truncate" title={repo}>
          {repo}
        </span>
        <span className="shrink-0">#{number}</span>
      </div>
      {card ? (
        <>
          <p className="line-clamp-2 font-medium wrap-anywhere">{card.title}</p>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
            {card.author && <span className="truncate">by {card.author}</span>}
            {card.additions !== undefined && card.deletions !== undefined && (
              <span className="font-mono">
                <span className="text-emerald-600 dark:text-emerald-400">+{card.additions}</span>{" "}
                <span className="text-destructive">−{card.deletions}</span>
              </span>
            )}
            {card.changed_files !== undefined && (
              <span>
                {card.changed_files} {card.changed_files === 1 ? "file" : "files"}
              </span>
            )}
            {card.state === "open" && <span>{aeCiText(card.ci)}</span>}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="ae-pr-hover-status">
          {query.isPending ? "Loading…" : failureText(query.error)}
        </p>
      )}
    </div>
  );
}

/** Wraps a chat link to a GitHub pull request; any other link passes through. */
export function AePrLinkHoverCard({
  href,
  side,
  children,
}: {
  href: string | undefined;
  /** Where the preview opens; the action dock passes "top" to keep the composer clear. */
  side?: "top" | "bottom";
  children: ReactElement;
}) {
  const ref = pullRequestOf(href);
  if (!ref) return children;
  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent align="start" side={side} className="w-80">
        <AePrPreview repo={ref.repo} number={ref.number} />
      </HoverCardContent>
    </HoverCard>
  );
}
