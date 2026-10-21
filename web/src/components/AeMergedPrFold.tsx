// The merged and closed pull requests under one assistant message, folded into
// a single row: "3 merged #167 #161 #169". Opening it lists one titled line per
// pull request, and opening a line shows that pull request's full card (Review
// details, AE compliance review). Open and draft pull requests never fold; they
// keep the full card with Merge, the recommended method and the method choice.
//
// 2026-10-20, Reid: a finished session ended on three large Merged cards that
// repeated the TLDR's links and needed nothing from him (about 550 px).
// Later that day: each number in the row is a link with the chat's pull
// request preview on hover, and each opened line has a caret.

import { useState } from "react";
import { AePrCardView, MERGED_TEXT } from "@/components/AePrCards";
import { AePrDeployStatus } from "@/components/AePrDeployStatus";
import { AePrLinkHoverCard } from "@/components/AePrLinkHoverCard";
import { AE_ICON_CHEVRON_RIGHT } from "@/lib/aeAgentsIcons";
import { AE_ICON_EXTERNAL_LINK, AE_ICON_MERGE, AE_ICON_PR_CLOSED } from "@/lib/aePrIcons";
import type { AePrCard } from "@/lib/aePrs";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import { cn } from "@/lib/utils";

export interface AeFoldedPr {
  url: string;
  repo: string;
  number: number;
  card: AePrCard;
}

/** "3 merged", "2 merged, 1 closed", "1 closed". */
export function aeFoldLabel(prs: readonly AeFoldedPr[]): string {
  const merged = prs.filter((pr) => pr.card.state === "merged").length;
  const closed = prs.length - merged;
  const parts = [];
  if (merged) parts.push(`${merged} merged`);
  if (closed) parts.push(`${closed} closed`);
  return parts.join(", ");
}

/** "#167", or "omnigent-ae #167" when the fold spans more than one repo. */
function foldRef(pr: AeFoldedPr, multiRepo: boolean): string {
  return multiRepo ? `${pr.repo.split("/").pop()} #${pr.number}` : `#${pr.number}`;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <AeTablerSvg
      node={AE_ICON_CHEVRON_RIGHT}
      className={cn(
        "size-4 shrink-0 text-muted-foreground transition-transform",
        open && "rotate-90",
      )}
    />
  );
}

function FoldedLine({
  pr,
  multiRepo,
  sessionId,
  tracked,
}: {
  pr: AeFoldedPr;
  multiRepo: boolean;
  sessionId?: string;
  tracked?: readonly { url: string }[];
}) {
  const [open, setOpen] = useState(false);
  const merged = pr.card.state === "merged";
  return (
    <li data-testid="ae-pr-fold-line" data-pr={pr.url}>
      <div className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Chevron open={open} />
          <AeTablerSvg
            node={merged ? AE_ICON_MERGE : AE_ICON_PR_CLOSED}
            className={cn("size-3.5 shrink-0", merged ? MERGED_TEXT : "text-destructive")}
          />
          <span className="min-w-0 flex-1 truncate">{pr.card.title}</span>
          <span className="shrink-0 text-muted-foreground">{foldRef(pr, multiRepo)}</span>
        </button>
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          title={`Open ${pr.repo} #${pr.number} on GitHub`}
        >
          <AeTablerSvg node={AE_ICON_EXTERNAL_LINK} className="size-3.5" />
          <span className="sr-only">Open on GitHub</span>
        </a>
      </div>
      {open && (
        <div className="px-3 pb-2">
          <AePrCardView
            url={pr.url}
            repo={pr.repo}
            number={pr.number}
            sessionId={sessionId}
            tracked={tracked}
            variant="inline"
          />
        </div>
      )}
    </li>
  );
}

export function AeMergedPrFold({
  prs,
  sessionId,
  tracked,
}: {
  prs: readonly AeFoldedPr[];
  sessionId?: string;
  tracked?: readonly { url: string }[];
}) {
  const [open, setOpen] = useState(false);
  if (prs.length === 0) return null;
  const multiRepo = new Set(prs.map((pr) => pr.repo)).size > 1;
  const anyMerged = prs.some((pr) => pr.card.state === "merged");
  return (
    <div
      data-testid="ae-pr-fold"
      className="mt-2 w-full rounded-lg border border-border bg-background"
    >
      {/* The toggle's ::after covers the row, so a click anywhere but a number
          opens the fold; the numbers sit above it as links of their own. */}
      <div className="relative flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-muted/50">
        <button
          type="button"
          className="flex shrink-0 items-center gap-2 text-left after:absolute after:inset-0 after:rounded-lg"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          data-testid="ae-pr-fold-toggle"
        >
          <Chevron open={open} />
          <AeTablerSvg
            node={anyMerged ? AE_ICON_MERGE : AE_ICON_PR_CLOSED}
            className={cn("size-4 shrink-0", anyMerged ? MERGED_TEXT : "text-destructive")}
          />
          <span className="font-medium">{aeFoldLabel(prs)}</span>
        </button>
        <span className="relative flex min-w-0 flex-wrap gap-1.5">
          {prs.map((pr) => (
            <AePrLinkHoverCard key={pr.url} href={pr.url}>
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                data-testid="ae-pr-fold-chip"
                className="rounded border border-border px-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={(event) => event.stopPropagation()}
              >
                {foldRef(pr, multiRepo)}
              </a>
            </AePrLinkHoverCard>
          ))}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <AePrDeployStatus prs={prs} />
          {!multiRepo && (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {prs[0].repo.split("/").pop()}
            </span>
          )}
        </span>
      </div>
      {open && (
        <ul className="border-t border-border py-1">
          {prs.map((pr) => (
            <FoldedLine
              key={pr.url}
              pr={pr}
              multiRepo={multiRepo}
              sessionId={sessionId}
              tracked={tracked}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
