// A card per pull request the session tracks, at the top of the session's
// GitHub panel: title and link, head branch, CI with counts, mergeability,
// review state, and a Merge button that asks once (method, then Confirm) and
// is disabled with the server's reason when CI is red or running, the branch
// conflicts, or protection blocks it. After a merge the card shows the result
// and offers to set this session to review (`ae.status`, through upstream's
// labels PATCH, the same write the sidebar's Status submenu makes).
//
// Which pull requests: upstream's per-session tracking
// (https://github.com/omnigent-ai/omnigent/pull/6935), the `prs` list the
// panel already reads. What is on a card: omnigent-ae's `/v1/ae/prs` routes
// (lib/aePrs.ts). Reid merges from his phone while travelling, so every
// target is 44 px below the `md` breakpoint. omnigent-ae patch P11,
// 2026-09-24.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, GitMergeIcon, Loader2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AE_MERGEABLE_TEXT,
  AE_METHOD_TEXT,
  AE_PR_NOT_CONFIGURED,
  AE_REVIEW_TEXT,
  aeCiText,
  type AeMergeMethod,
  type AeMergeResult,
  type AePrCard,
  AePrError,
  fetchAePrCard,
  mergeAePr,
  parseAePrUrl,
} from "@/lib/aePrs";
import { cn } from "@/lib/utils";
import { patchAeStatus } from "@/shell/AeStatusMenu";

/** How often an open card re-reads (the server caches GitHub for a minute). */
export const AE_PR_POLL_MS = 30_000;

type Tone = "ok" | "warn" | "err" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  ok: "border-emerald-600/50 text-emerald-700 dark:text-emerald-400",
  warn: "border-amber-600/50 text-amber-700 dark:text-amber-400",
  err: "border-destructive/50 text-destructive",
  muted: "border-border text-muted-foreground",
};

function ciTone(state: AePrCard["ci"]["state"]): Tone {
  if (state === "passing") return "ok";
  if (state === "failing") return "err";
  if (state === "pending") return "warn";
  return "muted";
}

function mergeableTone(state: AePrCard["mergeable"]["state"]): Tone {
  if (state === "clean" || state === "merged") return "ok";
  if (state === "conflicted") return "err";
  if (state === "draft" || state === "checking" || state === "closed") return "muted";
  return "warn";
}

function reviewTone(state: AePrCard["review"]["state"]): Tone {
  if (state === "approved") return "ok";
  if (state === "changes_requested") return "err";
  if (state === "review_required") return "warn";
  return "muted";
}

function Chip({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span
      className={cn(
        "rounded-full border px-2 text-xs leading-5 font-medium whitespace-nowrap",
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}

const TOUCH = "h-11 md:h-8";

function MergedNote({ result, sessionId }: { result: AeMergeResult; sessionId?: string }) {
  const queryClient = useQueryClient();
  const review = useMutation({
    mutationFn: () => patchAeStatus(sessionId!, "review"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversations"] }),
  });
  const how = result.method === "squash" ? "squashed" : "merge commit";
  return (
    <div role="status" className="flex flex-col gap-2 text-ui">
      <p className="text-emerald-700 dark:text-emerald-400">
        Merged #{result.number} ({how}){result.sha ? `, ${result.sha.slice(0, 7)}` : ""}.{" "}
        {result.message}
      </p>
      {sessionId &&
        result.session?.offer_review &&
        (review.isSuccess ? (
          <p className="text-muted-foreground">This session is in review.</p>
        ) : (
          <div className="flex flex-col gap-1">
            <Button
              className={cn(TOUCH, "self-start")}
              disabled={review.isPending}
              onClick={() => review.mutate()}
              data-testid="ae-pr-set-review"
            >
              Set this session to review
            </Button>
            {review.isError && (
              <p role="alert" className="text-destructive">
                {review.error.message}
              </p>
            )}
          </div>
        ))}
    </div>
  );
}

function ConfirmMerge({
  card,
  sessionId,
  onCancel,
  onMerged,
}: {
  card: AePrCard;
  sessionId?: string;
  onCancel: () => void;
  onMerged: (result: AeMergeResult) => void;
}) {
  const queryClient = useQueryClient();
  const methods = card.merge.methods;
  const [method, setMethod] = useState<AeMergeMethod>(card.merge.default_method ?? methods[0]);
  const merge = useMutation({
    mutationFn: () => mergeAePr(card, method, sessionId),
    onSuccess: (result) => {
      onMerged(result);
      void queryClient.invalidateQueries({ queryKey: ["ae-pr", card.repo, card.number] });
    },
    onError: (error) => {
      // A refused merge (gate shut, head moved) carries the fresh card.
      if (error instanceof AePrError && error.card) {
        queryClient.setQueryData(["ae-pr", card.repo, card.number], error.card);
      }
    },
  });
  return (
    <div
      role="group"
      aria-label="Confirm merge"
      className="flex flex-col gap-2 rounded-md border border-primary/40 p-2"
    >
      <p className="text-ui font-medium wrap-anywhere">
        {AE_METHOD_TEXT[method]} #{card.number} into{" "}
        <span className="font-mono">{card.base_ref ?? "the base branch"}</span>?
      </p>
      {methods.length > 1 && (
        <div role="radiogroup" aria-label="Merge method" className="flex flex-wrap gap-2">
          {methods.map((option) => (
            <Button
              key={option}
              role="radio"
              aria-checked={option === method}
              variant={option === method ? "secondary" : "outline"}
              className={TOUCH}
              onClick={() => setMethod(option)}
            >
              {AE_METHOD_TEXT[option]}
            </Button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          className={cn(TOUCH, "flex-1 md:flex-none")}
          disabled={merge.isPending}
          onClick={() => merge.mutate()}
        >
          {merge.isPending && <Loader2Icon className="size-3.5 animate-spin" aria-hidden />}
          Confirm merge
        </Button>
        <Button
          variant="outline"
          className={cn(TOUCH, "flex-1 md:flex-none")}
          disabled={merge.isPending}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
      {merge.isError && (
        <p role="alert" className="text-ui text-destructive">
          Not merged: {merge.error.message}
        </p>
      )}
    </div>
  );
}

/**
 * One pull request's card. `panel` is the GitHub panel's full card; `inline`
 * is the compact one under a chat message, which stays silent on an error or
 * a missing token (the panel already says so).
 */
export function AePrCardView({
  repo,
  number,
  url,
  sessionId,
  first = false,
  variant = "panel",
}: {
  repo: string;
  number: number;
  url: string;
  sessionId?: string;
  first?: boolean;
  variant?: "panel" | "inline";
}) {
  const inline = variant === "inline";
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<AeMergeResult | null>(null);
  const query = useQuery({
    queryKey: ["ae-pr", repo, number],
    queryFn: () => fetchAePrCard(repo, number),
    refetchInterval: AE_PR_POLL_MS,
    retry: false,
  });
  if (inline && (query.isError || query.isPending)) return null;
  if (query.error instanceof AePrError && query.error.code === AE_PR_NOT_CONFIGURED) {
    // Said once for the list, not once per pull request.
    return first ? (
      <p className="text-ui text-muted-foreground" data-testid="ae-pr-off">
        Merge is off: the server has no GitHub token (deploy/README.md, "The GitHub token").
      </p>
    ) : null;
  }
  const card = query.data;
  return (
    <article
      data-testid={inline ? "ae-pr-inline" : "ae-pr-card"}
      data-pr={url}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border border-border bg-background p-2",
        inline && "mt-2 max-w-xl",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 flex-1 items-center gap-1 text-ui font-medium hover:underline"
        >
          <span className="line-clamp-2 wrap-anywhere md:truncate">{card?.title ?? url}</span>
          <span className="shrink-0 text-muted-foreground">#{number}</span>
          <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        </a>
      </div>
      {card?.head_ref && !inline && (
        <span className="truncate font-mono text-xs text-muted-foreground">
          {repo} · {card.head_ref}
          {card.base_ref ? ` → ${card.base_ref}` : ""}
        </span>
      )}
      {query.isPending && (
        <span className="flex items-center gap-1 text-ui text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> Reading GitHub…
        </span>
      )}
      {query.isError && !card && (
        <p role="alert" className="text-ui text-destructive">
          {query.error.message}
        </p>
      )}
      {card && (
        <>
          <div className="flex flex-wrap gap-1.5" data-testid="ae-pr-chips">
            <Chip tone={ciTone(card.ci.state)}>{aeCiText(card.ci)}</Chip>
            <Chip tone={mergeableTone(card.mergeable.state)}>
              {AE_MERGEABLE_TEXT[card.mergeable.state]}
            </Chip>
            <Chip tone={reviewTone(card.review.state)}>{AE_REVIEW_TEXT[card.review.state]}</Chip>
          </div>
          {result ? (
            <MergedNote result={result} sessionId={sessionId} />
          ) : confirming ? (
            <ConfirmMerge
              card={card}
              sessionId={sessionId}
              onCancel={() => setConfirming(false)}
              onMerged={(merged) => {
                setResult(merged);
                setConfirming(false);
              }}
            />
          ) : (
            <>
              {!card.merge.allowed && card.merge.reason && (
                <p className="text-ui text-amber-700 dark:text-amber-400" data-testid="ae-pr-why">
                  {card.merge.reason}
                </p>
              )}
              {card.state === "open" && (
                <Button
                  className={cn(TOUCH, "self-start")}
                  disabled={!card.merge.allowed}
                  title={card.merge.allowed ? `Merge #${number}` : (card.merge.reason ?? undefined)}
                  onClick={() => setConfirming(true)}
                >
                  <GitMergeIcon className="size-3.5" aria-hidden />
                  Merge
                </Button>
              )}
            </>
          )}
        </>
      )}
    </article>
  );
}

/**
 * The cards for every github.com pull request in `prs` (the panel's tracked
 * list), newest first as upstream orders them; nothing when there are none.
 */
export function AePrCards({
  sessionId,
  prs,
}: {
  sessionId: string;
  prs: readonly { url: string }[] | undefined;
}) {
  const refs = useMemo(() => {
    const seen = new Set<string>();
    const out: { url: string; repo: string; number: number }[] = [];
    for (const pr of prs ?? []) {
      const parsed = parseAePrUrl(pr.url);
      if (!parsed || seen.has(pr.url)) continue;
      seen.add(pr.url);
      out.push({ url: pr.url, ...parsed });
    }
    return out;
  }, [prs]);
  if (refs.length === 0) return null;
  return (
    <section
      aria-label="Pull requests"
      data-testid="ae-pr-cards"
      className="flex max-h-[45%] shrink-0 flex-col gap-2 overflow-y-auto border-b border-border p-2"
    >
      {refs.map((ref, index) => (
        <AePrCardView key={ref.url} sessionId={sessionId} first={index === 0} {...ref} />
      ))}
    </section>
  );
}
