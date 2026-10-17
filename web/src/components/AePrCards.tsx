// A card per pull request the session tracks, at the top of the session's
// GitHub panel: title and link, head branch, CI with counts, mergeability,
// review state, and a Merge button that asks once (method, then Confirm) and
// is disabled with the server's reason when CI is red or running, the branch
// conflicts, or protection blocks it. After a merge the card shows the result
// and offers "Mark session done" (sets `ae.status` to review, through
// upstream's labels PATCH, the same write the sidebar's Status submenu makes),
// only when no other tracked pull request of the session is still open (patch
// P20, 2026-09-25, lib/aeReviewOffer.ts).
//
// Which pull requests: upstream's per-session tracking
// (https://github.com/omnigent-ai/omnigent/pull/6935), the `prs` list the
// panel already reads. What is on a card: omnigent-ae's `/v1/ae/prs` routes
// (lib/aePrs.ts). Reid merges from his phone while travelling, so every
// target was 44 px below the `md` breakpoint (40 px on a touch screen since
// P26). omnigent-ae patch P11, 2026-09-24. In a card under 30rem wide (a
// phone) the method is a segmented control (2026-09-25); the Merge button
// spanned such a card until P26 put it at the end of the status row.
//
// 2026-09-26, from Reid's screenshots of a 1100 px card: the confirm step is one
// row (the method toggle, Confirm merge, Cancel) that wraps to two only when it
// does not fit, and the offer after a merge reads "Mark session done" with a
// "frees a slot" hint; "Set this session to review" did not say what it does.
//
// 2026-09-27 (patch P26), Reid's second note that the cards waste space: at
// 1200 px every piece sat on its own full-width row. The chips, the outcome or
// the reason, and the action now share one status row
// (`data-testid="ae-pr-status-row"`) that wraps only when it does not fit, with
// the action at its right end; the merged line drops GitHub's "Pull Request
// successfully merged" echo; buttons are 32 px with a mouse and 40 px on a
// touch screen, as on the Dashboard; the card's padding and gaps are tighter.
//
// 2026-09-28, Reid: the confirm step says which method to use. The server
// recommends one (a merge commit when the head is a long-lived branch such as
// dev or release/x, else squash; `recommend_merge_method` in omnigent-ae's
// ae_omni_policies.prs); the toggle opens on it, its segment carries the
// reason as its title, and the reason is one muted line in the confirm step.
// The other method stays one tap away.
//
// 2026-10-14, Reid: a calmer card. The header leads with the pull request's
// state (open green, merged purple, as GitHub draws them), gives the title two
// lines and puts the repo and number beside it. A card whose Merge is live
// shows one Ready line; otherwise the chips are quiet (an icon and a word, a
// red tint only for a problem), since outlined chips read as buttons. The
// confirm step is a section of the card, not a box inside it: "Recommended"
// leads the reason line instead of tagging the toggle, and the button names
// the method and the base ("Squash into main"), the question line's job.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AE_ICON_ALERT_CIRCLE,
  AE_ICON_CHECK,
  AE_ICON_CIRCLE_CHECK,
  AE_ICON_CIRCLE_DASHED,
  AE_ICON_CIRCLE_X,
  AE_ICON_CLOCK,
  AE_ICON_EXTERNAL_LINK,
  AE_ICON_LOADER,
  AE_ICON_MERGE,
  AE_ICON_PR_CLOSED,
  AE_ICON_PR_DRAFT,
  AE_ICON_PR_OPEN,
} from "@/lib/aePrIcons";
import {
  AE_MERGEABLE_TEXT,
  AE_PR_NOT_CONFIGURED,
  AE_REVIEW_TEXT,
  aeCiText,
  aeMergeLabel,
  aeReadyDetail,
  aeReadyToMerge,
  type AeMergeMethod,
  type AeMergeResult,
  type AePrCard,
  AePrError,
  fetchAePrCard,
  mergeAePr,
  markAePrReady,
  parseAePrUrl,
} from "@/lib/aePrs";
import { cn } from "@/lib/utils";
import { aeMoreOpenText, useAeReviewOffer } from "@/lib/aeReviewOffer";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";
import { patchAeStatus } from "@/shell/AeStatusMenu";

/** How often an open card re-reads (the server caches GitHub for a minute). */
export const AE_PR_POLL_MS = 30_000;

/** Each tone has its own icon shape, so color is never the only signal. */
type Tone = "ok" | "wait" | "warn" | "muted" | "err";

const TONE_ICON: Record<Tone, AeTablerIconNode> = {
  ok: AE_ICON_CIRCLE_CHECK,
  wait: AE_ICON_CLOCK,
  warn: AE_ICON_ALERT_CIRCLE,
  muted: AE_ICON_CIRCLE_DASHED,
  err: AE_ICON_CIRCLE_X,
};

const TONE_ICON_CLASS: Record<Tone, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  wait: "text-amber-600 dark:text-amber-400",
  warn: "text-amber-600 dark:text-amber-400",
  muted: "text-muted-foreground",
  err: "text-destructive",
};

function ciTone(state: AePrCard["ci"]["state"]): Tone {
  if (state === "passing") return "ok";
  if (state === "failing") return "err";
  if (state === "pending") return "wait";
  return "muted";
}

function mergeableTone(state: AePrCard["mergeable"]["state"]): Tone {
  if (state === "clean" || state === "merged") return "ok";
  if (state === "conflicted") return "err";
  if (state === "checking") return "wait";
  if (state === "draft" || state === "closed") return "muted";
  return "warn";
}

function reviewTone(state: AePrCard["review"]["state"]): Tone {
  if (state === "approved") return "ok";
  if (state === "changes_requested") return "err";
  if (state === "review_required") return "warn";
  return "muted";
}

/** A quiet status item, an icon and a word; only a problem gets color and a tint. */
function Chip({ tone, title, children }: { tone: Tone; title?: string; children: string }) {
  return (
    <span
      title={title}
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1 text-sm whitespace-nowrap",
        tone === "err"
          ? "rounded-full bg-destructive/10 px-2 font-medium text-destructive"
          : "text-muted-foreground",
      )}
    >
      <AeTablerSvg
        node={TONE_ICON[tone]}
        className={cn("size-3.5 shrink-0", TONE_ICON_CLASS[tone])}
      />
      {children}
    </span>
  );
}

/** GitHub's merged purple, the one upstream's GitHub panel gives its Merged badge. */
const MERGED_TEXT = "text-purple-700 dark:text-purple-400";

/** `unknown`: no card read yet (loading, or the read failed), so no state is claimed. */
type PrState = "open" | "draft" | "merged" | "closed" | "unknown";

const STATE_ICON: Record<PrState, { node: AeTablerIconNode; tone: string; label: string }> = {
  open: {
    node: AE_ICON_PR_OPEN,
    tone: "text-emerald-600 dark:text-emerald-400",
    label: "Open pull request",
  },
  draft: { node: AE_ICON_PR_DRAFT, tone: "text-muted-foreground", label: "Draft pull request" },
  merged: { node: AE_ICON_MERGE, tone: MERGED_TEXT, label: "Merged pull request" },
  closed: { node: AE_ICON_PR_CLOSED, tone: "text-destructive", label: "Closed pull request" },
  unknown: { node: AE_ICON_PR_OPEN, tone: "text-muted-foreground", label: "Pull request" },
};

function prState(card: AePrCard | undefined, mergedHere: boolean): PrState {
  if (mergedHere || card?.state === "merged") return "merged";
  if (!card) return "unknown";
  if (card.state === "closed") return "closed";
  return card.draft ? "draft" : "open";
}

/** 32 px with a mouse, 40 px on a touch screen (the Dashboard's .btn, 2026-09-27). */
const TOUCH = "h-8 pointer-coarse:h-10";

/**
 * A status row item that stays beside the chips when it fits and takes a row
 * of its own when it does not (flex 1 1 auto, so it never squeezes to nothing).
 */
const ROW_PART = "flex min-w-0 flex-auto flex-wrap items-center gap-x-2 gap-y-1";

/** The method toggle's short labels; the confirm button names the method in full. */
const METHOD_SHORT: Record<AeMergeMethod, string> = { squash: "Squash", merge: "Merge commit" };

/** What the offer after a merge does, for its tooltip and the hint beside it. */
const DONE_TITLE = "Set this session's status to Review (done), which frees one of your slots";

/** The all-clear status: one line in place of three green chips. */
function ReadyLine({ card }: { card: AePrCard }) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-sm" data-testid="ae-pr-ready">
      <AeTablerSvg
        node={AE_ICON_CIRCLE_CHECK}
        className={cn("size-3.5 shrink-0", TONE_ICON_CLASS.ok)}
      />
      <span className="font-medium text-foreground">Ready to merge</span>
      {aeReadyDetail(card).map((part) => (
        <span key={part} className="text-muted-foreground">
          <span aria-hidden="true">· </span>
          {part}
        </span>
      ))}
    </p>
  );
}

function Chips({ card }: { card: AePrCard }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="ae-pr-chips">
      <Chip tone={ciTone(card.ci.state)}>{aeCiText(card.ci)}</Chip>
      <Chip tone={mergeableTone(card.mergeable.state)} title={card.mergeable.detail}>
        {AE_MERGEABLE_TEXT[card.mergeable.state]}
      </Chip>
      <Chip tone={reviewTone(card.review.state)}>{AE_REVIEW_TEXT[card.review.state]}</Chip>
    </div>
  );
}

function MergedNote({
  result,
  sessionId,
  tracked,
}: {
  result: AeMergeResult;
  sessionId?: string;
  tracked?: readonly { url: string }[];
}) {
  const queryClient = useQueryClient();
  const hintId = useId();
  const offer = useAeReviewOffer(sessionId, result, tracked);
  const review = useMutation({
    mutationFn: () => patchAeStatus(sessionId!, "review"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversations"] }),
  });
  const how = result.method === "squash" ? "squashed" : "merge commit";
  // GitHub's own message ("Pull Request successfully merged") only repeats
  // this line, so it is not shown (2026-09-27).
  return (
    <div role="status" className={cn(ROW_PART, "text-sm")}>
      <span className={cn("font-medium", MERGED_TEXT)} data-testid="ae-pr-merged">
        Merged ({how})
        {result.sha && (
          <>
            {" "}
            <span className="font-mono">{result.sha.slice(0, 7)}</span>
          </>
        )}
      </span>
      {offer.kind === "open" && (
        <span className="text-muted-foreground" data-testid="ae-pr-more-open">
          {aeMoreOpenText(offer.count)}.
        </span>
      )}
      {sessionId &&
        result.session?.offer_review &&
        offer.kind === "offer" &&
        (review.isSuccess ? (
          <span className="text-muted-foreground">Session marked done. Its slot is free.</span>
        ) : (
          <>
            {/* Optional, so an outline button, with the hint on screen for touch. */}
            <span className="ml-auto flex items-center gap-x-2">
              <Button
                variant="outline"
                className={TOUCH}
                disabled={review.isPending}
                onClick={() => review.mutate()}
                title={DONE_TITLE}
                aria-describedby={hintId}
                data-testid="ae-pr-set-review"
              >
                Mark session done
              </Button>
              <span id={hintId} className="text-sm text-muted-foreground">
                frees a slot
              </span>
            </span>
            {review.isError && (
              <p role="alert" className="basis-full text-destructive">
                {review.error.message}
              </p>
            )}
          </>
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
  const { recommended_method: recommended, recommended_reason: why } = card.merge;
  const [method, setMethod] = useState<AeMergeMethod>(
    recommended && methods.includes(recommended)
      ? recommended
      : (card.merge.default_method ?? methods[0]),
  );
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
  const label = aeMergeLabel(method, card.base_ref);
  const choice = methods.length > 1 && Boolean(recommended && methods.includes(recommended));
  return (
    <div
      role="group"
      aria-label="Confirm merge"
      className="flex flex-col gap-2 border-t border-border pt-2"
    >
      {why && (
        <p
          className="text-sm text-muted-foreground wrap-anywhere"
          data-testid="ae-pr-recommended-why"
        >
          {/* With one method there is nothing to recommend, only the reason. */}
          {choice && (
            <>
              <span className="font-medium text-foreground">Recommended</span>
              {" · "}
            </>
          )}
          {why}
        </p>
      )}
      {/* One row: the toggle on the left, Cancel and the confirm button at the
          right end. Under 30rem the toggle takes its own row and the two
          buttons share the next (2026-09-26). */}
      <div className="flex flex-wrap items-center gap-2" data-testid="ae-pr-confirm-row">
        {methods.length > 1 && (
          // A segmented control, not buttons: one track, the chosen method filled
          // and ticked, so it cannot be mistaken for Confirm or Cancel.
          <div
            role="radiogroup"
            aria-label="Merge method"
            className="flex basis-full gap-0.5 rounded-lg border border-border bg-muted p-0.5 @[30rem]/aepr:basis-auto"
          >
            {methods.map((option) => {
              const checked = option === method;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  disabled={merge.isPending}
                  className={cn(
                    "inline-flex h-11 min-w-0 flex-auto cursor-pointer items-center justify-center gap-1 rounded-md px-1.5 text-ui whitespace-nowrap @[30rem]/aepr:px-2.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50 md:h-[1.625rem]",
                    checked
                      ? "bg-background font-semibold text-foreground shadow-sm ring-1 ring-foreground/20 dark:bg-foreground/20"
                      : "font-medium text-muted-foreground hover:text-foreground",
                  )}
                  title={option === recommended && why ? why : undefined}
                  onClick={() => setMethod(option)}
                >
                  {/* Unticked: gone on a phone, a blank on wider cards (steady width). */}
                  <AeTablerSvg
                    node={AE_ICON_CHECK}
                    className={cn(
                      "size-3.5 shrink-0",
                      !checked && "hidden @[30rem]/aepr:invisible @[30rem]/aepr:block",
                    )}
                  />
                  <span className="truncate">{METHOD_SHORT[option]}</span>
                </button>
              );
            })}
          </div>
        )}
        {/* Cancel stays compact; the confirm button takes the rest of a narrow
            row, since its label carries the branch name. */}
        <div className="flex min-w-0 flex-1 justify-end gap-2">
          <Button
            variant="outline"
            className={cn(TOUCH, "flex-none")}
            disabled={merge.isPending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            className={cn(TOUCH, "min-w-0 flex-1 @[30rem]/aepr:flex-none")}
            disabled={merge.isPending}
            title={label}
            onClick={() => merge.mutate()}
          >
            {merge.isPending && (
              <AeTablerSvg node={AE_ICON_LOADER} className="size-3.5 animate-spin" />
            )}
            <span className="truncate">{label}</span>
          </Button>
        </div>
      </div>
      {merge.isError && (
        <p role="alert" className="text-sm text-destructive">
          Not merged: {merge.error.message}
        </p>
      )}
    </div>
  );
}

function ReviewDetails({ card }: { card: AePrCard }) {
  const queryClient = useQueryClient();
  const queryKey = ["ae-pr", card.repo, card.number] as const;
  const ready = useMutation({
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
  return (
    <details className="min-w-0 text-sm" data-testid="ae-pr-review-details">
      <summary className="cursor-pointer py-1">Review details</summary>
      <div className="flex min-w-0 flex-col gap-2 py-2">
        <p className="text-muted-foreground">
          {card.head_ref} → {card.base_ref}
          {card.changed_files !== undefined && ` · ${card.changed_files} files`}
          {card.additions !== undefined && ` · +${card.additions}`}
          {card.deletions !== undefined && ` · −${card.deletions}`}
        </p>
        <p className="max-h-72 overflow-y-auto whitespace-pre-wrap wrap-anywhere">
          {card.body || "No description provided."}
        </p>
        <p className="text-muted-foreground">
          {aeCiText(card.ci)} · {AE_REVIEW_TEXT[card.review.state]}
        </p>
        {card.state === "open" && card.draft && (
          <>
            <p className="text-muted-foreground">
              Marking ready opens this change for review. It does not merge it.
            </p>
            <Button
              className={cn(TOUCH, "self-start")}
              disabled={ready.isPending || !card.head_sha}
              onClick={() => ready.mutate()}
            >
              {ready.isPending ? "Marking ready…" : "Mark ready for review"}
            </Button>
          </>
        )}
        {ready.isError && (
          <p role="alert" className="text-destructive">
            {ready.error.message}
          </p>
        )}
      </div>
    </details>
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
  tracked,
  first = false,
  variant = "panel",
}: {
  repo: string;
  number: number;
  url: string;
  sessionId?: string;
  /** The session's tracked pull requests, when the caller holds the list. */
  tracked?: readonly { url: string }[];
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
  const shown = prState(card, result !== null);
  const state = STATE_ICON[shown];
  // The panel's card names its branches too, on the repo's line: a line of
  // their own made a narrow panel card five rows tall.
  const branch =
    !inline && card?.head_ref
      ? `${card.head_ref}${card.base_ref ? ` → ${card.base_ref}` : ""}`
      : null;
  return (
    <article
      data-testid={inline ? "ae-pr-inline" : "ae-pr-card"}
      data-pr={url}
      className={cn(
        "@container/aepr flex flex-col gap-1.5 rounded-lg border border-border bg-background px-3 py-2",
        // A set width, not max-w only: the container ignores its content, so
        // the chat's w-fit bubble would shrink the card to the message text.
        inline && "mt-2 w-xl max-w-full",
      )}
    >
      {/* One link for the whole header: the state, the title on up to two
          lines, then the repo and number, beside the title on a wide inline
          card and under it otherwise. */}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={cn(
          "group grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 text-ui",
          inline && "@[30rem]/aepr:grid-cols-[auto_minmax(0,1fr)_auto]",
        )}
      >
        <span
          className="flex h-[1lh] items-center"
          title={state.label}
          data-testid="ae-pr-state"
          data-pr-state={shown}
        >
          <AeTablerSvg node={state.node} className={cn("size-4 shrink-0", state.tone)} />
          <span className="sr-only">{state.label}</span>
        </span>
        <span className="line-clamp-2 font-medium wrap-anywhere group-hover:underline">
          {card?.title ?? url}
        </span>
        <span
          className={cn(
            "col-start-2 flex min-w-0 items-center",
            inline &&
              "@[30rem]/aepr:col-start-3 @[30rem]/aepr:row-start-1 @[30rem]/aepr:h-[1lh] @[30rem]/aepr:pl-2",
          )}
          title={repo}
          data-testid="ae-pr-meta"
        >
          <span className="flex min-w-0 items-center gap-1 text-sm whitespace-nowrap text-muted-foreground">
            <span className="shrink-0">
              {repo.split("/").pop()} #{number}
            </span>
            {branch && (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate font-mono">{branch}</span>
              </>
            )}
            <AeTablerSvg node={AE_ICON_EXTERNAL_LINK} className="size-3 shrink-0" />
          </span>
        </span>
      </a>
      {/* Everything under the header lines up with the title, not the icon. */}
      <div className="flex min-w-0 flex-col gap-1.5 pl-6">
        {query.isPending && (
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            <AeTablerSvg node={AE_ICON_LOADER} className="size-3.5 animate-spin" /> Reading GitHub…
          </span>
        )}
        {query.isError && !card && (
          <p role="alert" className="text-sm text-destructive">
            {query.error.message}
          </p>
        )}
        {card && (
          <>
            <div
              className="flex flex-wrap items-center gap-x-2 gap-y-1"
              data-testid="ae-pr-status-row"
            >
              {result ? (
                <MergedNote result={result} sessionId={sessionId} tracked={tracked} />
              ) : card.state === "merged" ? (
                <p className={cn("text-sm font-medium", MERGED_TEXT)} data-testid="ae-pr-merged">
                  Merged
                </p>
              ) : card.state === "closed" ? (
                <p className="text-sm text-muted-foreground" data-testid="ae-pr-closed">
                  Closed without merging
                </p>
              ) : (
                <>
                  {aeReadyToMerge(card) ? <ReadyLine card={card} /> : <Chips card={card} />}
                  {!confirming && (
                    <div className={ROW_PART}>
                      {!card.merge.allowed && card.merge.reason && (
                        <p
                          className="text-sm text-amber-700 dark:text-amber-400"
                          data-testid="ae-pr-why"
                        >
                          {card.merge.reason}
                        </p>
                      )}
                      <Button
                        className={cn(TOUCH, "ml-auto")}
                        disabled={!card.merge.allowed}
                        title={
                          card.merge.allowed ? `Merge #${number}` : (card.merge.reason ?? undefined)
                        }
                        onClick={() => setConfirming(true)}
                      >
                        <AeTablerSvg node={AE_ICON_MERGE} className="size-3.5" />
                        Merge
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
            <ReviewDetails card={card} />
            {!result && confirming && (
              <ConfirmMerge
                card={card}
                sessionId={sessionId}
                onCancel={() => setConfirming(false)}
                onMerged={(merged) => {
                  setResult(merged);
                  setConfirming(false);
                }}
              />
            )}
          </>
        )}
      </div>
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
        <AePrCardView
          key={ref.url}
          sessionId={sessionId}
          tracked={prs}
          first={index === 0}
          {...ref}
        />
      ))}
    </section>
  );
}
